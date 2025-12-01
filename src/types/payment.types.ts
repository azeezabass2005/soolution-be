export interface FlutterwaveStaticAccount {
    id: string;
    amount: number;
    account_number: string;
    reference: string;
    account_bank_name: string;
    account_type: string;
    status: string;
    account_expiration_datetime: string;
    note: string;
    customer_id: string;
    created_datetime: string;
    meta: Record<string, any>;
}
