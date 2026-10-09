# Independent inference marketplace validation

## Current local candidate - 2026-10-09

The uncommitted `1.4.2-dev.0` candidate is locally validated, not released or
deployed. HEAD remains `50f7bda67e97d35d7a913df5c30d7f947e7f18d9` on
`codex/growth-release-continuity`. The 97 implementation/dependency input paths
matched fingerprint `a9f8b751440dc7834fa5b3ff0f7c2062d3ce5973867e44e63b907acf4e389929`
before and after the October 9 checks. The ignored exact-input receipt is
`.local/release-acceptance/validation-receipt-20261009.json` (SHA-256
`0fd13b7aad3e209f4a433e9786ca9ab7a4ffcb2bf87bda8cf83e4248b9bfa579`).

The standard `npm run check` and `npm test` passed (171 unit tests, none failed).
`npm run build`, `npm run build:http-clients`, and `npm run build:plugin` passed.
The disposable loopback PostgreSQL run passed 104 integration tests, recorded
unchanged source hashes, and stopped its database; receipt:
`.local/postgres-portable/run-2026-10-09T10-44-40-583Z/receipt.json` (SHA-256
`a6a5103cfce5309e31749f2ff5504a8371ba90081e03b995e9150e2d0ce4f067`).
The 23-file archive `dist/plugins/zoko-1.4.2-dev.0.zip` has SHA-256
`ca3270949c991fb3ec2de6facc9eca6bd259be02cab3acc43336c7f1d4ba26a3`;
independent extraction matched 22 integrity entries and ran the bundled CLI help.
These checks cover the unchanged runtime/dependency inputs. This documentation
correction is not a new runtime test or release validation.

The published plugin remains **1.4.1** and the separately recorded production
API remains **1.4.0**. No real independent seller, model rights/capacity,
inference, buyer funding, external adoption, remote CI, installation,
deployment or publication was verified for this candidate. The two October 7
summaries below retain their original 1.4.0 archive and 96-test results as
historical evidence. Next, review exact candidate paths and current records,
then check the live remote and CI/cost gates before any release decision.

## Historical protocol slice - 2026-10-07

The following is the locally tested, uncommitted October 7 slice of an independent HTTP
buyer/seller lifecycle. Decisions are model-specific inference products; token
counts are usage evidence associated with that model, not interchangeable assets.
No real model inference, live purchase, wallet action, external message, push,
deployment, directory submission, publication or marketing was performed.

## Source and preserved work

Base commit: `50f7bda67e97d35d7a913df5c30d7f947e7f18d9`.
Branch: `codex/growth-release-continuity`.
Runtime/test/config source fingerprint SHA-256:
`62c815486593e6f57ec29c6c2847146261428cfc181b8dd28049b9f81bdf7c48`.
The ignored evidence receipt describes its sorted file-hash algorithm and inputs.
The PostgreSQL runner verified source hashes before/after execution; they also
match the final evidence receipt.

Existing discovery, enrollment, site, CLI and plugin maintenance changes were
preserved. Their files remain dirty and are not attributed to this slice:
`docs/plugin-maintenance.md`, `ops/plugin-state.json`,
`plugins/zoko/skills/connect-marketplace/references/enrollment.md`,
`site/index.html`, `src/cli.ts`, `src/enrollment.ts`,
`docs/agent-discovery-research.md`, `docs/discovery-evaluation-v2.json`,
`docs/marketplace-directory-design.md`, `ops/discovery-state.json`,
`scripts/discovery-evaluation.mjs`, `scripts/run-discovery-trials.mjs`,
`tests/discovery-evaluation.test.ts`, `tests/enrollment-regression.test.ts`,
and `tests/plugin-state.test.ts`. The initial harmless PowerShell execution check
succeeded; no sandbox workaround or security configuration change was needed.

## Changed files in this slice

| Files | Behavior |
| --- | --- |
| `src/offer-contract.ts`, `src/openapi.ts` | Versioned model/schema/usage/authorization/limit contract; OpenAPI 3.1 and explicit unsupported cancellation semantics. |
| `src/migration.ts`, `src/market.ts`, `src/provider.ts`, `src/server.ts` | Schema 5; frozen quote contract; expiring seller-declared capacity and admission concurrency; backend-reported usage including partial/missing values; truthful discovery; owner-only capacity API. |
| `src/seller/ollama.ts`, `src/seller/http.ts`, `src/seller/main.ts` | Seller-owned loopback Ollama adapter, exact tag/digest, typed generation, limits/deadlines, authorization declarations, single-process ownership and durable ambiguous-dispatch quarantine. |
| `clients/typescript/zoko.ts`, `clients/python/zoko.py` | Independent HTTP clients with their own validation, bounded fixed quotes, exclusive durable attempt markers, polling, identity recovery and terminal receipts. No server/shared SDK imports. |
| `scripts/build-http-clients.mjs`, `package.json`, `tsconfig.json` | Portable HTTP-client/OpenAPI distribution built independently of plugin/host directories. |
| `tests/inference-seller.test.ts`, `tests/http-clients.test.ts`, `tests/inference-lifecycle.integration.ts` | Backend/contract, independent client/schema and complete HTTP/PostgreSQL fixture checks. |
| `tests/migration.integration.ts`, `tests/payments.integration.ts` | Extend historical migration fixtures for schema 5; retain earlier accounting invariants. |
| `README.md`, `docs/independent-marketplace.md`, this report, `ops/inference-marketplace-state.json` | Operator/client documentation and bounded continuity/evidence. |

