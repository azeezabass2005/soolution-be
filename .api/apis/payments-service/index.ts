import type * as types from './types';
import type { ConfigOptions, FetchResponse } from 'api/dist/core'
import Oas from 'oas';
import APICore from 'api/dist/core';
import definition from './openapi.json';

class SDK {
  spec: Oas;
  core: APICore;

  constructor() {
    this.spec = Oas.init(definition);
    this.core = new APICore(this.spec, 'payments-service/1.0.23 (api/6.1.3)');
  }

  /**
   * Optionally configure various options that the SDK allows.
   *
   * @param config Object of supported SDK options and toggles.
   * @param config.timeout Override the default `fetch` request timeout of 30 seconds. This number
   * should be represented in milliseconds.
   */
  config(config: ConfigOptions) {
    this.core.setConfig(config);
  }

  /**
   * If the API you're using requires authentication you can supply the required credentials
   * through this method and the library will magically determine how they should be used
   * within your API request.
   *
   * With the exception of OpenID and MutualTLS, it supports all forms of authentication
   * supported by the OpenAPI specification.
   *
   * @example <caption>HTTP Basic auth</caption>
   * sdk.auth('username', 'password');
   *
   * @example <caption>Bearer tokens (HTTP or OAuth 2)</caption>
   * sdk.auth('myBearerToken');
   *
   * @example <caption>API Keys</caption>
   * sdk.auth('myApiKey');
   *
   * @see {@link https://spec.openapis.org/oas/v3.0.3#fixed-fields-22}
   * @see {@link https://spec.openapis.org/oas/v3.1.0#fixed-fields-22}
   * @param values Your auth credentials for the API; can specify up to two strings or numbers.
   */
  auth(...values: string[] | number[]) {
    this.core.setAuth(...values);
    return this;
  }

  /**
   * If the API you're using offers alternate server URLs, and server variables, you can tell
   * the SDK which one to use with this method. To use it you can supply either one of the
   * server URLs that are contained within the OpenAPI definition (along with any server
   * variables), or you can pass it a fully qualified URL to use (that may or may not exist
   * within the OpenAPI definition).
   *
   * @example <caption>Server URL with server variables</caption>
   * sdk.server('https://{region}.api.example.com/{basePath}', {
   *   name: 'eu',
   *   basePath: 'v14',
   * });
   *
   * @example <caption>Fully qualified server URL</caption>
   * sdk.server('https://eu.api.example.com/v14');
   *
   * @param url Server URL
   * @param variables An object of variables to replace into the server URL.
   */
  server(url: string, variables = {}) {
    this.core.setServer(url, variables);
  }

  /**
   * Retrieve all supported payment ramps (Bank Transfer, Mobile Money, E-Wallets transfers)
   *
   * @summary Get Channels
   * @throws FetchError<400, types.GetChannelsResponse400> 400
   */
  getChannels(metadata?: types.GetChannelsMetadataParam): Promise<FetchResponse<200, types.GetChannelsResponse200>> {
    return this.core.fetch('/channels', 'get', metadata);
  }

  /**
   * Retrieve all supported end financial interfaces (Banks, Mobile Money Networks,
   * E-Wallets)
   *
   * @summary Get Networks
   * @throws FetchError<400, types.GetNetworksResponse400> 400
   */
  getNetworks(metadata?: types.GetNetworksMetadataParam): Promise<FetchResponse<200, types.GetNetworksResponse200>> {
    return this.core.fetch('/networks', 'get', metadata);
  }

  /**
   * Retrieve rates for supported countries
   *
   * @summary Get Rates
   * @throws FetchError<400, types.GetRatesResponse400> 400
   */
  getRates(metadata?: types.GetRatesMetadataParam): Promise<FetchResponse<200, types.GetRatesResponse200>> {
    return this.core.fetch('/rates', 'get', metadata);
  }

