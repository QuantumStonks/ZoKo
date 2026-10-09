# Independent model-specific inference lifecycle

The unpublished development candidate in draft PR #14 adds `zoko.marketplace/1`,
`zoko.inference-offer/1`, and an OpenAPI 3.1 buyer/seller contract at
`/v1/openapi.json`. It has not been merged, deployed, installed, submitted to a
directory, or marketed. ZoKo is the intermediary;
independent sellers operate and pay for their inference backends. Decisions are
outputs of inference. A model's token usage is evidence about that execution,
not an interchangeable asset or a price unit shared with other models.

The HTTPS API works without Codex, a plugin, or a host directory. Public discovery
is `/.well-known/zoko.json`, `/v1/capabilities`, and `/v1/catalog`; these requests
send no account key. Account keys are required for quotes, execution, receipts,
and owned seller operations. Funding, withdrawals, and operator approval remain
separate, authorized operations. No companion plugin obscures this commerce flow.

## Contract and availability

New contracted HTTPS offers carry an immutable model identity, backend name,
supported question types, UTF-8 input/output byte ceilings, output-token ceiling,
concurrency, deadline, and explicit usage requirement. Model/schema and required
usage policies filter selection. Quotes freeze the contract, model, input/schema
hashes, price, recipient, commission, and deadline. A later seller price change
cannot change an existing quote or purchase. Tokens never alter its fixed price.
Standalone buyers accept `jev-latest` and `jev-preview` resolving to a
`jev-X.Y.Z` result only for legacy uncontracted offers, matching the server's
existing rule. Contracted offers require the exact quoted model identity.

Authorization requires `sellerAuthorized: true`, `resalePermitted: true`, a basis
of `owned_weights_license` or `provider_agreement`, and an opaque evidence
reference. These are seller attestations, not marketplace legal verification.
Keep actual agreements private. Subscription access alone does not establish
resale permission. Operator review must verify permission where applicable before
approval; software cannot manufacture it.

`POST /v1/seller/offers` registers an owned offer, disabled pending approval. A
seller renews its capacity with `POST /v1/seller/offers/{id}/capacity` and
`{"ready":true}` only while its adapter and authorized backend can accept work.
The declaration expires after 120 seconds. `{"ready":false}` withdraws it.
Admission checks expiry and running purchases under the seller lock, enforcing
the contract's concurrency. Renewing presence, registering, approving, and
installing a plugin do not prove live inference capacity. Catalog `available`
means routing eligibility; `capacityEvidence` states its provenance. Existing
legacy offers retain compatibility and are explicitly capacity-unverified;
they cannot satisfy a required backend-usage policy without a new contract.

## Reference seller: controlled local Ollama

