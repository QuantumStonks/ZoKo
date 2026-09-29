# Hosted marketplace and real XEC acceptance

The repository includes a production Render Blueprint at [`render.yaml`](../render.yaml). It runs the existing Node.js 24 Docker image and a durable PostgreSQL 17 database in Frankfurt. It does not create a seller or supply inference credentials, account funds, adoption, or a completed paid acceptance test.

## Provision the host

1. Connect the operator's Render account and select its intended workspace. Check the current creation estimate against the authorized monthly cap, including web compute, PostgreSQL compute and storage, the 1 GB service disk, bandwidth, build minutes, taxes and any additional seller service. No resource has been provisioned merely by committing this Blueprint.
2. Create a Blueprint from `QuantumStonks/ZoKo`, branch `codex/zoko-plugin`, path `render.yaml`. Keep previews and automatic deploys disabled. Deploy a recorded immutable commit after its CI passes. A provider-assigned HTTPS `onrender.com` address is sufficient for first use; a purchased domain is optional.
3. The Blueprint maps Render's assigned `RENDER_EXTERNAL_URL` to `ZOKO_PUBLIC_URL`; confirm the deployed value matches the actual HTTPS origin. If adopting a custom domain, replace that reference with the verified canonical URL. Supply `ZOKO_ADMIN_TOKEN`, `ZOKO_ENCRYPTION_KEY`, and the dedicated `XEC_WALLET_SEED_HEX` through the provider's secret environment. For a **new, unfunded** deployment, `npm run init` generates these locally without printing them; move them through protected secret entry. This helper does not run inside the production image. Never use a personal wallet recovery phrase or replace the seed of an existing ledger.
4. Retain an encrypted off-host backup of the original seed, encryption key, operator configuration and database recovery material before funding. Secret environment persistence and a service disk are not an independent, recoverable backup. Verify a matching database restore in isolation with payments disabled and no second live signer. Follow the coordinated-stop recovery contract in [deployment](deployment.md#backup).
5. Supply `ZOKO_PROVIDER_HOSTS` with only the exact hostname of a real seller endpoint. No wildcard, URL or implicit platform seller is configured. An OpenAI API credential alone cannot be registered as an offer: a real HTTPS service must implement ZoKo's typed decision protocol and invoke the selected model. See [seller onboarding](deployment.md#4-onboard-seller-agents-and-complete-acceptance).
6. Record provider resource IDs, URL, deployed commit and image digest; confirm both live and readiness probes. Run `node dist/src/doctor.js` in the service shell. An empty catalog can have infrastructure readiness; it cannot have trading readiness or paid acceptance.

The database has no public IP allowlist entries and the API uses its private connection string. Render's paid PostgreSQL recovery is separate from wallet-secret recovery; export and protect both. The existing Compose backup helper targets a Compose database container and is **not** a Render backup command. Use Render's PostgreSQL recovery/export facility or an authenticated private-network `pg_dump` client with PostgreSQL 17 tools. Do not weaken the database's external access policy to make a backup convenient.

The API's attached disk enforces a single service instance and prevents overlapping old/new processes during deploys. Render stops the old instance before starting its replacement; brief deployment downtime is expected. The ledger and payment journal remain in PostgreSQL. Do not remove the disk, enable autoscaling, deploy a second signer against the same ledger, or run migrations concurrently with an older worker. The 90-second shutdown allowance covers the application's reconciliation drain. `autoDeployTrigger: off` prevents future branch pushes from silently promoting untested code.

Blueprint `sync: false` values are supplied during initial creation. Render ignores those declarations on later syncs; rotate or add secrets through the existing service's protected environment. Never rotate a funded wallet's seed to resolve an operational error. Source code, deployment logs and committed receipts must contain no credentials or private payloads.

## Register the real seller and buyer

Issue distinct seller-owner and buyer accounts through the operator API. Set the buyer's daily limit, per-decision ceiling and seller allowlist to the authorized acceptance policy. Account ceilings enforce restrictions; they do not themselves grant spending authority. Publish the seller's exact endpoint, model and integer `priceNanos` using its own account, then review and approve the offer as the operator. Keep the endpoint credential outside Git and receipts. The seller bears its actual inference cost and receives proceeds after the configured 10% commission; this setting is not a profitability claim.

Use the emitted plugin CLI to discover the assigned service, inspect its catalog and read the buyer's actual account. Protect credentials in environment variables and journals in an ignored directory with appropriate Windows ACLs. The production container includes the compiled server CLI at `dist/src/cli.js`; the installable plugin includes `runtime/cli.mjs`.

## Acceptance with real funds

Before sending money, freeze a protected acceptance record containing the service origin, exact commit, seller/model, quoted decision ceiling, cumulative XEC cap, withdrawal destination, withdrawal amount, maximum fee reserve and the owner's funding-wallet choice. Retain standing authorization and these limits across recovery. Covered actions do not require repeated human approval. Secret entry or a wallet's own signing prompt can still require the human's action.

Money is an integer string in nanoXEC: 1 XEC = 1,000,000,000 nanoXEC; 1 on-chain atom = 10,000,000 nanoXEC. The minimum withdrawal is 5.46 XEC. The Blueprint preserves the existing maximum withdrawal-fee reserve of 100 XEC. Minimum deposit for one decision and one withdrawal is:

`decision ceiling + withdrawal amount + maximum withdrawal fee reserve`

For a 10 XEC decision and 5.46 XEC withdrawal this is 115.46 XEC. The reserve is a maximum possible debit; unused reserve is refunded after settlement. The funding wallet's own sending fee is additional. Select actual amounts from the approved offer and authorized cap; this illustration is not a live quote or spending authorization.

1. Provision the buyer's real deposit address. Verify its mainnet address and the exact funding amount in the external wallet before signing. Capture the actual broadcast transaction ID.
2. Wait for six confirmations **and** the configured Chronik-reported finality. Read deposit history and account balance. Claim the same deposit again and verify that no second credit appears. A callback or transaction ID alone is not credit.
3. Save one representative, non-sensitive decision input outside Git. Run the plugin's `decide` command with the agreed `--max-price`, approved `--sellers` and explicit private `--journal`. The command persists the quote, account binding, input and idempotency key before execution. Verify one terminal schema-valid result and exactly one charge.
4. Run `recover --journal` on that same original journal. Verify unchanged decision and billing; never generate a new purchase to resolve uncertainty. Include the `.attempt.json` marker in protected recovery material.
5. Request the specified withdrawal to the verified external address with a durable, retained idempotency key. Use the same key and identical body after interruption. Wait for terminal settlement; verify actual transaction, recipient output, fee and external receipt. Do not issue a replacement send after an ambiguous broadcast.
6. Reconcile the buyer's balance/reservations, seller's net proceeds, platform commission and journal audit. Confirm the seller's real inference usage independently. Save a compact sanitized receipt under `.local/`, including transaction IDs, exact amounts, terminal states and artifact hashes. Mark completion only after deposit, paid decision, original-purchase recovery and withdrawal evidence all pass.

Run automated tests for accounting and recovery before promotion, and distinguish them from this mainnet acceptance. Record a failed or indeterminate result honestly. No test fixtures, administrator credits or fabricated model outputs can substitute for real acceptance.

Official references: [Blueprint fields](https://render.com/docs/blueprint-spec), [persistent disk lifecycle](https://render.com/docs/disks#disk-limitations-and-considerations), [specific-commit deployment](https://render.com/docs/deploys#deploying-a-specific-commit), [PostgreSQL backup and recovery](https://render.com/docs/postgresql-backups), and [current pricing](https://render.com/pricing). Recheck the actual resource estimate at creation time.
