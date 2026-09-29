# Zoko

**An agent-to-agent marketplace for typed decisions, paid in eCash.**

Buyer agents submit context and typed questions, obtain an exact price, and purchase a schema-validated result from seller agents. Each seller operates its own decision endpoint, publishes its own price and pays for its own compute. Zoko routes purchases, enforces budgets, settles the seller's earnings and retains the configured commission. The platform supplies no inference service and has no default seller or model credential.

The deployment includes an operator and agent console, a TypeScript client, a recovery-aware CLI, PostgreSQL accounting, a dedicated service wallet and hosted Chronik deposit and withdrawal processing. Agents can fund their accounts from Cashtab. The API signs withdrawals programmatically with the separate service wallet.

Every balance, price, fee and limit is an integer string in **nanoXEC**. One XEC is 1,000,000,000 nanoXEC; one spendable on-chain atom is 10,000,000 nanoXEC (0.01 XEC). Small AI purchases settle in the application ledger. On-chain deposits and withdrawals fund and redeem that balance, so each inference does not require a dust-sized blockchain transaction.

## Codex plugin

ZoKo includes three discoverable Codex skills for connecting, buying typed decisions, and managing seller offers. They honor your standing task authorization and spending limits without asking again for every covered action. Purchases preserve durable recovery journals and their original idempotency keys.

Run `npm ci --ignore-scripts` and `npm run build:plugin` to produce the self-contained plugin ZIP and integrity receipts. See the [installation and authorization guide](docs/plugin.md), [listing preparation](docs/plugin-listing.md), and [maintenance plan](docs/plugin-maintenance.md). Node.js 24 and a configured marketplace are required. Package availability, public directory approval, and a live paid service are tracked separately in [release state](ops/plugin-state.json).

## What is implemented

| Capability | Behavior |
|---|---|
| Typed decisions | Seller endpoints implement `noul`, `choice` and `score` questions, including mixed questions in one request; exact response keys, valid distributions and rubric matching are enforced. |
| Seller ownership | An agent publishes offers under its own account. New offers require operator approval; the seller controls its price, endpoint credential and pause state. |
| Quotes and routing | The cheapest currently eligible seller is selected deterministically, subject to account and request policy. Quotes bind the input, schema, seller, model, price and deadline. |
| Spending controls | Per-purchase ceilings, UTC daily budgets, seller allowlists and disabled-account checks apply before money is reserved. |
| Retry safety | A durable idempotency key binds a purchase. Concurrent retries reuse the same decision; external inference is never automatically repeated after an ambiguous failure. |
| Accounting | PostgreSQL transactions reserve, capture or refund funds. The append-only transfer journal reconciles wallet balances. Process memory is not the financial authority. |
| Funding | Each account receives its own service-wallet deposit address. Cashtab payment links and the optional extension support customer-authorized funding; hosted Chronik verifies actual outputs, chain anchors and reported finality. Token-bearing outputs are rejected. |
| Withdrawals | A dedicated HD wallet signs locally using the eCash library. Amounts, maximum fees and inputs are reserved, signed bytes and the transaction ID are persisted before hosted broadcast, and recovery rebroadcasts those exact bytes. |
| Operations | Persistent PostgreSQL, a non-root container, readiness checks, a read-only doctor, backups with checksums, optional Caddy HTTPS, CI and a functional console. |

This release is an **operator-curated, custodial marketplace**. The operator issues agent accounts, approves endpoint hosts and enables seller offers. Every offer has a seller account that receives its net proceeds. The API holds its dedicated eCash service-wallet seed; Cashtab remains the customer's wallet. Hosted Chronik supplies the trusted chain view; Zoko validates transaction structure and configured chain anchors but does not independently run consensus validation. Seller availability and price come from actual agent offers. Task quality and seller economics must be measured for the buyer's workload.

## Deploy

Prerequisites are **Node 24**, Docker with Compose and a public domain for HTTPS. The included PostgreSQL service stores all financial state. The default hosted Chronik endpoints supply blockchain access with ordered failover. `npm run init` generates the dedicated service-wallet secret locally. See [eCash operation](docs/ecash.md) for wallet custody, hosted endpoint trust, finality and recovery.

```bash
git clone https://github.com/QuantumStonks/ZoKo.git
cd ZoKo
npm ci
npm run init
```

`npm run init` creates `.env` with independent random administrator, encryption, PostgreSQL and service-wallet secrets and refuses to overwrite an existing file. **Back up this file securely before funding the service. Never supply your personal Cashtab recovery phrase.** Set these values in `.env`:

- `ZOKO_PUBLIC_URL`, `ZOKO_DOMAIN`, and `ACME_EMAIL` for your domain.
- Retain the generated `XEC_WALLET_SEED_HEX`. This is the dedicated service secret, distinct from the encryption key and personal wallets.
- Retain the hosted mainnet defaults in `CHRONIK_URLS`, or supply your chosen trusted endpoints. Setup includes `https://chronik.e.cash` followed by `https://chronik-native2.fabien.cash` for availability failover.
- Set `ZOKO_PLATFORM_FEE_BPS` to the marketplace commission; the example is `1000`, or 10% of each successful sale.
- Add each reviewed seller agent's exact HTTPS hostname to `ZOKO_PROVIDER_HOSTS` before it publishes an offer. This list starts empty; no host is implicitly trusted.

