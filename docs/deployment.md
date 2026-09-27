# Deploy and operate Zoko

The production configuration serves the API and console from one origin, with PostgreSQL as the financial authority. A dedicated Bitcoin ABC wallet supplies eCash addresses and signs withdrawals; Chronik supplies indexed output and token evidence. Typesafe/Jev supplies typed inference. The included Compose deployment manages the API, PostgreSQL and optional Caddy reverse proxy. The Bitcoin ABC node and wallet are provisioned separately because their chain synchronization, key custody and backup lifecycle are independent of an application container.

## 1. Provision real dependencies

Use Node 24 and Docker with the Compose plugin. Docker Desktop with a Linux engine is suitable for local verification on Windows; use a durable host for an unattended service. Ensure the host clock is synchronized. Reserve disk space and backups for PostgreSQL and the separately managed blockchain node.

Create a dedicated Bitcoin ABC wallet named `zoko` with private keys enabled. Configure eCash mode, RPC and transaction indexing. If hosting Chronik on the same node, enable both Chronik and token indexing. Configure authenticated RPC on a private network and restrict it to the API host or container network. Do not publish RPC through Caddy. See [eCash operation](ecash.md) for the exact node requirements and verification assumptions.

Back up the wallet before receiving customer funds. An encrypted wallet must be unlocked for the withdrawal worker by the operator through Bitcoin ABC's own administrative channel. Zoko never stores a wallet passphrase. Configure a funded Typesafe API account. Provider billing and buyer ledger balances are separate accounts.

## 2. Create and retain secrets

Run from the repository:

```bash
npm ci
npm run init
```

The generated `.env` has mode `0600` on systems supporting POSIX permissions and is excluded from Git and the Docker build context. It contains a 256-bit administrator token, a 256-bit AES-GCM key for provider credentials and a 256-bit database password. The script uses exclusive file creation and never replaces existing secrets. On Windows, additionally restrict access using filesystem ACLs.

Store an encrypted copy of the configuration with the deployment's recovery material. Losing `ZOKO_ENCRYPTION_KEY` makes existing seller credentials and already-issued quote snapshots unreadable. Changing that key in place is not a rotation procedure. Replacing `ZOKO_ADMIN_TOKEN` and restarting the API rotates the administrator credential; connected clients then need the new token. Buyer credentials are independent and should have the narrowest useful account limits.

Rotate a buyer key with `POST /v1/admin/accounts/:id/rotate-key`; the previous key stops authenticating and the replacement is returned once. Rotate a seller credential with `PATCH /v1/admin/sellers/:id` and an `apiKey` field. `TYPESAFE_API_KEY`, `TYPESAFE_MODEL` and `ZOKO_JEV_PRICE_NANOS` provision the initial Jev offer only; changing those environment variables does not overwrite an existing seller. Use the administrator API for subsequent price and credential edits. A new pinned model should be registered as a new seller offer, with buyer allowlists updated deliberately.

### Core configuration

