import User from "../models/user.model";
import Wallet from "../models/wallet.model";
import WalletService from "./wallet.service";
import { BASE_WALLET_CURRENCY } from "../common/wallet.constants";
import logger from "../utils/logger.utils";

/**
 * Every user has an NGN wallet. Accounts created before wallets were opened at
 * sign-up only got one on their first wallet visit; open the missing ones.
 * Idempotent: a no-op once every user has one.
 */
export async function ensureBaseWallets(): Promise<void> {
    const withWallet = await Wallet.distinct("user", { currency: BASE_WALLET_CURRENCY });
    const missing = await User.find({ _id: { $nin: withWallet } }).select("_id").lean();
    if (!missing.length) return;

    const walletService = new WalletService();
    let opened = 0;
    for (const user of missing) {
        try {
            await walletService.getOrCreateWallet(String(user._id));
            opened += 1;
        } catch (error) {
            logger.error("Failed to open NGN wallet", { userId: user._id, error: error instanceof Error ? error.message : String(error) });
        }
    }
    logger.info("Opened NGN wallets for existing users", { opened, missing: missing.length });
}
