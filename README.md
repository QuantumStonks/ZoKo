# Zoko

**Typed AI decisions, paid in eCash, with explicit spending limits and an auditable ledger.**

Zoko is a deployable marketplace service for machine-to-machine semantic decisions. Buyers submit context and typed questions, obtain an exact price, and purchase a schema-validated result. The service includes a real Typesafe/Jev adapter, an operator and buyer console, a TypeScript client, a recovery-aware CLI, PostgreSQL accounting, a dedicated service wallet and hosted Chronik deposit and withdrawal processing. Buyers can fund their accounts from Cashtab. The API signs withdrawals programmatically with the service wallet.

Every balance, price, fee and limit is an integer string in **nanoXEC**. One XEC is 1,000,000,000 nanoXEC; one spendable on-chain atom is 10,000,000 nanoXEC (0.01 XEC). Small AI purchases settle in the application ledger. On-chain deposits and withdrawals fund and redeem that balance, so each inference does not require a dust-sized blockchain transaction.

## What is implemented

| Capability | Behavior |
|---|---|
| Typed inference | Jev `noul`, `choice` and `score` questions, including mixed questions in one request; exact response keys, valid distributions and rubric matching are enforced. |
| Quotes and routing | The cheapest currently eligible seller is selected deterministically, subject to account and request policy. Quotes bind the input, schema, seller, model, price and deadline. |
| Spending controls | Per-purchase ceilings, UTC daily budgets, seller allowlists and disabled-account checks apply before money is reserved. |
| Retry safety | A durable idempotency key binds a purchase. Concurrent retries reuse the same decision; external inference is never automatically repeated after an ambiguous failure. |
| Accounting | PostgreSQL transactions reserve, capture or refund funds. The append-only transfer journal reconciles wallet balances. Process memory is not the financial authority. |
| Funding | Each account receives its own service-wallet deposit address. Cashtab payment links and the optional extension support customer-authorized funding; hosted Chronik verifies actual outputs, chain anchors and reported finality. Token-bearing outputs are rejected. |
| Withdrawals | A dedicated HD wallet signs locally using the eCash library. Amounts, maximum fees and inputs are reserved, signed bytes and the transaction ID are persisted before hosted broadcast, and recovery rebroadcasts those exact bytes. |
| Operations | Persistent PostgreSQL, a non-root container, readiness checks, a read-only doctor, backups with checksums, optional Caddy HTTPS, CI and a functional console. |

This release is an **operator-curated, custodial marketplace**. The operator creates buyer accounts and approves sellers; the API holds its dedicated eCash service-wallet seed. Cashtab remains the customer's wallet. Hosted Chronik supplies the trusted chain view; Zoko validates transaction structure and configured chain anchors but does not independently run consensus validation. Seller availability and price are real configured offers. Task quality and commercial margin must be measured for the actual buyer workload.

## Deploy

Prerequisites are **Node 24**, Docker with Compose, a public domain for HTTPS and a funded Typesafe API account. The default hosted Chronik endpoints supply blockchain access with ordered failover. `npm run init` generates the dedicated service-wallet secret locally. See [eCash operation](docs/ecash.md) for wallet custody, hosted endpoint trust, finality and recovery.

```bash
git clone https://github.com/QuantumStonks/ZoKo.git
cd ZoKo
npm ci
npm run init
```

`npm run init` creates `.env` with independent random administrator, encryption, PostgreSQL and service-wallet secrets and refuses to overwrite an existing file. **Back up this file securely before funding the service. Never supply your personal Cashtab recovery phrase.** Set these values in `.env`:

- `ZOKO_PUBLIC_URL`, `ZOKO_DOMAIN`, and `ACME_EMAIL` for your domain.
- `TYPESAFE_API_KEY` for real inference, with `TYPESAFE_MODEL` pinned to the desired model.
- Retain the generated `XEC_WALLET_SEED_HEX`. This is the dedicated service secret, distinct from the encryption key and personal wallets.
- Retain the hosted mainnet defaults in `CHRONIK_URLS`, or supply your chosen trusted endpoints. Setup includes `https://chronik.e.cash` followed by `https://chronik-native2.fabien.cash` for availability failover.
- `ZOKO_JEV_PRICE_NANOS` and `ZOKO_PLATFORM_FEE_BPS` for your actual business economics.

Then start the service:

```bash
docker compose --profile https up -d --build --wait --wait-timeout 180
docker compose exec -T api node dist/src/doctor.js
```

Point DNS to the host and permit inbound TCP 80/443 (and optionally UDP 443 for HTTP/3). Open `ZOKO_PUBLIC_URL`. Connect using `ZOKO_ADMIN_TOKEN`, create a buyer account with a bounded budget, and save its API key when it is issued. Buyer keys are returned once; the database stores their hashes.