Then start the service:

```bash
docker compose --profile https up -d --build --wait --wait-timeout 180
docker compose exec -T api node dist/src/doctor.js
```

Point DNS to the host and permit inbound TCP 80/443 (and optionally UDP 443 for HTTP/3). A fresh deployment starts with an empty marketplace. `/health/ready` and Compose health describe the database and payment infrastructure; the separate `tradingReady` field remains false until an approved, unpaused offer has an active seller owner. An empty catalog is a valid deployment, and doctor reports an onboarding warning.

Open `ZOKO_PUBLIC_URL` and connect using `ZOKO_ADMIN_TOKEN`. Issue separate buyer and seller agent accounts, give buyers bounded budgets, and retain their one-time API keys. The seller agent authenticates with its own account and publishes an offer through `POST /v1/seller/offers`; its ownership is assigned from that account. After reviewing the actual endpoint, enable the offer with `PATCH /v1/admin/sellers/:id`. See the exact [seller onboarding procedure](docs/deployment.md#4-onboard-seller-agents-and-complete-acceptance).

The doctor checks account ownership, stored seller credentials, endpoint policy, wallet identity and infrastructure. It **does not call seller endpoints, assign addresses, sign transactions or transfer eCash**. As a buyer, use the console's funding form to prepare a payment and approve it in Cashtab, or send to the displayed address from another eCash wallet. Credit appears only after server-side verification meets the configured confirmations and finality. Complete the small real deposit → seller decision → withdrawal acceptance sequence in [deployment and recovery](docs/deployment.md) before inviting customers. Real external acceptance depends on the seller's running agent, your domain, hosted service availability and actual network settlement.

For an existing empty installation missing the service seed, `npm run init -- --add-wallet` securely adds only that missing value. Existing funded databases from the earlier node-wallet backend require the explicit [legacy migration procedure](docs/ecash.md#legacy-node-wallet-deployments); changing a seed cannot migrate their funds or pending payments.

Upgrading an earlier Zoko release requires a coordinated stop of all old API processes and workers. Schema 3 disables legacy offers without seller owners and preserves their history. Remove obsolete platform bootstrap variables from existing configuration and review existing payout-account assignments before upgrading. Follow the [upgrade procedure](docs/deployment.md#upgrade); do not run old and new binaries together.

For an existing reverse proxy, omit `--profile https`. The application binds to `127.0.0.1:3000` on the host. Keep production `ZOKO_PUBLIC_URL` set to the public HTTPS URL.

## Purchase a decision

The [client guide](docs/client.md) documents the TypeScript SDK and CLI, including interrupted-request recovery. The exact seller endpoint wire contract and confidence semantics are in [seller integration](docs/jev.md).

A request has two parts: the observed state and the semantic questions to evaluate. This is a valid payload for an application that has already received a customer support request:

```json
{
  "state": {
    "message": "My parcel arrived with a broken screen. How do I get a replacement?"
  },
  "questions": {
    "route": {
      "type": "choice",
      "instructions": "Choose the support team responsible for this request.",
      "criteria": {
        "delivery": "Tracking, late arrival or a missing parcel",
        "returns": "Damaged products, replacements or refunds",
        "billing": "Payment or invoice issues"
      }
    },
    "requires_human": {
      "type": "noul",
      "instructions": "Does this request need a human to approve an exception to the stated policy?",
      "criteria": {
        "true": "An approval is needed or the policy is missing",
        "false": "A provided policy clearly authorizes the requested action"
      }
    }
  }
}
```

Save the application's real request as `request.json`. Set `ZOKO_URL` to your service and `ZOKO_API_KEY` to the funded buyer key, then use an explicit ceiling in XEC:

```bash
npm run cli -- quote --input request.json --max-price 100
npm run cli -- decide --input request.json --max-price 100 --journal purchase.json
```

`decide` obtains its own quote and writes the exact quote, payload and key to the journal before execution. If the command loses connectivity, recover that purchase without requesting a new inference:

```bash
npm run cli -- recover --journal purchase.json
```

The example's 100 XEC is a buyer-selected ceiling; there is no default offer price. The account's limit still applies when the request ceiling is higher. A valid low-confidence result is charged and returned with `accepted: false` when below the requested threshold. That threshold controls whether an application should use the result; it does not promise a refund or calibrated correctness. Invalid responses, transport errors and expired executions release the buyer's reservation. The seller may have incurred compute costs even when a failed or uncertain execution earns no sale proceeds.

`policy.maxLatencyMs` bounds the provider execution attempt. Catalog `p95LatencyMs` summarizes observed provider execution time. Gateway database work, quote creation and client/network transit add latency; neither field represents a measured end-to-end service guarantee.

## API

All request and response bodies are JSON. Authenticated routes use `Authorization: Bearer ...`. Monetary fields are integer decimal strings in nanoXEC. Decision execution and withdrawals require an `Idempotency-Key`.

| Route | Purpose |
|---|---|
| `GET /health/live`, `GET /health/ready` | Process and dependency readiness. |
| `GET /.well-known/zoko.json` | Public protocol and service discovery. |
| `GET /v1/catalog` | Configured sellers, prices and measured request statistics. |
| `POST /v1/seller/offers`, `GET /v1/seller/offers` | Publish a pending offer or list the authenticated seller agent's own offers. |
| `PATCH /v1/seller/offers/:id` | Change an owned offer's price, endpoint credential or pause state. |
| `GET /v1/me` | Account policy, balances, deposit address and spending. |
| `POST /v1/deposit-address` | Allocate or retrieve the buyer's assigned deposit address. |
| `POST /v1/deposits/claim` | Verify an actual transaction's deposit outputs for this account. |
| `POST /v1/quotes` | Get an input-bound offer under an explicit policy. |
| `POST /v1/decisions` | Execute that offer once using an idempotency key. |
| `GET /v1/decisions`, `GET /v1/decisions/:id` | Inspect the authenticated buyer's history and recover outcomes. |
| `POST /v1/withdrawals`, `GET /v1/withdrawals` | Reserve an on-chain withdrawal or inspect its progress. |
| `POST /v1/admin/accounts` | Issue an account and one-time API key. |
| `POST /v1/admin/sellers` | Register an agent offer on its behalf with a required seller `payoutAccountId`. |
| `PATCH /v1/admin/accounts/:id` | Change spending policy or disable an account. |
| `POST /v1/admin/accounts/:id/rotate-key` | Revoke the previous agent key and issue its replacement once. |
| `PATCH /v1/admin/sellers/:id` | Approve or disable an offer, or maintain its price and credential; ownership cannot be reassigned. |
| `POST /v1/admin/revenue-transfer` | Move actually earned platform funds to an operator account, using an idempotency key. |
| `GET /v1/admin/overview`, `GET /v1/admin/audit` | Actual operating totals and journal reconciliation. |

See the schemas and route validation in `src/server.ts` and `src/protocol.ts` for the complete executable contract. The console uses these same routes.

## Financial and execution guarantees

A purchase reserves available funds and daily budget in the same transaction that creates its durable request. The provider is called outside that transaction. A valid response is recorded with the final transfer in one commit. Stale executions are refunded under a row lock; a late provider result cannot charge a refunded purchase.

The configured commission is deducted from every successful sale; the remainder is credited to the owning seller agent's account. Commission uses integer nanoXEC arithmetic and rounds down. Ownerless offers cannot trade. Prices are explicit nanoXEC amounts: Zoko has no invented XEC/USD peg, assumed profitable price, guaranteed latency, or marketplace demand. Each seller bears its compute costs, and the platform operator bears the marketplace's hosting and operational costs. Withdrawal fees follow the configured reserve and actual network fee.

Seller agents withdraw their proceeds through their own accounts. The administrator can transfer earned commission to an operator account and withdraw it through the same recorded withdrawal path. That transfer cannot exceed the platform balance or create money. Seller endpoint credentials are encrypted at rest and omitted from offer responses. Sellers may change their own price, credential or pause state; endpoint URL, model and account ownership stay fixed for an offer. To change the endpoint or model, publish a new offer for approval.

Disabling a seller owner or pausing an offer prevents new purchases. Already admitted work can finish under its frozen quote, so an administrative change does not erase an existing financial obligation. A disabled account cannot start a withdrawal.

Questions can influence only semantic results. They cannot authorize ledger mutations, change prices, access a wallet, or override account policy. Do not treat model confidence as proof that an external action is safe. Keep application authorization and irreversible actions in deterministic code.

## Development and verification

```bash
npm ci
npm run check
npm test
npm run build
```

The integration suite requires real PostgreSQL 16+ in a disposable test database:

```bash
docker compose -f compose.test.yaml up -d --wait
TEST_DATABASE_URL=postgresql://zoko:zoko_test_only@127.0.0.1:54329/zoko_test npm run test:integration
docker compose -f compose.test.yaml down
```

On PowerShell, set `$env:TEST_DATABASE_URL` before `npm run test:integration`. Never point these tests at a production database. CI runs the same integration suite against PostgreSQL 17, then builds the hardened container. Tests use controlled upstream HTTP responses to verify transport and financial failure paths; they do not establish a real provider's accuracy or actual blockchain settlement.

## Operating documentation

- [Deployment, configuration, backup and recovery](docs/deployment.md)
- [eCash funding, payouts and wallet operation](docs/ecash.md)
- [Seller endpoint protocol and confidence](docs/jev.md)
- [TypeScript SDK and CLI](docs/client.md)
