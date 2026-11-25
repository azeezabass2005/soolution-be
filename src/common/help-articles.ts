/**
 * What the support assistant knows: short answers about how Solution Pay
 * works. Each has the words people use for it (`keywords`, single words or
 * short phrases); the assistant picks the best matches for a question and
 * hands off to a person when nothing fits. Keep answers true to the app.
 */
export interface HelpArticle {
    id: string;
    title: string;
    answer: string;
    keywords: string[];
    /** Where in the app to go next */
    link?: { label: string; href: string };
}

export const HELP_ARTICLES: HelpArticle[] = [
    {
        id: "fund-wallet",
        title: "Adding money to your wallet",
        answer: "Verify your identity (BVN) to get your own NGN account number, then send a bank transfer to it from any Nigerian bank. It lands in your NGN wallet, usually within minutes. You'll find the account number under Wallet → Add money; any fee is shown there.",
        keywords: ["fund", "add money", "deposit", "top up wallet", "account number", "bank transfer", "credit wallet", "load", "dedicated account", "dva"],
        link: { label: "Add money", href: "/dashboard/user/wallet" },
    },
    {
        id: "send-money",
        title: "Sending money abroad",
        answer: "Tap Send, pick the country, choose or add who you're paying (mobile money or bank), enter the amount, pick a reason, and confirm with your PIN. The rate and fee are shown before you confirm, and instant sends usually arrive in minutes.",
        keywords: ["send", "pay", "transfer", "pay supplier", "send money", "payout", "recipient", "beneficiary"],
        link: { label: "Send money", href: "/dashboard/user" },
    },
    {
        id: "receive-money",
        title: "Getting paid by someone abroad",
        answer: "Tap Receive and pick the payer's currency. Share a payment link (they pay by mobile money or bank, no account needed), or top up yourself if you're the one paying. The money arrives as naira in your NGN wallet once it's confirmed.",
        keywords: ["receive", "get paid", "collect", "customer pay", "incoming", "collection", "payer"],
        link: { label: "Receive money", href: "/dashboard/user" },
    },
    {
        id: "payment-link",
        title: "Payment links",
        answer: "A payment link is a page you share with a payer. They open it, enter their mobile money or bank details and approve; they don't need an account. You can set an amount or let them choose, make it single-use, and turn it off or delete it any time.",
        keywords: ["payment link", "link", "share link", "pay link", "invoice", "request payment"],
        link: { label: "Receive money", href: "/dashboard/user" },
    },
    {
        id: "top-up",
        title: "Topping up yourself",
        answer: "Top up when you're paying in from your own mobile money or bank account abroad: choose Receive, pick the currency, then Top up yourself. You'll see the rate and what arrives in naira before you pay.",
        keywords: ["top up", "topup", "pay myself", "my own momo", "pay in"],
        link: { label: "Receive money", href: "/dashboard/user" },
    },
    {
        id: "rates-fees",
        title: "Rates and fees",
        answer: "Every send and receive shows the exchange rate and any fee before you confirm, so you always know what arrives. You can check today's rates any time on the Exchange rates page.",
        keywords: ["rate", "rates", "exchange rate", "fee", "fees", "charge", "cost", "price", "how much"],
        link: { label: "Exchange rates", href: "/dashboard/user/exchange-rate" },
    },
    {
        id: "how-long",
        title: "How long payments take",
        answer: "Instant payments usually arrive in minutes; the form says when to expect it once you pick mobile money or bank. Manual payments are paid by our team during manual payment hours, usually within a couple of hours.",
        keywords: ["how long", "time", "when", "arrive", "delay", "slow", "taking long", "minutes", "processing"],
    },
    {
        id: "failed-refund",
        title: "A payment failed or was cancelled",
        answer: "If a payment fails or is rejected, any money taken from your wallet goes back to it automatically, and we tell you why. You can see the reason by opening it in Transaction history.",
        keywords: ["failed", "fail", "declined", "rejected", "cancelled", "refund", "reversed", "money back", "not successful", "deducted"],
        link: { label: "Transaction history", href: "/dashboard/user/transactions" },
    },
    {
        id: "pending",
        title: "A payment is still in progress",
        answer: "Most finish within minutes. Bank payments in some countries can take until the same or next day; the payment shows when to expect it. If it's been much longer than that, open it in Transaction history and raise a dispute, or talk to us.",
        keywords: ["pending", "in progress", "processing", "stuck", "not received", "hasn't arrived", "still waiting", "where is my money"],
        link: { label: "Transaction history", href: "/dashboard/user/transactions" },
    },
    {
        id: "dispute",
        title: "Raising a dispute",
        answer: "Open the transaction in Transaction history and tap \"Something wrong? Raise a dispute\". Tell us what happened; our team investigates and replies in Support, and you'll see the outcome when it's closed.",
        keywords: ["dispute", "complain", "complaint", "wrong amount", "wrong recipient", "problem with payment", "fraud", "scam", "report"],
        link: { label: "Transaction history", href: "/dashboard/user/transactions" },
    },
    {
        id: "verification",
        title: "Verification, tiers and limits",
        answer: "Verify your BVN to start sending and receiving (Tier 1). Each tier has a daily limit; to raise yours, upgrade under Profile → Tier & verification and submit what it asks for. We review applications and let you know.",
        keywords: ["verify", "verification", "bvn", "nin", "kyc", "kyb", "tier", "limit", "daily limit", "upgrade", "identity", "documents"],
        link: { label: "Tier & verification", href: "/dashboard/user/profile" },
    },
    {
        id: "pin",
        title: "Your transaction PIN",
        answer: "Your 4-digit PIN confirms every send and withdrawal. Set or change it under Profile → Security settings, where you can also reset it if you've forgotten it.",
        keywords: ["pin", "transaction pin", "forgot pin", "reset pin", "change pin", "wrong pin", "pin locked"],
        link: { label: "Security settings", href: "/dashboard/user/profile" },
    },
    {
        id: "password",
        title: "Password and signing in",
        answer: "Signing in takes your password and a code we email you each time. Change your password under Profile → Security settings; if you've forgotten it, use \"Forgot password\" on the sign-in page.",
        keywords: ["password", "forgot password", "reset password", "sign in", "login", "log in", "code", "otp", "can't login", "email code"],
        link: { label: "Security settings", href: "/dashboard/user/profile" },
    },
    {
        id: "withdraw",
        title: "Withdrawing to your bank",
        answer: "Go to Wallet → Withdraw, choose your Nigerian bank account (we check the account name), enter the amount and confirm with your PIN. The fee is shown first, and it usually arrives within minutes.",
        keywords: ["withdraw", "withdrawal", "cash out", "to my bank", "payout to bank", "move money out"],
        link: { label: "Wallet", href: "/dashboard/user/wallet" },
    },
    {
        id: "countries",
        title: "Countries and currencies",
        answer: "We cover Nigeria, Ghana, Kenya, South Africa, Tanzania, Uganda, Rwanda, the CFA franc countries (Cameroon, Gabon, Senegal, Côte d'Ivoire, Benin, Togo and more), Botswana, Zambia, Malawi, DR Congo and China. Exactly what's open for sending or receiving in each, and by mobile money or bank, shows when you pick the currency.",
        keywords: ["country", "countries", "currency", "currencies", "supported", "kenya", "ghana", "china", "south africa", "cameroon", "uganda"],
        link: { label: "Exchange rates", href: "/dashboard/user/exchange-rate" },
    },
    {
        id: "china",
        title: "Paying China (RMB)",
        answer: "Choose Send → RMB, add the recipient's Alipay or WeChat details, and enter the amount. The naira is taken from your NGN wallet at our RMB rate and our team pays it out manually; we tell you when it's done.",
        keywords: ["china", "rmb", "yuan", "cny", "alipay", "wechat", "chinese supplier"],
    },
    {
        id: "review",
        title: "A large payment under review",
        answer: "Payments above a set amount are reviewed by our team before they go out. The money is held from your wallet in the meantime; once it's approved it's sent, and if it's not approved the money comes straight back.",
        keywords: ["review", "approval", "under review", "held", "large payment", "big amount", "waiting for approval"],
    },
    {
        id: "account-hold",
        title: "My account is on hold",
        answer: "If your account or balance is on hold, some payments are paused while we check something. Talk to a person here and we'll explain what's needed.",
        keywords: ["frozen", "freeze", "suspended", "on hold", "blocked", "restricted", "can't send"],
    },
];

/** Words that say nothing about the topic */
export const STOP_WORDS = new Set("a an the i me my we our you your it its is are was were be been am do does did how what why when where who which can could would should will to of in on for from with and or but not no yes please hi hello hey there this that these those have has had get got just so if as at by about any some".split(" "));

/** Words people use for the same thing */
export const SYNONYMS: Record<string, string> = {
    deposit: "fund", deposited: "fund", funding: "fund", funded: "fund", topup: "top up",
    momo: "mobile money", mpesa: "mobile money", "m-pesa": "mobile money",
    paid: "pay", paying: "pay", payment: "pay", payments: "pay",
    sent: "send", sending: "send", received: "receive", receiving: "receive",
    withdrew: "withdraw", withdrawing: "withdraw",
    refunded: "refund", failing: "failed", fails: "failed",
    signin: "sign in", logging: "login", loggin: "login",
};
