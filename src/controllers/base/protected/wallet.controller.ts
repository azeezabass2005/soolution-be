import BaseController from "../base-controller";
import WalletService from "../../../services/wallet.service";
import { Request, Response, NextFunction } from "express";
import { validateSetPin, validateChangePin, validateInitiateWithdrawal, validateResolveAccount } from "../../../validators/z-wallet";
import logger from "../../../utils/logger.utils";
import fxExchangeService from "../../../services/fx-exchange.service";
import { WALLET_CURRENCIES } from "../../../common/wallet.constants";
import platformSettingsService from "../../../services/platform-settings.service";
import errorResponseMessage, { ErrorSeverity } from "../../../common/messages/error-response-message";

class WalletController extends BaseController {
    private walletService: WalletService;

    constructor() {
        super();
        this.walletService = new WalletService();
        this.setupRoutes();
    }

    protected setupRoutes() {
        // Get or create wallet (+ provision DVA on first access)
        this.router.get("/", this.getWallet.bind(this));

        // Quick balance check (NGN wallet)
        this.router.get("/balance", this.getBalance.bind(this));

        // Multi-currency wallets
        this.router.get("/list", this.listWallets.bind(this));
        this.router.get("/currencies", this.listCurrencies.bind(this));
        // What a withdrawal or deposit of `amount` costs, from the admin's pricing
        this.router.get("/fees", this.getFees.bind(this));
        this.router.post("/create", this.createWallet.bind(this));

        // Exchange between wallets: lock a rate, then exchange with the PIN
        this.router.post("/exchange/quote", this.quoteExchange.bind(this));
        this.router.post("/exchange", this.exchange.bind(this));

        // PIN management
        this.router.post("/pin/set", validateSetPin, this.setPin.bind(this));
        this.router.post("/pin/change", validateChangePin, this.changePin.bind(this));

        // Withdrawal
        this.router.post("/withdraw", validateInitiateWithdrawal, this.initiateWithdrawal.bind(this));

        // Bank utilities
        this.router.get("/banks", this.listBanks.bind(this));
        this.router.get("/resolve-account", validateResolveAccount, this.resolveAccount.bind(this));

        // DVA provisioning (explicit retry)
        this.router.post("/provision-dva", this.provisionDVA.bind(this));

        // Verify a transfer status (polling fallback when webhook doesn't arrive)
        this.router.post("/transactions/:transactionId/verify", this.verifyTransaction.bind(this));

        // Transaction history
        this.router.get("/transactions", this.getTransactionHistory.bind(this));
    }

    private async getWallet(req: Request, res: Response, next: NextFunction) {
        try {
            const user = res.locals.user;
            let wallet = await this.walletService.getOrCreateWallet(user.id);

            // Lazy virtual account (Fincra) — non-blocking: if it fails, still return the wallet.
            // dvaSetup tells the app why there's no account number yet.
            let dvaSetup: "ready" | "pending" | "identity_required" | "unavailable" = "ready";
            if (!wallet.isDVAProvisioned) {
                try {
                    wallet = await this.walletService.provisionDVA(wallet.id, user);
                    if (!wallet.isDVAProvisioned) dvaSetup = "pending";
                } catch (dvaError: any) {
                    dvaSetup = dvaError?.details?.code === "IDENTITY_REQUIRED" ? "identity_required" : "unavailable";
                    if (dvaSetup === "unavailable") {
                        logger.warn("Virtual account not ready — returning wallet without it", {
                            walletId: wallet.id,
                            error: dvaError?.message || dvaError,
                        });
                    }
                }
            }

            // What a deposit costs the user in total (Fincra's part plus ours), so the app can say it
            const funding = (await platformSettingsService.getPricing()).funding.NGN;
            const fundingFee = funding.customerFee ?? funding.platformFee;
            // Large receives still being checked can't leave yet: say what can
            const pendingBalance = Number(wallet.heldBalance) || 0;
            const withdrawableBalance = Math.max(0, Math.round(((Number(wallet.balance) || 0) - pendingBalance) * 100) / 100);
            return this.sendSuccess(res, { wallet: { ...wallet, dvaSetup, fundingFee, pendingBalance, withdrawableBalance } });
        } catch (error) {
            return next(error);
        }
    }

    private async listWallets(req: Request, res: Response, next: NextFunction) {
        try {
            const wallets = await this.walletService.listWallets(res.locals.user.id);
            return this.sendSuccess(res, { wallets });
        } catch (error) {
            return next(error);
        }
    }

    private async getFees(req: Request, res: Response, next: NextFunction) {
        try {
            const operation = String(req.query.operation || "");
            const amount = Number(req.query.amount);
            if (operation !== "withdrawal" && operation !== "funding") {
                return next(errorResponseMessage.createError(400, "operation must be withdrawal or funding", ErrorSeverity.LOW));
            }
            if (!isFinite(amount) || amount <= 0) {
                return next(errorResponseMessage.createError(400, "amount must be a positive number", ErrorSeverity.LOW));
            }
            if (operation === "funding") {
                // What a deposit of `amount` costs in total (Fincra's part plus ours) and what lands
                const { pricing, ...fees } = await platformSettingsService.priceFunding(amount);
                const credited = Math.round((amount - fees.customerTotal) * 100) / 100;
                return this.sendSuccess(res, { operation, amount, ...fees, total: fees.customerTotal, fee: fees.customerTotal, credited, rule: pricing.customerFee ?? null });
            }
            const { pricing: _rules, ...fees } = await platformSettingsService.priceFees(operation, amount);
            // Withdrawal: the fee is added on top
            return this.sendSuccess(res, { operation, amount, ...fees, fee: fees.total, charged: Math.round((amount + fees.total) * 100) / 100 });
        } catch (error) {
            return next(error);
        }
    }