| Variable | Meaning |
|---|---|
| `NODE_ENV` | Use `production` for the live deployment; production public URLs must be HTTPS. |
| `ZOKO_PUBLIC_URL` | Public HTTPS origin used by the deployment. |
| `ZOKO_DOMAIN`, `ACME_EMAIL` | Domain and ACME contact for the optional Caddy profile. |
| `ZOKO_ADMIN_TOKEN` | Administrator bearer token, at least 32 non-whitespace characters. |
| `ZOKO_ENCRYPTION_KEY` | Standard base64 of exactly 32 random bytes. Retain it across restarts and database restores. |
| `POSTGRES_PASSWORD` | Used by Compose for the private database and the API connection. The generated hexadecimal value is URL-safe. |
| `DATABASE_URL` | Native Node connection URL. Compose explicitly replaces it with the private service address. |
| `TYPESAFE_API_KEY` | Real provider credential used when initially provisioning the operator's Jev offer. |
| `TYPESAFE_MODEL` | Initial pinned provider model, default `jev-1.13.0`. Model aliases are mutable. |
| `ZOKO_JEV_PRICE_NANOS` | Initial operator-selected price per successfully validated decision. Default `100000000000` = 100 XEC. |
| `ZOKO_PLATFORM_FEE_BPS` | Commission on a third-party seller's price. Default `1000` = 10%; operator-owned offers have no third-party payout. |
| `ZOKO_PROVIDER_HOSTS` | Comma-separated exact HTTPS provider hostnames. No wildcards, URL credentials or user-selected arbitrary hosts. |
| `ZOKO_PROVIDER_TIMEOUT_MS` | Upstream deadline, default 10,000 ms, permitted 100–60,000 ms. |
| `ZOKO_QUOTE_TTL_SECONDS` | Quote validity, default 60 seconds, permitted 5–300 seconds. |
| `HOST`, `PORT` | Native application bind address and port; Compose sets container port 3000. |
| `ZOKO_LOCAL_PORT` | Optional host loopback port for the Compose API mapping. |

### Payment configuration

| Variable | Meaning |
|---|---|
| `ZOKO_PAYMENTS_ENABLED` | Default `true`. Disabled payments are suitable for development only; doctor reports that funding is unavailable. |
| `XEC_NETWORK` | `mainnet`, `testnet` or `regtest`; all wallet, address, Chronik and transaction evidence must match. |
| `ABC_RPC_URL` | Private Bitcoin ABC RPC origin. `host.docker.internal` reaches the Docker host when that host is running the node. |
| `ABC_RPC_USERNAME`, `ABC_RPC_PASSWORD` | Credential for the private RPC service. No credentials in the URL. |
| `ABC_RPC_WALLET` | Dedicated wallet name, default `zoko`. |
| `CHRONIK_URLS` | Comma-separated operator-trusted Chronik URLs for the configured network. |
| `XEC_CONFIRMATIONS` | Minimum confirmation depth, default 6. |
| `XEC_REQUIRE_FINALIZED` | Default `true`; requires Avalanche finality in addition to confirmations. |
| `XEC_MAX_FEE_NANOS` | Maximum fee reserved for a withdrawal, default 100 XEC; actual fee is charged and unused reserve released. |
| `XEC_FEE_RATE` | Funding fee rate in exact XEC per kB, default `10.00` (1 atom/byte). |
| `XEC_MAX_FEE_RATE` | Upper bound in XEC per kB, default `100.00`. |
| `XEC_TOKEN_PROBE_TXID` | Known token transaction used to prove token-index capability; a mainnet canary is built in. Supply a valid canary for testnet/regtest. |

Never reuse the signing wallet for unrelated sends or manual input unlocking. Reconciliation and transaction recovery depend on exclusive control of its outgoing transactions. The generated configuration does not contain wallet funds or provider credit.

## 3. Launch HTTPS

Set `ZOKO_DOMAIN` to a real domain, `ZOKO_PUBLIC_URL` to its HTTPS URL and `ACME_EMAIL` to your operational address. Point its DNS records to the host, permitting public TCP 80/443 for ACME and HTTPS. If publishing an AAAA record, the host must also serve IPv6 correctly.

```bash
docker compose --profile https up -d --build
docker compose ps
docker compose exec -T api node dist/src/doctor.js
```

Caddy obtains and renews the certificate and proxies to `api:3000`. PostgreSQL has no host port. The API is also reachable from the host at `127.0.0.1:3000`; it is not bound to a public host interface. The application drops capabilities, runs as the unprivileged Node user, uses a read-only root filesystem and has bounded memory, PIDs and logs. PostgreSQL and Caddy state use named volumes. `docker compose down` preserves them; `docker compose down --volumes` destroys them and must never be part of an upgrade.

