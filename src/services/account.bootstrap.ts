import Account, { AccountType } from '../models/account.model';
import {
    ACCOUNT_TYPE,
    SYSTEM_ACCOUNT_CODES,
    YC_CURRENCIES,
    ycCashAccountCode,
    ycPaymentInflightCode,
    ycCollectionInflightCode,
    OG_CURRENCIES,
    ogCashAccountCode,
    ogPaymentInflightCode,
    ogCollectionInflightCode,
} from '../common/constant';
import logger from '../utils/logger.utils';

interface SystemAccountSpec {
    code: string;
    type: AccountType;
    currency: string;
    name: string;
    description: string;
}

/**
 * Build the deterministic list of system accounts the ledger requires. Per-user
 * wallet accounts (USER_WALLET_NGN:{userId}) are NOT bootstrapped here — they
 * are created on demand by WalletService.getOrCreateWallet.
 */
function buildSystemAccountList(): SystemAccountSpec[] {
    const accounts: SystemAccountSpec[] = [
        {
            code: SYSTEM_ACCOUNT_CODES.CASH_PAYSTACK_NGN,
            type: ACCOUNT_TYPE.ASSET,
            currency: 'NGN',
            name: 'Cash at Paystack (NGN)',
            description: 'Money sitting at Paystack (DVA balances and transfer reserves).',
        },
        {
            code: SYSTEM_ACCOUNT_CODES.USER_WALLETS_NGN_TOTAL,
            type: ACCOUNT_TYPE.LIABILITY,
            currency: 'NGN',
            name: 'User wallets — total NGN owed',
            description: 'Aggregate liability we owe end-users in NGN. Equal to sum of USER_WALLET_NGN:* balances.',
        },
        {
            code: SYSTEM_ACCOUNT_CODES.SUSPENSE_NGN,
            type: ACCOUNT_TYPE.LIABILITY,
            currency: 'NGN',
            name: 'Suspense — unmatched NGN',
            description: 'Incoming funds that could not be matched to a user. Cleared by manual attribution.',
        },
        {
            code: SYSTEM_ACCOUNT_CODES.FEES_NGN,
            type: ACCOUNT_TYPE.REVENUE,
            currency: 'NGN',
            name: 'Fees collected (NGN)',
            description: 'Platform fees collected on NGN transactions.',
        },
        {
            code: SYSTEM_ACCOUNT_CODES.PAYSTACK_TRANSFER_INFLIGHT_NGN,
            type: ACCOUNT_TYPE.ASSET,
            currency: 'NGN',
            name: 'Paystack transfers in flight (NGN)',
            description: 'Withdrawals initiated with Paystack but not yet settled to recipient.',
        },
        {
            code: SYSTEM_ACCOUNT_CODES.REVERSAL_CLEARING_NGN,
            type: ACCOUNT_TYPE.LIABILITY,
            currency: 'NGN',
            name: 'Reversal clearing (NGN)',
            description: 'Short-lived account used during reversal flows.',
        },
        {
            code: SYSTEM_ACCOUNT_CODES.YC_FLOAT_NGN,
            type: ACCOUNT_TYPE.ASSET,
            currency: 'NGN',
            name: 'YellowCard float (NGN equivalent)',
            description: 'Aggregate NGN value sitting at YellowCard for outbound payments and pending collections.',
        },
    ];

    // Per-currency YellowCard accounts: cash + payment-in-flight + collection-in-flight.
    for (const currency of YC_CURRENCIES) {
        accounts.push({
            code: ycCashAccountCode(currency),
            type: ACCOUNT_TYPE.ASSET,
            currency,
            name: `Cash at YellowCard (${currency})`,
            description: `${currency} balance held at YellowCard for the corresponding rail.`,
        });
        accounts.push({
            code: ycPaymentInflightCode(currency),
            type: ACCOUNT_TYPE.ASSET,
            currency,
            name: `YellowCard payments in flight (${currency})`,
            description: `Outbound ${currency} payments awaiting webhook confirmation.`,
        });
        accounts.push({
            code: ycCollectionInflightCode(currency),
            type: ACCOUNT_TYPE.ASSET,
            currency,
            name: `YellowCard collections in flight (${currency})`,
            description: `Inbound ${currency} collections awaiting deposit settlement.`,
        });
    }

    // OGateway accounts (Ghana only, for now): cash + payment-in-flight + collection-in-flight.
    for (const currency of OG_CURRENCIES) {
        accounts.push({
            code: ogCashAccountCode(currency),
            type: ACCOUNT_TYPE.ASSET,
            currency,
            name: `Cash at OGateway (${currency})`,
            description: `${currency} balance held at OGateway for the corresponding rail.`,
        });
        accounts.push({
            code: ogPaymentInflightCode(currency),
            type: ACCOUNT_TYPE.ASSET,
            currency,
            name: `OGateway payments in flight (${currency})`,
            description: `Outbound ${currency} payments awaiting OGateway webhook confirmation.`,
        });
        accounts.push({
            code: ogCollectionInflightCode(currency),
            type: ACCOUNT_TYPE.ASSET,
            currency,
            name: `OGateway collections in flight (${currency})`,
            description: `Inbound ${currency} collections awaiting OGateway settlement.`,
        });
    }

    return accounts;
}

/**
 * Idempotent: creates any missing system accounts but never overwrites the
 * balance of an existing account. Safe to call on every boot.
 */
export async function bootstrapSystemAccounts(): Promise<{ created: number; existing: number }> {
    const specs = buildSystemAccountList();
    let created = 0;
    let existing = 0;

    for (const spec of specs) {
        const existingDoc = await Account.findOne({ code: spec.code });
        if (existingDoc) {
            existing += 1;
            continue;
        }
        await Account.create({
            ...spec,
            isSystem: true,
            balance: 0,
        });
        created += 1;
    }

    logger.info('System ledger accounts bootstrapped', {
        created,
        existing,
        total: specs.length,
    });

    return { created, existing };
}