  /**
   * Retrieve information about accounts, including available balance.
   *
   * @summary Get Account
   * @throws FetchError<500, types.GetAccountResponse500> 500
   */
  getAccount(): Promise<FetchResponse<200, types.GetAccountResponse200>> {
    return this.core.fetch('/account', 'get');
  }

  /**
   * Validate a bank account before sending.
   *
   * @summary Resolve Bank Account
   * @throws FetchError<400, types.ResolveBankAccountResponse400> 400
   */
  resolveBankAccount(body: types.ResolveBankAccountBodyParam): Promise<FetchResponse<200, types.ResolveBankAccountResponse200>> {
    return this.core.fetch('/details/bank', 'post', body);
  }

  /**
   * Validate a Mobile Money network before sending.
   *
   * @summary Resolve Mobile Money Account
   * @throws FetchError<400, types.ResolveMobileMoneyAccountResponse400> 400
   */
  resolveMobileMoneyAccount(body: types.ResolveMobileMoneyAccountBodyParam): Promise<FetchResponse<200, types.ResolveMobileMoneyAccountResponse200>> {
    return this.core.fetch('/details/momo', 'post', body);
  }

  /**
   * Gets a quote for a widget transaction
   *
   * @summary Widget Quote
   * @throws FetchError<400, types.WidgetQuoteResponse400> 400
   */
  widgetQuote(body?: types.WidgetQuoteBodyParam): Promise<FetchResponse<200, types.WidgetQuoteResponse200>> {
    return this.core.fetch('/widget/quote', 'post', body);
  }

  /**
   * Retrieve supported widget crypto currencies. 
   *
   * Each currency contains an array of supported networks and their status.
   *
   * @summary Get Crypto Channels
   * @throws FetchError<400, types.CryptoChannelsResponse400> 400
   */
  cryptoChannels(): Promise<FetchResponse<200, types.CryptoChannelsResponse200>> {
    return this.core.fetch('/channels/crypto', 'get');
  }

  /**
   * Submit a disbursement payment request. This will lock in a rate and await approval.
   *
   * @summary Submit Payment Request
   * @throws FetchError<400, types.SubmitPaymentResponse400> 400
   */
  submitPayment(body: types.SubmitPaymentBodyParam): Promise<FetchResponse<200, types.SubmitPaymentResponse200>> {
    return this.core.fetch('/payments', 'post', body);
  }

  /**
   * Get a list of payment requests
   *
   * @summary List Payments
   * @throws FetchError<400, types.ListPaymentsResponse400> 400
   * @throws FetchError<500, types.ListPaymentsResponse500> 500
   */
  listPayments(metadata?: types.ListPaymentsMetadataParam): Promise<FetchResponse<200, types.ListPaymentsResponse200>> {
    return this.core.fetch('/payments', 'get', metadata);
  }

  /**
   * Accept a payment request for execution.
   *
   * @summary Accept Payment Request
   * @throws FetchError<400, types.AcceptPaymentRequestResponse400> 400
   */
  acceptPaymentRequest(metadata: types.AcceptPaymentRequestMetadataParam): Promise<FetchResponse<200, types.AcceptPaymentRequestResponse200>> {
    return this.core.fetch('/payments/{id}/accept', 'post', metadata);
  }

  /**
   * Deny a payment request.
   *
   * @summary Deny Payment Request
   * @throws FetchError<400, types.DenyPaymentRequestResponse400> 400
   */
  denyPaymentRequest(metadata: types.DenyPaymentRequestMetadataParam): Promise<FetchResponse<200, types.DenyPaymentRequestResponse200>> {
    return this.core.fetch('/payments/{id}/deny', 'post', metadata);
  }

  /**
   * Retrieve information about a specific payment
   *
   * @summary Lookup Payment
   * @throws FetchError<400, types.LookupPaymentResponse400> 400
   */
  lookupPayment(metadata: types.LookupPaymentMetadataParam): Promise<FetchResponse<200, types.LookupPaymentResponse200>> {
    return this.core.fetch('/payments/{id}', 'get', metadata);
  }