For an existing HTTPS reverse proxy, run `docker compose up -d --build` and forward to the loopback port. The application does not trust arbitrary forwarded headers. Consequently a reverse proxy's connections share an IP-based transport rate limit. Financial limits are per authenticated account and transactional in PostgreSQL. Run one API instance with this included deployment; scaling admission control and proxy trust requires an explicit topology change.

The image defaults to the Node 24 maintained release line; PostgreSQL uses major 17 and Caddy major 2. Capture image digests with each release and use those immutable image references for a tightly controlled production promotion. Updating a major database version requires PostgreSQL's supported upgrade process, not simply changing the Compose tag against an existing volume.

## 4. Bootstrap accounts and complete acceptance

The console and API are served by the same application. Open your HTTPS origin and connect with `ZOKO_ADMIN_TOKEN`. Create a buyer account with a small per-decision ceiling, a small daily budget and the intended seller allowlist. Save the returned buyer key; there is no plaintext key retrieval endpoint. Connect as that buyer to see its assigned balance and policy.

The read-only doctor checks configuration, PostgreSQL version and schema, journal and budget reconciliation, seller credential envelopes, the wallet/node/Chronik preflight, and authenticated Typesafe model metadata. It never migrates the database, buys inference, allocates a deposit or signs a payout. Readiness is necessary infrastructure evidence; it cannot prove that provider billing, real payments or your application task will succeed.

Complete one bounded end-to-end acceptance cycle using real accounts:

1. Allocate the buyer's deposit address in the console. Verify the eCash prefix and send a small amount from an external wallet, allowing enough for the selected decision and withdrawal fee reserve.
2. Wait for the configured confirmations and finality. Claim the transaction ID if needed, and verify that the account balance equals the actual credited outputs. Claiming the same deposit again must not create another credit.
3. Request a quote for a representative, non-sensitive input. Check the exact price, model, seller and ceiling. Execute with a durable idempotency key or the CLI purchase journal. Verify that one charge and one result appear.
4. Recover that same purchase with its original journal or key. Confirm that the decision and charge are unchanged. Never create a fresh quote to recover an ambiguous purchase.
5. Request a small withdrawal to an independently verified eCash address. Save the withdrawal ID and eventual transaction ID, inspect the final fee and balance, and verify receipt in the external wallet. Reusing its idempotency key must return the same withdrawal.
6. Check the administrator audit and the real provider invoice/usage. Measure task quality and latency on representative cases before increasing account budgets.

Steps involving inference or transfers deliberately incur the explicitly requested cost. There is no fake balance faucet or administrator credit shortcut. The system does not assume that a default 100 XEC sale covers the provider bill; set prices from actual costs and the chosen acceptance policy.

To redeem earned platform revenue, create an operator account and call `POST /v1/admin/revenue-transfer` with `{accountId, amountNanos}` and a durable `Idempotency-Key`. The journal transfers only available platform earnings to that account; it cannot mint a credit. Then withdraw as the operator account through the standard fee-bounded payout path. Third-party sellers receive their net sale proceeds directly in their configured payout accounts.

## 5. Monitor and recover

`GET /health/live` indicates that the process is serving. `GET /health/ready` reports whether required dependencies are ready. Use readiness for traffic admission and alert when it fails. Watch container restart counts, storage usage, delayed deposits, unresolved withdrawals, provider failure rates and the administrator audit. Container logs are bounded; send them to your existing monitoring system with sensitive-field controls.

The service preserves completed decision receipts and journal entries in PostgreSQL. Inputs are sent to the chosen provider. Do not submit secrets unless the upstream provider's handling meets your requirements. A CLI recovery journal contains the exact original input; protect or remove it under your own retention policy. Browser credentials remain in session memory.

A network failure during inference can produce an upstream cost with no buyer charge. The local request remains durably identifiable. On restart, expired requests release their reservation and become terminal; the service never automatically invokes the model again for them. A late response cannot capture already-released funds. Inspect the original decision before deciding whether a new purchase is commercially justified.