    private async listCurrencies(_req: Request, res: Response, next: NextFunction) {
        try {
            return this.sendSuccess(res, { currencies: WALLET_CURRENCIES });
        } catch (error) {
            return next(error);
        }
    }

    private async createWallet(req: Request, res: Response, next: NextFunction) {
        try {
            const wallet = await this.walletService.createWallet(res.locals.user.id, req.body?.currency);
            return this.sendSuccess(res, {
                wallet: { id: wallet.id, currency: wallet.currency, balance: wallet.balance, ledgerBalance: wallet.ledgerBalance, pendingBalance: Number(wallet.heldBalance) || 0, withdrawableBalance: Math.max(0, Math.round(((Number(wallet.balance) || 0) - (Number(wallet.heldBalance) || 0)) * 100) / 100), status: wallet.status, createdAt: wallet.createdAt },
                message: `${wallet.currency} wallet created`,
            }, 201);
        } catch (error) {
            return next(error);
        }
    }

    private async quoteExchange(req: Request, res: Response, next: NextFunction) {
        try {
            const quote = await fxExchangeService.quote(res.locals.user.id, req.body ?? {});
            return this.sendSuccess(res, { quote });
        } catch (error) {
            return next(error);
        }
    }

    private async exchange(req: Request, res: Response, next: NextFunction) {
        try {
            const result = await fxExchangeService.execute(res.locals.user.id, req.body?.quoteId, req.body?.pin);
            return this.sendSuccess(res, { ...result, message: "Exchange complete" });
        } catch (error) {
            return next(error);
        }
    }

    private async getBalance(req: Request, res: Response, next: NextFunction) {
        try {
            const user = res.locals.user;
            const balance = await this.walletService.getWalletBalance(user.id);
            return this.sendSuccess(res, balance);
        } catch (error) {
            return next(error);
        }
    }

    private async setPin(req: Request, res: Response, next: NextFunction) {
        try {
            const user = res.locals.user;
            await this.walletService.setPin(user.id, req.body.pin);
            return this.sendSuccess(res, { message: "PIN set successfully" });
        } catch (error) {
            return next(error);
        }
    }

    private async changePin(req: Request, res: Response, next: NextFunction) {
        try {
            const user = res.locals.user;
            await this.walletService.changePin(user.id, req.body.oldPin, req.body.newPin);
            return this.sendSuccess(res, { message: "PIN changed successfully" });
        } catch (error) {
            return next(error);
        }
    }

    private async initiateWithdrawal(req: Request, res: Response, next: NextFunction) {
        try {
            const user = res.locals.user;
            const { amount, bankCode, accountNumber, accountName, pin } = req.body;

            const transaction = await this.walletService.initiateWithdrawal(
                user.id,
                amount,
                bankCode,
                accountNumber,
                accountName,
                pin
            );

            return this.sendSuccess(res, {
                transaction,
                message: "Withdrawal initiated successfully. You will be notified once it's processed."
            });
        } catch (error) {
            return next(error);
        }
    }

    private async listBanks(req: Request, res: Response, next: NextFunction) {
        try {
            const banks = await this.walletService.listBanks();
            return this.sendSuccess(res, { banks });
        } catch (error) {
            return next(error);
        }
    }

    private async resolveAccount(req: Request, res: Response, next: NextFunction) {
        try {
            const { accountNumber, bankCode } = req.query;
            const account = await this.walletService.resolveAccount(
                accountNumber as string,
                bankCode as string
            );
            return this.sendSuccess(res, { account });
        } catch (error) {
            return next(error);
        }
    }

    private async getTransactionHistory(req: Request, res: Response, next: NextFunction) {
        try {
            const user = res.locals.user;
            const { page, limit, type, currency, view } = req.query;

            const transactions = await this.walletService.getTransactionHistory(user.id, {
                page: parseInt(page as string) || 1,
                limit: parseInt(limit as string) || 10,
                type: type as string | undefined,
                currency: typeof currency === "string" && currency ? currency : undefined,
                // ?view=wallet: only top-ups and withdrawals (the wallet page)
                topUpsAndWithdrawals: view === "wallet",
            });

            return this.sendSuccess(res, transactions);
        } catch (error) {
            return next(error);
        }
    }
    private async verifyTransaction(req: Request, res: Response, next: NextFunction) {
        try {
            const user = res.locals.user;
            const { transactionId } = req.params;
            const result = await this.walletService.verifyAndUpdateTransfer(user.id, transactionId);
            return this.sendSuccess(res, result);
        } catch (error) {
            return next(error);
        }
    }

    private async provisionDVA(req: Request, res: Response, next: NextFunction) {
        try {
            const user = res.locals.user;
            let wallet = await this.walletService.getOrCreateWallet(user.id);

            if (wallet.isDVAProvisioned) {
                return this.sendSuccess(res, { wallet, message: "Account already provisioned" });
            }

            wallet = await this.walletService.provisionDVA(wallet.id, user);
            return this.sendSuccess(res, { wallet, message: "Account set up successfully" });
        } catch (error: any) {
            logger.error("Virtual account provisioning failed", { error: error?.message || error, status: error?.status });
            // Our own errors (e.g. identity not verified) pass through as they are
            if (error?.response_code) return next(error);
            res.status(503).json({
                success: false,
                message: "We couldn't set up your account number right now. Please try again shortly.",
            });
        }
    }
}

export default new WalletController().router;
