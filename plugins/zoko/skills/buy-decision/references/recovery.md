# Purchase recovery and integration

Treat one business action as one durable purchase identity. Before dispatch, persist the canonical marketplace URL, account ID, original quote and input, and idempotency key. Never include an API key in that record. Journals may contain private task data; place them in protected local storage outside the installed plugin and Git. Preserve them through handoffs until the outcome is reconciled. A POSIX `0600` mode does not configure Windows ACLs.

The bundled CLI creates a journal exclusively and flushes it before purchase dispatch. `quote --journal FILE` creates a reviewable prepared purchase without executing it. `execute --journal FILE` purchases that exact quote; `recover --journal FILE` resumes it. Immediately before paid dispatch, the CLI exclusively creates and flushes `FILE.attempt.json`, recording the original marketplace, account, quote, and key. Preserve both files unchanged through handoffs and until reconciliation. The marker establishes a possible attempted dispatch, not successful payment; never delete it to make an unresolved purchase appear new. The `purchase_prepared` event includes `dispatchMarker`, which points to the future marker during quote preparation.

New version-2 journals pin marketplace and account identity, so switching credentials to a different account is not a recovery method. Legacy version-1 journals lack an account ID; preserve their original credential and rely on the server's original quote ownership checks. `decide` is a new purchase operation, not recovery.

The client sends at most one logical purchase. While the HTTP result is uncertain it retries the original POST with the same idempotency key and unchanged payload. Once a decision ID is returned, it polls that ID. It never obtains another quote as transport recovery. The marketplace separately prevents a second seller inference after an ambiguous execution. A failed or indeterminate terminal decision releases the reservation under the marketplace contract, although the seller may already have incurred costs.

CLI exit meanings:

- **0**: command completed, including a terminal decision failure. Inspect the JSON `status`, `accepted`, and result.
- **1**: command/API rejection. This is not proof that an earlier dispatch never occurred. Read the error before changing anything; permission, payload, quote expiry, and idempotency conflicts need different remedies. Preserve and reconcile the original purchase.
- **2**: `AmbiguousDecisionError`; original quote/key and any known decision ID are reported. The purchase remains unresolved. Preserve the journal and dispatch marker and recover the same identity. A prior marker preserves uncertainty across process restarts, including when account authentication or availability prevents reconciliation.

Do not automatically buy again on low confidence, terminal failure, unavailable seller, connection loss, or an empty result. A new attempt is a distinct spend and requires authorization within the user's existing policy.

For application integration, import the bundled `ZokoClient` and `AmbiguousDecisionError`, validate input with the bundled `DecisionInputSchema`, call `quote`, durably persist its identity and request, then call `execute(quote.id, input, idempotencyKey)`. Bound `requestTimeoutMs`, `maxWaitMs`, and `pollIntervalMs` to the application. Preserve the receipt and original durable record when a process stops. Generic `request` does not retry writes and does not supply purchase recovery automatically.