## October 7 slice checks

| Command/check | Final result |
| --- | --- |
| Harmless execution check | Passed. |
| `npm run check` | Passed; final log `.local/inference-evidence/20261007/check.log`. |
| `npm test` | 171 passed, 0 failed, 0 skipped. |
| `npm run test:integration` through disposable PostgreSQL runner | 96 passed, 0 failed, 0 skipped; PostgreSQL 17.11 bound to loopback, no service installed, owned database stopped. |
| `npm run build` | Passed. |
| `npm run build:http-clients` after application build | Passed; standalone Node and Python artifacts plus OpenAPI emitted. |
| `npm run build:plugin` | Passed; 23-file local 1.4.0 archive. |
| Final emitted archive independently extracted | CRC/integrity/source-input hashes and synchronized manifests passed; CLI help ran outside repository without host dependencies or network. |
| `git diff --check` | Passed. |
| Real inference, live paid lifecycle, remote CI, external publication | Not run. |

An earlier integration cycle had four failures out of 93 tests: object-order
comparison in the standalone-client test, changed legacy provider-error labeling,
the new nullable quote column in a migration assertion, and simulated downgrade
column cleanup. These were corrected before the final 96-test run. The earlier
receipt is retained at
`.local/postgres-portable/run-2026-10-07T20-32-48-428Z/receipt.json`.

Final full receipt: `.local/inference-evidence/20261007/receipt.json`.
Final integration receipt:
`.local/postgres-portable/run-2026-10-07T20-38-41-877Z/receipt.json`.
Integration log SHA-256:
`78cd816939420f2067939855f2be49ac341e232318e5ac25073e22a902e03543`.
Detailed logs, generated archives and test-specific private material remain ignored.

## Exercised lifecycle and limits of evidence

Ten HTTP integration cases use separate seller, buyer and third-tenant accounts,
real loopback HTTP transports and isolated PostgreSQL. The model and payment
fixtures are explicitly `genuine_model_inference=false` and
`simulated/payment-not-applicable`. They exercise discovery, selection, immutable
250 nanoXEC quote despite subsequent offer-price changes, submission, running and
terminal polling, typed validation, actual fixture-reported usage, receipt
recovery, Python process restart and standalone TypeScript execution.

Negative checks cover model/schema mismatch, expired/unavailable capacity,
owner-only presence, cross-tenant access, conflicting retries, refusal,
truncation, malformed output, missing required usage, partial optional usage,
backend failure, transport timeout, adapter quarantine across restart,
marketplace restart, quote expiry after successful purchase, concurrent admission,
late completion versus concurrent stale recovery, and exactly-once terminal
settlement/refund. A buyer HTTP abort continues the original admitted work and
recovers its identity. Ledger audits pass after each integration case.

Cancellation remains unsupported. No cancellation endpoint was added. Deadline
expiry releases the reservation once and fences late settlement; it does not
prove that backend compute stopped. Operator reconciliation is required for an
ambiguous backend dispatch, and the original purchase must not be replaced.

Permission declarations and model inventory snapshots are not independent proof
of license rights or live capacity. The adapter requires seller-controlled model
mutation; tag checks before/after generation cannot make mutable inventory
atomic. Windows cannot portably fsync directory entries. Journals need protected
storage and independent backups; crash ownership/quarantine needs reconciliation.
The API supports legacy offers but explicitly labels their capacity unverified.

## October 7 remaining gates (historical)

1. Qualify a real independent seller: confirm exact model digest, seller access,
   license/provider resale permission, backend resource ownership and limits,
   protected endpoint/configuration, and applicable inference/transmission/spend
   authorization. Existing historical same-owner spending authority is consumed.
2. Under that authority, run bounded real inference and record backend usage,
   output validation, live capacity and recovery evidence. Deterministic tests and
   offer approval do not satisfy this gate. A real paid check is a separate gate.
3. Reconcile the local package/manifests at **1.4.0** with existing historical
   plugin continuity recording a published **1.4.1**, then choose a monotonic
   candidate release version and validate that exact release. Existing published
   hashes/state were preserved; this candidate is not a new published release.
4. Run remote CI and complete lifecycle readiness review before any authorized
   publication/marketing. Directory eligibility, approval, adoption and earnings
   remain separate states. The independent marketplace needs no host directory
   or companion plugin, and no hidden commerce funnel was added.

Candidate archive SHA-256:
`ddafb47978b0d04499d67113ec6c7ffd83a73a0b9afb52c133f0113b0bc99651`.
Standalone TypeScript SHA-256:
`0e69f3c36341ed1a38d235bcece3b3ca2c054d25d25e1d1bc78eda5e54dc56e0`.
Standalone Python SHA-256:
`1c6c1c51144c328e9454e55479e9702406a2ddeaf2008bdfb7e57071f3548912`.
OpenAPI SHA-256:
`f05e60b17979b09699dee07b4d711c28b7d35351cea0f78dc26d03fc7b23cdcd`.