  /**
   * Retrieve information about a specific payment using its sequenceId property
   *
   * @summary Lookup Payment by sequenceId
   * @throws FetchError<400, types.LookupPaymentBySequenceidResponse400> 400
   */
  lookupPaymentBySequenceid(metadata: types.LookupPaymentBySequenceidMetadataParam): Promise<FetchResponse<200, types.LookupPaymentBySequenceidResponse200>> {
    return this.core.fetch('/payments/sequence-id/{id}', 'get', metadata);
  }

  /**
   * Submit a collection payment request. This will lock in a rate and await approval.
   *
   * @summary Submit Collection Request
   * @throws FetchError<400, types.SubmitCollectionRequestResponse400> 400
   * @throws FetchError<500, types.SubmitCollectionRequestResponse500> 500
   */
  submitCollectionRequest(body: types.SubmitCollectionRequestBodyParam): Promise<FetchResponse<200, types.SubmitCollectionRequestResponse200>> {
    return this.core.fetch('/collections', 'post', body);
  }

  /**
   * Get a list of collection requests
   *
   * @summary List Collection
   * @throws FetchError<400, types.ListCollectionsResponse400> 400
   * @throws FetchError<500, types.ListCollectionsResponse500> 500
   */
  listCollections(metadata?: types.ListCollectionsMetadataParam): Promise<FetchResponse<200, types.ListCollectionsResponse200>> {
    return this.core.fetch('/collections', 'get', metadata);
  }

  /**
   * Accept a collection request for execution.
   *
   * @summary Accept Collection Request
   * @throws FetchError<400, types.AcceptCollectionRequestResponse400> 400
   * @throws FetchError<404, types.AcceptCollectionRequestResponse404> 404
   * @throws FetchError<500, types.AcceptCollectionRequestResponse500> 500
   */
  acceptCollectionRequest(metadata: types.AcceptCollectionRequestMetadataParam): Promise<FetchResponse<200, types.AcceptCollectionRequestResponse200>> {
    return this.core.fetch('/collections/{id}/accept', 'post', metadata);
  }

  /**
   * Deny a collection request.
   *
   * @summary Deny Collection Request
   * @throws FetchError<404, types.DenyCollectionRequestResponse404> 404
   * @throws FetchError<500, types.DenyCollectionRequestResponse500> 500
   */
  denyCollectionRequest(metadata: types.DenyCollectionRequestMetadataParam): Promise<FetchResponse<200, types.DenyCollectionRequestResponse200>> {
    return this.core.fetch('/collections/{id}/deny', 'post', metadata);
  }

  /**
   * Cancel collection request while it's pending or processing.
   *
   * @summary Cancel Collection
   * @throws FetchError<400, types.CancelCollectionResponse400> 400
   * @throws FetchError<500, types.CancelCollectionResponse500> 500
   */
  cancelCollection(metadata: types.CancelCollectionMetadataParam): Promise<FetchResponse<200, types.CancelCollectionResponse200>> {
    return this.core.fetch('/collections/{id}/cancel', 'post', metadata);
  }

  /**
   * Refund cash collected from customer
   *
   * @summary Refund collection
   * @throws FetchError<400, types.RefundCollectionResponse400> 400
   * @throws FetchError<500, types.RefundCollectionResponse500> 500
   */
  refundCollection(metadata: types.RefundCollectionMetadataParam): Promise<FetchResponse<200, types.RefundCollectionResponse200>> {
    return this.core.fetch('/collections/{id}/refund', 'post', metadata);
  }

  /**
   * Retrieve information about a specific collection request
   *
   * @summary Lookup Collection
   * @throws FetchError<404, types.LookupCollectionResponse404> 404
   * @throws FetchError<500, types.LookupCollectionResponse500> 500
   */
  lookupCollection(metadata: types.LookupCollectionMetadataParam): Promise<FetchResponse<200, types.LookupCollectionResponse200>> {
    return this.core.fetch('/collections/{id}', 'get', metadata);
  }