The adapter uses the local [Ollama chat API](https://docs.ollama.com/api/chat),
[model inventory](https://docs.ollama.com/api/tags), and
[structured output schemas](https://docs.ollama.com/capabilities/structured-outputs).
It accepts only a numeric loopback HTTP backend origin controlled by the seller.
It does not pull a model, create credentials, use a cloud subscription, call a
host agent, retry inference, or select a fallback model. The marketplace calls
the seller-owned HTTPS endpoint; local backend access remains inside the seller's
infrastructure. Ollama Cloud is outside this adapter's supported scope.

After `npm run build`, run `node dist/src/seller/main.js`. Supply
`ZOKO_SELLER_CONFIG` as a protected JSON file path and the existing seller-issued
`ZOKO_SELLER_ENDPOINT_KEY` through protected environment configuration. The latter
is distinct from the marketplace account key. The listener binds loopback port
8090 (or `ZOKO_SELLER_PORT`); put it behind seller-owned HTTPS/TLS. The production
marketplace retains its endpoint allowlist and public-address checks.

The config is defined by `OllamaSellerConfigSchema` in `src/seller/ollama.ts`:
`backendUrl`, exact `backendModel` tag, 64-character hex `modelDigest`,
`marketplaceModel`, full `contract`, and protected absolute `dispatchDirectory`.
Contract `backend` is `ollama`; `modelIdentity` must be
`ollama:<backendModel>@sha256:<modelDigest>`. Limits must reflect the seller's
measured model/context/resource capabilities, not arbitrary promises. The
marketplace offer's `model` must equal `marketplaceModel` and its contract must
equal the adapter's contract. Use a new offer to change either identity.

Before dispatch and after completion the adapter verifies the tag digest against
inventory. The seller must exclusively control model-tag mutation during jobs:
two inventory snapshots are not atomic proof of the weights used between them.
The chat response must identify the exact configured backend model, report
`done=true` and `done_reason=stop`, fit all limits, and validate every Noul,
Choice, or Score answer, probabilities and Score legend. Refusal, truncation,
malformed JSON, mismatched models/schemas, transport errors and deadline expiry
fail delivery. Confidence/probabilities are model judgments, not calibrated
accuracy. No correctness claim follows from schema validity.

Only `prompt_eval_count` and `eval_count` supplied by Ollama become
`input_tokens`/`output_tokens`. An optional-usage offer preserves either reported
count and marks only its missing counterpart `null`; both missing becomes
`usage:null`. Required usage rejects either missing count. Negative,
fractional, over-limit, or unsafe integer counts fail. The marketplace receipt
keeps `usageEvidence.actual` separate from `estimate: null` and lists missing
usage explicitly. This evidence is seller/backend-reported, not independently
metered by the marketplace. Active-agent legacy usage remains unavailable.

The adapter records a durable dispatch before calling chat. A transport failure,
timeout, or incomplete response quarantines capacity across restarts. It cannot
assume an HTTP abort stopped model generation. Dispatch records contain IDs and
identity, never prompts or secrets. A complete backend envelope permits an
immutable terminal record even when its answer is invalid. For unresolved work,
an operator must establish that the original local backend job has stopped
before recording a matching `<dispatch-id>.terminal.json` with `id`, `version:1`,
`backendCompleted:true` and the observed completion time. Do not delete a
dispatch to make capacity look healthy. Automated reconciliation with backend
job identifiers is a future slice; Ollama chat provides no durable job lookup.

An atomic `.adapter-owner` directory excludes multiple adapter processes using
the same dispatch directory. Graceful close releases ownership; a crash leaves
it blocked. Before removing a stale ownership gate, establish that the original
adapter is stopped, reconcile its backend dispatches, and retain their records.
There is no automatic lock stealing or inference replay. Different adapters for
one backend still require seller-controlled resource isolation and accurate
aggregate capacity limits.

## Independent buyers and durable recovery

Python 3.11+ uses `clients/python/zoko.py` with only the standard library. Node
24 uses `clients/typescript/zoko.ts`, or the standalone emitted `zoko.mjs`.
`npm run build:http-clients` after `npm run build` emits both clients, their
OpenAPI JSON, documentation and license to `dist/http-clients`. Copy this folder
to another directory; no server/shared SDK code or plugin installation is needed.

Construct `ZokoHttpClient` with the user-selected HTTPS marketplace origin and
existing account key. Discover, read the catalog, select a model and seller, and
pass `model`, `allowedSellers`, `maxPriceNanos` and, when needed,
`usageRequirement: "backend_reported_required"` to `prepare`. The limit must come
from actual spending authorization; a funded balance is not authorization.
`prepare(journalPath, input, policy)` quotes without purchasing. It writes a new
exclusive journal binding origin, account, exact quote, task, policy and key.
Use protected storage outside source control; parent directories must already
exist. Do not prepare a replacement for an unresolved purchase.

`execute(journalPath)` writes an exclusive attempt identity before submission.
It does not automatically retry a transport failure. Explicit
`recover(journalPath)` resubmits the original quote/input/idempotency key; the
server returns the existing purchase and never dispatches its backend again.
`poll(journalPath, decisionId, maxWait)` reads that purchase until terminal or the
bounded polling window ends. The window limits further polls; an in-flight HTTP
request has its own transport timeout and may finish after that window. Neither
timeout cancels marketplace inference. Clients preserve the decision ID and immutable
terminal receipt beside the journal, validate typed output, and reject account,
marketplace, bounded-price and attempt conflicts. An expired quote already used
by the original purchase is still recoverable with its original identity.

TypeScript also validates request/schema hashes using the marketplace's JSON
canonicalization. Python retains the received hashes and checks receipt equality;
it relies on server frozen-input validation because Python/ECMAScript number
canonicalization differs. Python and TypeScript journals are owned by their
respective clients; do not interchange their attempt markers. Both clients
validate model-specific results, probability distributions, legends and actual
usage without importing server validators.

Journals are fsynced before dispatch. POSIX also syncs their parent directory;
Node/Python on Windows cannot portably fsync directory entries. This is a
power-loss durability limitation, not evidence of exactly-once network delivery.
Preserve journals and receipts in independently backed-up protected storage.

## Cancellation, deadlines and accounting

Cancellation is **unsupported** in this version; there is no cancellation route.
Buyer HTTP abort, client poll expiry, seller transport abort, and backend stopping
are different events. A disconnected buyer must recover the same identity.
The marketplace continues admitted work after the client disconnects.

Only a schema-valid contracted result completed inside the terminal deadline
captures the immutable quote, including a low-confidence result. Failure releases
the reservation. Expired execution becomes `indeterminate` and releases it once;
this does not prove upstream compute stopped or erase the original purchase.
Database row locks and unique journal references fence late completion and
duplicate refunds. A subsequent real cancellation implementation must specify
pre-dispatch versus dispatched behavior, backend stop evidence, race precedence,
durable intent, idempotency, and exactly-once accounting before adding a route.

## Readiness boundary

Deterministic test fixtures prove protocol, persistence and simulated accounting
only: `genuine_model_inference=false`, `simulated/payment-not-applicable`.
A real-inference check still requires an existing authorized backend, model/resale
permission, input-transmission authority, and applicable spending permission.
The completed historical same-owner test supplies none of those for this slice.
Independent seller supply, current capacity, model quality and live paid delivery
remain separate readiness gates. Complete the lifecycle checks and permission
review before publication or marketing.
