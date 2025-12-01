import UserService from "./user.service";
import TransactionService from "./transaction.service";
import axios from "axios";
import config from "../config/env.config";
import errorResponseMessage from "../common/messages/error-response-message";
import {FlutterwaveStaticAccount} from "../types/payment.types";

class PaymentService {
    accessToken?: string;
    expiresIn?: number;
    lastTokenRefreshTime?: number;
    userService: UserService;
    transactionService: TransactionService;

    constructor() {
        this.userService = new UserService();
        this.transactionService = new TransactionService();
    }

    private async authenticate ()  {
        const response = await axios.post(
            'https://idp.flutterwave.com/realms/flutterwave/protocol/openid-connect/token',
            new URLSearchParams({
                client_id: config.FLUTTERWAVE_CLIENT_ID,
                client_secret: config.FLUTTERWAVE_CLIENT_SECRET,
                grant_type: 'client_credentials'
            }),
            {
                headers: { 'Content-Type': 'application/x-www-form-urlencoded' }
            }
        );
        if(!response) {
            throw errorResponseMessage.unableToComplete('Failed to initialize payment');
        }
        console.log(response, "This is the response from authenticate")
        const { access_token, expires_in, refresh_expires_in, token_type, scope  } = response.data;
        this.accessToken = access_token;
        this.expiresIn = expires_in;
        this.lastTokenRefreshTime = Date.now();
    }

    /**
     * Ensures that anytime you get the accessToken, it's always valid.
     * @private
     */
    private async getAccessToken(): Promise<string> {
        if (
            !this.accessToken ||
            !this.expiresIn ||
            !this.lastTokenRefreshTime ||
            Date.now() - this.lastTokenRefreshTime >= this.expiresIn * 1000
        ) {
            await this.authenticate();
        }
        return this.accessToken!;
    }

    /**
     * Generates flutterwave static account number
     */
    private async generateStaticAccountNumber(userId: string): Promise<FlutterwaveStaticAccount> {

        // TODO: Generation of static account number.

        return {} as FlutterwaveStaticAccount;
    }

    /**
     * Credits the user
     * @description Debits the user static account(GHS) credits the user NGN bank
     */
    private async creditUserNGNAccount(): Promise<void> {
        // TODO: Crediting the user NGN account number stored using flutterwave
    }

}