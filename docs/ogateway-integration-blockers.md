# OGateway integration — blockers

Source-of-truth doc for everything that can stop the OGateway GHS integration
from working end-to-end. Status checked against
[OGateway docs](https://docs.ogateway.io/docs/getting-started) as of
**2026-05-19**. Update this file as items get resolved.

## Status legend

- 🔴 **Hard blocker** — integration cannot work in this state.
- 🟡 **Soft blocker** — code ships, behaviour or UX is degraded until resolved.
- 🟢 **Resolved** — addressed in code or by ops.

---

## TODO — things you still need to do

Tick each box as it's resolved. Items grouped by who/where, ordered by what
unblocks the next step.

### Before you can test end-to-end (any environment)

- [ ] Generate `OGATEWAY_WEBHOOK_SECRET` in the OGateway dashboard
      (`https://dash.ogateway.io` → Settings → API Keys → Webhook secret)
      and paste it into `backend/.env` under `OGATEWAY_WEBHOOK_SECRET`.
- [ ] Stand up a public HTTPS URL for the webhook endpoint
      (`ngrok http <port>` or `cloudflared tunnel run`) and set
      `OGATEWAY_CALLBACK_URL=https://<tunnel>/api/v1/public/webhook/ogateway`
      in `backend/.env`.
- [ ] Register the same URL as the webhook destination on the OGateway
      dashboard so events actually get sent there.
- [ ] Confirm there's an active `NGN→GHS` **and** `GHS→NGN` rate on the
      admin Rates page (`/dashboard/admin/exchange`). The locked-rate field
      pulls from your `ExchangeRate` table — OGateway does not quote FX.

### Before going to production (live key)

- [ ] Switch `OGATEWAY_API_KEY` from `test_…` to `live_…` in the production
      env. Note the prefix is the only environment signal — same base URL.
- [ ] Treasury: top up the OGateway Ghana GHS float so outbound payouts can
      settle (covered in detail under blocker #3 below).
- [ ] Update `OGATEWAY_CALLBACK_URL` to the production backend URL and
      re-register the webhook on the OGateway dashboard.

### Follow-ups that can ship after launch

- [ ] Paste the Ghana bank-code list into a static
      `data/ogateway-ghana-banks.ts` and swap the free-text input in
      `UserPaymentPage` for a dropdown (covers blocker #5).
- [ ] Ask OGateway support whether an undocumented account name-enquiry
      endpoint exists; if yes, wire it for MoMo and bank pre-validation
      (covers blocker #4).
- [ ] Confirm OGateway's webhook retry policy + check for a status-lookup
      endpoint; if neither exists, expose the stale-OGateway-transaction
      sweeper threshold via `OGATEWAY_STALE_AFTER_MINUTES` and surface
      flagged transactions on the admin webhooks page
      (covers blocker #6).
- [ ] If OGateway publishes a webhook source-IP allowlist, add it at the
      WAF / load balancer layer (covers blocker #7).

---

## Hard blockers

### 🟡 1. Test API key on hand, webhook secret missing

- **What's needed:** `OGATEWAY_API_KEY` ✅ (`test_e96d…8a02`) and
  `OGATEWAY_WEBHOOK_SECRET` ❌ (not yet supplied).
- **Why it blocks:** Outbound calls work with just the API key, but any webhook
  POST OGateway sends back is rejected by `verifyWebhookSignature` until the
  secret is set. That means *no callbacks land*, which in turn means:
  - GHS payouts stay in `PROCESSING` forever (status only resolves via webhook).
  - GHS collections never credit the user's NGN wallet.
- **Resolution:** generate a webhook secret in
  `https://dash.ogateway.io` → Settings → API Keys → Webhook secret, paste into
  `.env` as `OGATEWAY_WEBHOOK_SECRET=…`.

### 🔴 2. `OGATEWAY_CALLBACK_URL` must be publicly reachable

- **What's needed:** an HTTPS URL OGateway can POST to from the public internet.
  Sent per-request as `callbackURL` in payout and collection bodies.
- **Why it blocks:** Same as above — without a reachable callback, no events.
- **Resolution by environment:**
  - **Local dev:** run `ngrok http 4000` (or `cloudflared tunnel run`) and set
    `OGATEWAY_CALLBACK_URL=https://<id>.ngrok-free.app/public/webhook/ogateway`.
  - **Staging/Prod:** deploy backend, set `OGATEWAY_CALLBACK_URL=https://<your-domain>/public/webhook/ogateway`.

### 🔴 3. GHS float on the OGateway side must be pre-funded for outbound payouts

- **What's needed:** a non-zero GHS balance on the OGateway business
  dashboard. Payouts draw from this; OGateway does not extend credit.
- **Why it blocks:** Every `Send Instantly → GHS` will fail at the provider with
  an insufficient-funds error if the OGateway GHS wallet is empty.
- **Sandbox vs production:** sandbox usually waives this (test keys simulate
  balance); **production absolutely requires it**.
- **Resolution:** treasury tops up the OGateway GHS balance before enabling the
  live key.

---

## Soft blockers (ship anyway, fix incrementally)

### 🟡 4. No documented bank-account name-enquiry endpoint

- **Symptom:** YellowCard exposes `/details/bank` and `/details/momo` so we can
  pre-validate the recipient and auto-fill the account holder name. OGateway
  docs don't appear to document an equivalent.
- **Impact:** Users type the recipient name themselves. First time we learn the
  name was wrong is in the failure webhook.
- **Mitigation in code:** accept the typed `accountName` as-is and surface the
  failure cleanly in the txn detail modal.
- **Resolution:** confirm with OGateway support whether an undocumented
  resolution endpoint exists; swap in if so.

### 🟡 5. Ghana bank-code list lives on a separate docs page (not yet fetched)

- **Symptom:** `POST /disbursements/bank` accepts a `bank` string (e.g. `ZEN`,
  `GTB`). The bank-payouts page references "a full list here" but does not
  inline the codes.
- **Impact:** Cannot ship a pre-populated bank dropdown in the first pass.
- **Mitigation in code:** ship a free-text `Bank code` input behind a small
  helper that uppercases on entry; replace with a dropdown in a follow-up.
- **Resolution:** pull the Ghana bank list from
  `https://docs.ogateway.io/docs/bank` (or the OGateway dashboard) and store
  as a static `data/ogateway-ghana-banks.ts`.

### 🟡 6. No documented webhook retry policy + no status-lookup endpoint

- **Symptom:** OGateway docs don't state whether webhooks are retried, and we
  haven't found a `GET /transactions/{id}` lookup either. If a single webhook
  POST is missed (deploy, downtime, signature mismatch), the local transaction
  is stuck in `PROCESSING`.
- **Mitigation in code:**
  - Idempotent webhook handler keyed on `reference_business` (which is our
    `sequenceId`), so duplicates are safe.
  - All inbound webhooks are recorded in `WebhookEvent` and replayable from
    the admin Webhooks page.
  - A sweeper flags OGateway transactions still `PROCESSING` after
    `OGATEWAY_STALE_AFTER_MINUTES` (default 15) for admin attention.
- **Resolution:** confirm retry policy with OGateway; if absent, ask if there's
  a status-lookup endpoint we can poll.

### 🟡 7. No documented webhook source IP allowlist

- **Symptom:** `/public/webhook/ogateway` is open by definition — only HMAC
  protects it.
- **Mitigation in code:** strict `x-ogateway-signature` (HMAC-SHA512 hex on
  raw body) verification before any state change; rejects with `401` and
  records the event as `failed` for audit.
- **Resolution:** if OGateway publishes an IP allowlist, add it at the WAF /
  load balancer layer.

### 🟢 8. Cross-currency FX

- **Status:** resolved — OGateway is a payment-only rail and does not quote FX.
  The NGN/GHS rate continues to come from your `ExchangeRate` table and is
  persisted on the transaction via `lockedRate` / `lockedRateFromCurrency` /
  `lockedRateToCurrency` exactly the way the YellowCard path does it.
- **Action required:** make sure an active `NGN→GHS` and `GHS→NGN` rate is set
  on the admin Rates page before enabling the GHS flow.

---

## Env vars summary

```bash
# OGateway — Ghana payments rail
OGATEWAY_API_KEY=test_xxx                            # test_… or live_…
OGATEWAY_WEBHOOK_SECRET=…                            # HMAC-SHA512 secret from dashboard
OGATEWAY_BASE_URL=https://api.ogateway.io            # constant; env implied by key prefix
OGATEWAY_CALLBACK_URL=https://…/public/webhook/ogateway   # public HTTPS URL
OGATEWAY_STALE_AFTER_MINUTES=15                      # optional, sweeper threshold
```

## Scope reminder

- **In scope:** GHS instant **send** (NGN→GHS payout) and **receive** (GHS→NGN
  collection) via OGateway mobile money and bank.
- **Out of scope:** every other currency. YellowCard continues to handle
  KES, XAF, and others.