Request `policy.maxLatencyMs` is the provider execution deadline, and catalog `p95LatencyMs` is measured provider execution time. Quote creation, database operations, gateway handling and network transit are additional. Measure the complete client round trip separately before promising an application latency target.

Withdrawal recovery uses the persisted signed transaction and transaction ID. It must never fabricate a replacement send after an ambiguous broadcast. If the node, token evidence, chain state, input ownership or fee validation is uncertain, keep outgoing service unavailable and investigate the recorded withdrawal. See [eCash operation](ecash.md) for the detailed recovery contract.

## Backup

The database stores account/address attribution, pending withdrawals, signed transaction bytes and the transfer journal. The dedicated wallet stores signing keys. The encryption key unlocks provider secrets. **All three are recovery material.** A database dump alone is not a complete funded-service backup.

The PostgreSQL helper creates a transaction-consistent custom-format dump and a SHA-256 checksum, with exclusive publication so an existing dump cannot be overwritten:

```bash
npm run backup
```

It streams `pg_dump` from the database container to `backups/`, uses file mode `0600`, and reports failures. It does not print credentials or include them in the dump command arguments. `backups/` must be kept out of Git and copied to encrypted off-host storage. A checksum detects corruption; authenticity depends on protecting the backup and its storage.

For a coordinated recovery checkpoint, stop the API, take a PostgreSQL backup, take a fresh Bitcoin ABC wallet backup through its protected administration channel, and retain the matching encrypted configuration. Then restart the API. Stopping the API prevents address allocation and signing from advancing during the checkpoint. Incoming chain transactions can still occur and are reconciled when the service resumes.

```bash
docker compose stop api
npm run backup
# Back up the dedicated Bitcoin ABC wallet and the encrypted configuration here.
docker compose up -d api
```

Schedule backups using your host's scheduler and verify restoration on an isolated host with outbound payments disabled. Do not run a restored signing wallet alongside the original live service. For smaller recovery-point objectives, operate PostgreSQL WAL archiving and an appropriate wallet backup/key-management procedure.

## Restore

The restore helper verifies the checksum before making changes, stops the API, starts PostgreSQL if necessary, and applies `pg_restore` in a single transaction. The explicit flag is required because it replaces the existing database:

```bash
npm run restore -- /absolute/path/zoko-backup.dump --confirm-restore
```

The API stays stopped after restoration. Restore the matching dedicated wallet and the original encryption key, reconcile any on-chain activity and withdrawal transactions after the checkpoint, then run the read-only doctor in a one-off container:

```bash
docker compose run --rm --no-deps api node dist/src/doctor.js
```

Only after that review should you explicitly start the API. A stale database cannot infer every customer address or request created after its snapshot; use the chosen recovery-point policy and retained wallet/journal evidence. Preserve the failed deployment's data separately until recovery is complete.

## Upgrade

Take a coordinated checkpoint and record the current commit and image digests. Fetch the reviewed release, install the locked dependencies, run unit and PostgreSQL integration tests, and build the image. Restart with `docker compose up -d --build api`, then run doctor and inspect the audit. Migrations are serialized transactionally on startup. Unsupported database schema versions fail closed. Do not roll back application code across an incompatible migration without restoring its matching database checkpoint.

## Validation boundaries

The repository's unit tests cover protocol validation, transport failure paths, client recovery and exact money handling. The PostgreSQL integration suite exercises actual row/advisory locks, concurrent reservations, idempotency and journal invariants. CI uses a PostgreSQL 17 service, builds the runtime image, and starts that unprivileged read-only image against the database to verify the console, authentication, account creation, ledger audit and fail-closed readiness without configured sellers. A green local typecheck or mocked-provider test is not evidence of real network settlement, wallet signing, customer task quality or positive operating margin; record those separately in the acceptance cycle above.