The doctor performs authenticated metadata, wallet-identity and infrastructure reads. It **does not assign addresses, sign transactions, spend provider credit or transfer eCash**. As a buyer, use the console's funding form to prepare a payment and approve it in Cashtab, or send to the displayed address from another eCash wallet. Credit appears only after server-side verification meets the configured confirmations and finality. Complete the small real deposit → decision → withdrawal acceptance sequence in [deployment and recovery](docs/deployment.md) before inviting customers. Real external acceptance depends on your credentials, domain, hosted service availability and actual network settlement.

For an existing empty installation missing the service seed, `npm run init -- --add-wallet` securely adds only that missing value. Existing funded databases from the earlier node-wallet backend require the explicit [legacy migration procedure](docs/ecash.md#legacy-node-wallet-deployments); changing a seed cannot migrate their funds or pending payments.

For an existing reverse proxy, omit `--profile https`. The application binds to `127.0.0.1:3000` on the host. Keep production `ZOKO_PUBLIC_URL` set to the public HTTPS URL.

## Purchase a decision

The [client guide](docs/client.md) documents the TypeScript SDK and CLI, including interrupted-request recovery. The exact Jev wire contract and confidence semantics are in [provider integration](docs/jev.md).

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

The account's limit still applies when the request ceiling is higher. A valid low-confidence result is charged and returned with `accepted: false` when below the requested threshold. That threshold controls whether an application should use the result; it does not promise a refund or calibrated correctness. Invalid responses, transport errors and expired executions release the buyer's reservation. The operator may still have incurred upstream provider charges after an uncertain timeout.

`policy.maxLatencyMs` bounds the provider execution attempt. Catalog `p95LatencyMs` summarizes observed provider execution time. Gateway database work, quote creation and client/network transit add latency; neither field represents a measured end-to-end service guarantee.

## API

All request and response bodies are JSON. Authenticated routes use `Authorization: Bearer ...`. Monetary fields are integer decimal strings in nanoXEC. Decision execution and withdrawals require an `Idempotency-Key`.

| Route | Purpose |
|---|---|
| `GET /health/live`, `GET /health/ready` | Process and dependency readiness. |
| `GET /.well-known/zoko.json` | Public protocol and service discovery. |
| `GET /v1/catalog` | Configured sellers, prices and measured request statistics. |
| `GET /v1/me` | Account policy, balances, deposit address and spending. |
| `POST /v1/deposit-address` | Allocate or retrieve the buyer's assigned deposit address. |
| `POST /v1/deposits/claim` | Verify an actual transaction's deposit outputs for this account. |
| `POST /v1/quotes` | Get an input-bound offer under an explicit policy. |
| `POST /v1/decisions` | Execute that offer once using an idempotency key. |
| `GET /v1/decisions`, `GET /v1/decisions/:id` | Inspect the authenticated buyer's history and recover outcomes. |
| `POST /v1/withdrawals`, `GET /v1/withdrawals` | Reserve an on-chain withdrawal or inspect its progress. |
| `POST /v1/admin/accounts` | Issue an account and one-time API key. |
| `POST /v1/admin/sellers` | Register an approved provider and encrypted credential. |
| `PATCH /v1/admin/accounts/:id` | Change spending policy or disable an account. |
| `POST /v1/admin/accounts/:id/rotate-key` | Revoke the previous buyer key and issue its replacement once. |
| `PATCH /v1/admin/sellers/:id` | Change seller enablement, price, credential or payout account. |
| `POST /v1/admin/revenue-transfer` | Move actually earned platform funds to an operator account, using an idempotency key. |
| `GET /v1/admin/overview`, `GET /v1/admin/audit` | Actual operating totals and journal reconciliation. |

See the schemas and route validation in `src/server.ts` and `src/protocol.ts` for the complete executable contract. The console uses these same routes.

## Financial and execution guarantees

A purchase reserves available funds and daily budget in the same transaction that creates its durable request. The provider is called outside that transaction. A valid response is recorded with the final transfer in one commit. Stale executions are refunded under a row lock; a late provider result cannot charge a refunded purchase.

The configured commission is taken from a third-party seller's price; the rest is credited to that seller's payout account. Offers owned by the operator with no payout account credit the platform wallet. Prices are explicit nanoXEC amounts: Zoko has no invented XEC/USD peg, assumed profitable price, guaranteed latency, or marketplace demand. Provider credit, blockchain fees and operational expenses remain operator costs.

The administrator can transfer earned platform balance to an operator buyer account and withdraw it through the same recorded withdrawal path. That transfer cannot exceed the platform balance or create money. Initial Jev credentials, model and price are provisioned from `.env` once. Later price and credential changes use the administrator API, so a restart preserves operator edits. To change the pinned model, create and approve a new seller offer.

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
- [Jev protocol and confidence](docs/jev.md)
- [TypeScript SDK and CLI](docs/client.md)
