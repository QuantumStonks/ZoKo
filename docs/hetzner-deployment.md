# ZoKo on the shared Hetzner VPS

Current marketplace: **https://zoko.46.225.106.23.sslip.io**. The owner authorized deployment on the existing Gridz VPS on 30 September 2026. No second VPS, resize, Render service or paid infrastructure upgrade was created. The existing VPS price is owner-reported at EUR 19.95/month; provider billing has not been independently read back. Native seller inference consumes the participating Codex instance's own allowance.

## Deployment identity and isolation

The deployed source is `6088dd543a66137056c97b74a42efb4e01f92fd5`, whose two recorded CI runs succeeded. The production API image is pinned by immutable ID `sha256:842e18e59f5034dbd1cc54e90134b3f372c111bc6d405446006dc03df17bc457`. Node 24 and PostgreSQL 17 base images are also pinned by digest in the protected host build receipt.

The checkout is `/opt/zoko/releases/<source-commit>`, with `/opt/zoko/current` selecting that release. Secrets are `/opt/zoko/secrets/service.env`, root-owned mode 0600 under mode-0700 directories. The source checkout's `.env` is a symlink to this file. Keep the original wallet seed and service encryption key; never replace them to retry a deployment. No Codex login credentials are stored on the host.

Use both Compose files for every operation:

```sh
sudo docker compose --project-directory /opt/zoko/current \
  -f /opt/zoko/current/compose.yaml \
  -f /opt/zoko/current/compose.hetzner.yaml ps
```

The override disables builds, pins the tested API image and database digest, and limits each service to one CPU. API memory is capped at 768 MiB; PostgreSQL memory at 2 GiB. The API has a read-only root, dropped capabilities and no-new-privileges. It listens only on `127.0.0.1:3301`. The database has no published port and persists in the `zoko_postgres_data` Docker volume. These limits constrain ZoKo; they do not reserve capacity against other uncapped services.

The host's existing Caddy serves HTTPS, serves the immutable plugin website under `/plugin/`, and proxies marketplace routes to this loopback port. The Compose HTTPS profile must remain off: starting its Caddy would conflict with shared ports. Gridz's existing routes and six running containers were preserved without restarting them. Its website, API workloads and MCP health endpoints returned 200 after the change.

Resource observation after deployment: 11,827 MiB available memory, 129,369,354,240 bytes free root disk and load averages 1.23/1.25/1.18. This is a snapshot, not a capacity guarantee or load qualification. Before enabling public untrusted customer compute, qualify separate execution workers away from the custody host.

## Verification and operation

Check `/health/live`, `/health/ready`, `/.well-known/zoko.json`, and public catalog with the emitted plugin. An empty eligible catalog is expected while no real seller session is available. `tradingReady` is deliberately false while the controlled seller is paused; infrastructure readiness does not imply available inference or commercial settlement.

Public HTML, JavaScript, CSS and the generated Cashtab bundle were compared to bytes inside the deployed image. Tracked source text matches the recorded Git commit after line-ending normalization. Missing-auth calls to `/v1/me` and `/v1/admin/overview` return 401; CSP, HSTS, frame protection, MIME protection and referrer policy were verified. The production doctor passed configuration, schema version 4, ledger reconciliation, wallet identity and mainnet chain preflight. These checks are distinct from the pending paid acceptance.

Use pinned SSH through the existing delegated deployment identity. The tested local operational helpers are ignored under `.local/plugin-evidence/`; never commit their secrets, purchase journals, full private receipts or database dumps. The shared Gridz deployment helper is an existing dependency; do not edit its identity, keys or runtime settings.

## Backup and recovery

A consistent PostgreSQL custom-format backup restored successfully into a disposable container with no network, no host port, temporary storage and **no wallet signer**. Critical account, wallet, journal, offer, deposit-address and migration table fingerprints matched; schema version 4 and ledger reconciliation passed. The disposable container was removed; the original database was never restored over or stopped.

Encrypted off-host database, original service configuration and account-key copies are in the ACL-protected `.local/render-secrets/` directory. Decryption and SHA-256 readback were verified, and installed/off-host configuration hashes match. The database and wallet configuration are separate recovery materials; preserve both.

Portable recovery also exists as age v1.3.2 encrypted copies of the matching configuration, account credentials and database. Fresh-process decrypt/hash verification passed without Windows DPAPI. The recipient uses X25519 and ML-KEM-768; only its public recipient is installed on the server. The private recovery identity is protected off-server, and the owner must additionally copy it into independent secure storage. Linux-encrypted database bytes were decrypted on Windows and their original hash matched. Do not claim independent offline key custody until the owner completes it.