  /**
   * Retrieve information about a specific collection request using its sequenceId property
   *
   * @summary Lookup Collection by sequenceId
   * @throws FetchError<404, types.LookupCollectionBySequenceidResponse404> 404
   * @throws FetchError<500, types.LookupCollectionBySequenceidResponse500> 500
   */
  lookupCollectionBySequenceid(metadata: types.LookupCollectionBySequenceidMetadataParam): Promise<FetchResponse<200, types.LookupCollectionBySequenceidResponse200>> {
    return this.core.fetch('/collections/sequence-id/{id}', 'get', metadata);
  }

  /**
   * Create a webhook for a given transaction state, or for all states.
   *
   * @summary Create Webhook
   * @throws FetchError<400, types.CreateWebhookResponse400> 400
   */
  createWebhook(body: types.CreateWebhookBodyParam): Promise<FetchResponse<200, types.CreateWebhookResponse200>> {
    return this.core.fetch('/webhooks', 'post', body);
  }

  /**
   * Update the fields of a given webhook.
   *
   * @summary Update Webhook
   * @throws FetchError<400, types.UpdateWebhookResponse400> 400
   */
  updateWebhook(body: types.UpdateWebhookBodyParam): Promise<FetchResponse<200, types.UpdateWebhookResponse200>> {
    return this.core.fetch('/webhooks', 'put', body);
  }

  /**
   * List all webhooks associated with your account.
   *
   * @summary List Webhooks
   * @throws FetchError<400, types.ListWebhooksResponse400> 400
   */
  listWebhooks(): Promise<FetchResponse<200, types.ListWebhooksResponse200>> {
    return this.core.fetch('/webhooks', 'get');
  }

  /**
   * Retrieve information about a specific collection request using its sequenceId property
   *
   * @summary Lookup Settlement by sequenceId
   * @throws FetchError<404, types.LookupSettlementBySequenceidResponse404> 404
   * @throws FetchError<500, types.LookupSettlementBySequenceidResponse500> 500
   */
  lookupSettlementBySequenceid(metadata: types.LookupSettlementBySequenceidMetadataParam): Promise<FetchResponse<200, types.LookupSettlementBySequenceidResponse200>> {
    return this.core.fetch('/settlements/sequence-id/{id}', 'get', metadata);
  }

  /**
   * Submit a settlement request. Withdraw from your balance to a wallet address. You can set
   * up settlement webhook to receive status update on your settlement.
   *
   * @summary Submit Settlement Request
   * @throws FetchError<400, types.SubmitSettlementRequestResponse400> 400
   * @throws FetchError<500, types.SubmitSettlementRequestResponse500> 500
   */
  submitSettlementRequest(body: types.SubmitSettlementRequestBodyParam): Promise<FetchResponse<200, types.SubmitSettlementRequestResponse200>> {
    return this.core.fetch('/settlement', 'post', body);
  }

  /**
   * Submit a trade request.
   *
   * @summary Submit Trade Request
   */
  trades(body: types.TradesBodyParam): Promise<FetchResponse<200, types.TradesResponse200>> {
    return this.core.fetch('/trade', 'post', body);
  }

  /**
   * Executes a quote
   *
   * @summary Execute Trade Quote
   */
  executeTrade(body: types.ExecuteTradeBodyParam): Promise<FetchResponse<200, types.ExecuteTradeResponse200>> {
    return this.core.fetch('/execute', 'post', body);
  }

  /**
   * @throws FetchError<400, types.GetNewEndpointResponse400> Bad Request
   * @throws FetchError<500, types.GetNewEndpointResponse500> Internal Server Error
   */
  get_newEndpoint(metadata?: types.GetNewEndpointMetadataParam): Promise<FetchResponse<200, types.GetNewEndpointResponse200>> {
    return this.core.fetch('/new-endpoint', 'get', metadata);
  }

