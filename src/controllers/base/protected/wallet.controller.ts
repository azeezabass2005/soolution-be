import BaseController from "../base-controller";
import WalletService from "../../../services/wallet.service";
import { Request, Response, NextFunction } from "express";
import { validateSetPin, validateChangePin, validateInitiateWithdrawal, validateResolveAccount } from "../../../validators/z-wallet";
import logger from "../../../utils/logger.utils";
import fxExchangeService from "../../../services/fx-exchange.service";
import { WALLET_CURRENCIES } from "../../../common/wallet.constants";

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
            let wallet = await this.walletService.getOrCreateWallet(user._id!);

            // Lazy DVA provisioning — non-blocking: if it fails, still return the wallet
            if (!wallet.isDVAProvisioned) {
                try {
                    wallet = await this.walletService.provisionDVA(wallet._id as string, user);
                } catch (dvaError: any) {
                    logger.error("DVA provisioning failed — returning wallet without DVA", {
                        walletId: wallet._id,
                        error: dvaError?.message || dvaError,
                        response: dvaError?.response?.data,
                    });
                    // wallet is still the un-provisioned version — frontend will show "being set up"
                }
            }

            return this.sendSuccess(res, { wallet });
        } catch (error) {
            return next(error);
        }
    }

    private async listWallets(req: Request, res: Response, next: NextFunction) {
        try {
            const wallets = await this.walletService.listWallets(String(res.locals.user._id));
            return this.sendSuccess(res, { wallets });
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
            const wallet = await this.walletService.createWallet(String(res.locals.user._id), req.body?.currency);
            return this.sendSuccess(res, {
                wallet: { _id: wallet._id, currency: wallet.currency, balance: wallet.balance, ledgerBalance: wallet.ledgerBalance, status: wallet.status, createdAt: (wallet as any).createdAt },
                message: `${wallet.currency} wallet created`,
            }, 201);
        } catch (error) {
            return next(error);
        }
    }

    private async quoteExchange(req: Request, res: Response, next: NextFunction) {
        try {
            const quote = await fxExchangeService.quote(String(res.locals.user._id), req.body ?? {});
            return this.sendSuccess(res, { quote });
        } catch (error) {
            return next(error);
        }
    }

    private async exchange(req: Request, res: Response, next: NextFunction) {
        try {
            const result = await fxExchangeService.execute(String(res.locals.user._id), req.body?.quoteId, req.body?.pin);
            return this.sendSuccess(res, { ...result, message: "Exchange complete" });
        } catch (error) {
            return next(error);
        }
    }

    private async getBalance(req: Request, res: Response, next: NextFunction) {
        try {
            const user = res.locals.user;
            const balance = await this.walletService.getWalletBalance(user._id!);
            return this.sendSuccess(res, balance);
        } catch (error) {
            return next(error);
        }
    }

    private async setPin(req: Request, res: Response, next: NextFunction) {
        try {
            const user = res.locals.user;
            await this.walletService.setPin(user._id!, req.body.pin);
            return this.sendSuccess(res, { message: "PIN set successfully" });
        } catch (error) {
            return next(error);
        }
    }

    private async changePin(req: Request, res: Response, next: NextFunction) {
        try {
            const user = res.locals.user;
            await this.walletService.changePin(user._id!, req.body.oldPin, req.body.newPin);
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
                user._id!,
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
            const { page, limit, type, currency } = req.query;

            const transactions = await this.walletService.getTransactionHistory(user._id!, {
                page: parseInt(page as string) || 1,
                limit: parseInt(limit as string) || 10,
                type: type as string | undefined,
                currency: typeof currency === "string" && currency ? currency : undefined,
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
            const result = await this.walletService.verifyAndUpdateTransfer(user._id!, transactionId);
            return this.sendSuccess(res, result);
        } catch (error) {
            return next(error);
        }
    }

    private async provisionDVA(req: Request, res: Response, next: NextFunction) {
        try {
            const user = res.locals.user;
            let wallet = await this.walletService.getOrCreateWallet(user._id!);

            if (wallet.isDVAProvisioned) {
                return this.sendSuccess(res, { wallet, message: "Account already provisioned" });
            }

            wallet = await this.walletService.provisionDVA(wallet._id as string, user);
            return this.sendSuccess(res, { wallet, message: "Account set up successfully" });
        } catch (error: any) {
            logger.error("DVA provisioning failed", {
                error: error?.message || error,
                response: error?.response?.data,
            });

            // Surface a friendly message for known Paystack errors
            const paystackMsg = error?.response?.data?.message;
            if (paystackMsg?.includes("not available for your business")) {
                res.status(503).json({
                    success: false,
                    message: "Dedicated account feature is not yet enabled on our payment provider. Please contact support.",
                });
                return;
            }

            return next(error);
        }
    }
}

export default new WalletController().router;