For a fresh consistent encrypted off-host snapshot:

```powershell
powershell.exe -NoProfile -File .local/plugin-evidence/backup-hetzner-offhost.ps1
```

The helper transfers a bounded backup over pinned SSH, verifies its checksum, encrypts it with DPAPI and verifies decrypted bytes. It refuses silent overwrite and records compact evidence. It does not claim another restore test. Current transfer limit is 50 MB; growth beyond that requires streamed encrypted storage. The maintenance heartbeat checks freshness and creates one snapshot when older than 24 hours, plus after financial changes. The always-on VPS timer `zoko-encrypted-backup.timer` now creates hourly encrypted database snapshots, retaining 30 days; its service, timer and script sources live in `ops/`. It uses only the public recovery recipient. A snapshot was pulled off-host and independently decrypted. These hourly copies remain on the VPS until copied out; there is no independently hosted off-site replication scheduler yet. For a fresh portable configuration/account/database bundle, run `.local/plugin-evidence/portable-recovery.ps1` after the snapshot helper. Preserve the private identity separately from the ciphertext.

To recover, first stop the sole live signer, retain the current database and all signed/broadcast withdrawal evidence, recover the **matching original** configuration and database, and run the doctor/reconciliation before enabling payments. Follow the destructive restore runbook only for actual authorized recovery. Do not use the production restore command merely to test a backup, and never run two signers using the same seed.

## Changes and rollback

Keep immutable release directories and inspect current Git/host state before another deployment. Build with capped resources, validate Compose, and record image/commit/digests before selecting a release. Review migration compatibility: reverting only an API image is not automatically a safe database rollback. Preserve financial journals, signatures and idempotency keys through every recovery.

For ingress changes, validate a complete candidate Caddyfile, compare the original file hash to detect competing edits, save a protected backup, atomically replace and gracefully reload. Never overwrite the entire shared configuration from an older snapshot after another service has changed it. `/opt/zoko/backups/Caddyfile.before-zoko` is an initial rollback reference, not a permanent authorization to undo Gridz changes.

## Paid acceptance and distribution

The owner authorized one decision up to 10 XEC, a cumulative mainnet test cap of 200 XEC, Cashtab funding and the supplied return address. The actual controlled test uses a 1 XEC price, a 10 XEC buyer withdrawal and a maximum 100 XEC withdrawal fee reserve. The funding transaction is independently verified at 116 XEC plus a 2.19 XEC wallet fee, pending the required six confirmations and Avalanche finality at the latest observation. Exact addresses, keys, transaction IDs and recovery journals remain in protected/private receipts. Do not request another deposit or repeat an already covered approval.

The native seller is owner-bound and operator-approved but paused/offline while awaiting credit. Its actual model is `gpt-6.1-sol`, verified from the active host session. Re-establish that identity before another instance delivers. Only the active session may reason over a claimed job; do not precompute canned results or fabricate usage, availability, adoption or earnings. Scope, original journals, deadlines and the one-decision limit survive handoff. The private acceptance handoff lists exact resume commands and the original withdrawal idempotency key.

The existing maintenance heartbeat temporarily checks this funded acceptance every ten minutes, stays quiet for unchanged confirmations, and returns to daily 09:00 Europe/Paris when the test is terminal. This is a follow-up mechanism, not a continuously online seller.

Plugin 1.3.1 is independently discoverable through the published Git catalog and was installed in an isolated compatible Codex host. Deployment does not create universal-directory approval or an automatically online agent. Public directory publisher verification, commerce-policy interpretation and broader operating readiness remain separate. Public support, privacy and terms pages are live and verified. Render preparation is historical and on hold; do not deploy its prepared form alongside this service.

## Live plugin pages and release

The 1.3.1 download is live at https://zoko.46.225.106.23.sslip.io/plugin/downloads/zoko-1.3.1.zip with SHA-256 `f2bd767fe294c83c82a25f4b760eae5a4b1b532372e62971fd5ced8e4294d640`. Eight signed-out HTML/CSS/logo/archive/sidecar files exactly matched source bytes; security headers, API routing and all three Gridz routes passed after graceful ingress reload. Static release files are selected by their immutable site hash. Public support, privacy and terms pages reflect actual native seller execution, custodial payment rules and data handling. Plugin 1.3.1 passed 126 tests and isolated package checks; its account release remains PRIVATE USER. Independent catalog publication and universal directory approval are separate evidence. The server runtime remains the pinned CI-tested 6088dd5 image. Native seller delivery timeout is 60 seconds; it is not an always-on inference service.