  /**
   * Remove a given webhook.
   *
   * @summary Remove Webhook
   * @throws FetchError<400, types.RemoveWebhookResponse400> 400
   */
  removeWebhook(metadata: types.RemoveWebhookMetadataParam): Promise<FetchResponse<200, types.RemoveWebhookResponse200>> {
    return this.core.fetch('/webhooks/{id}', 'delete', metadata);
  }
}

const createSDK = (() => { return new SDK(); })()
;

export default createSDK;

export type { AcceptCollectionRequestMetadataParam, AcceptCollectionRequestResponse200, AcceptCollectionRequestResponse400, AcceptCollectionRequestResponse404, AcceptCollectionRequestResponse500, AcceptPaymentRequestMetadataParam, AcceptPaymentRequestResponse200, AcceptPaymentRequestResponse400, CancelCollectionMetadataParam, CancelCollectionResponse200, CancelCollectionResponse400, CancelCollectionResponse500, CreateWebhookBodyParam, CreateWebhookResponse200, CreateWebhookResponse400, CryptoChannelsResponse200, CryptoChannelsResponse400, DenyCollectionRequestMetadataParam, DenyCollectionRequestResponse200, DenyCollectionRequestResponse404, DenyCollectionRequestResponse500, DenyPaymentRequestMetadataParam, DenyPaymentRequestResponse200, DenyPaymentRequestResponse400, ExecuteTradeBodyParam, ExecuteTradeResponse200, GetAccountResponse200, GetAccountResponse500, GetChannelsMetadataParam, GetChannelsResponse200, GetChannelsResponse400, GetNetworksMetadataParam, GetNetworksResponse200, GetNetworksResponse400, GetNewEndpointMetadataParam, GetNewEndpointResponse200, GetNewEndpointResponse400, GetNewEndpointResponse500, GetRatesMetadataParam, GetRatesResponse200, GetRatesResponse400, ListCollectionsMetadataParam, ListCollectionsResponse200, ListCollectionsResponse400, ListCollectionsResponse500, ListPaymentsMetadataParam, ListPaymentsResponse200, ListPaymentsResponse400, ListPaymentsResponse500, ListWebhooksResponse200, ListWebhooksResponse400, LookupCollectionBySequenceidMetadataParam, LookupCollectionBySequenceidResponse200, LookupCollectionBySequenceidResponse404, LookupCollectionBySequenceidResponse500, LookupCollectionMetadataParam, LookupCollectionResponse200, LookupCollectionResponse404, LookupCollectionResponse500, LookupPaymentBySequenceidMetadataParam, LookupPaymentBySequenceidResponse200, LookupPaymentBySequenceidResponse400, LookupPaymentMetadataParam, LookupPaymentResponse200, LookupPaymentResponse400, LookupSettlementBySequenceidMetadataParam, LookupSettlementBySequenceidResponse200, LookupSettlementBySequenceidResponse404, LookupSettlementBySequenceidResponse500, RefundCollectionMetadataParam, RefundCollectionResponse200, RefundCollectionResponse400, RefundCollectionResponse500, RemoveWebhookMetadataParam, RemoveWebhookResponse200, RemoveWebhookResponse400, ResolveBankAccountBodyParam, ResolveBankAccountResponse200, ResolveBankAccountResponse400, ResolveMobileMoneyAccountBodyParam, ResolveMobileMoneyAccountResponse200, ResolveMobileMoneyAccountResponse400, SubmitCollectionRequestBodyParam, SubmitCollectionRequestResponse200, SubmitCollectionRequestResponse400, SubmitCollectionRequestResponse500, SubmitPaymentBodyParam, SubmitPaymentResponse200, SubmitPaymentResponse400, SubmitSettlementRequestBodyParam, SubmitSettlementRequestResponse200, SubmitSettlementRequestResponse400, SubmitSettlementRequestResponse500, TradesBodyParam, TradesResponse200, UpdateWebhookBodyParam, UpdateWebhookResponse200, UpdateWebhookResponse400, WidgetQuoteBodyParam, WidgetQuoteResponse200, WidgetQuoteResponse400 } from './types';
