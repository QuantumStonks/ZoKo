# Seller endpoint contract

The marketplace calls the registered full public HTTPS endpoint on port 443 using POST, `Content-Type: application/json`, `Accept: application/json`, and `Authorization: Bearer <seller-issued-endpoint-credential>`. The body has the quoted `model`, buyer `state`, and `questions`. See the sibling [decision contract](../../buy-decision/references/decision-contract.md) for input semantics and limits.

The endpoint must perform the actual requested computation and return 2xx JSON with exactly `model`, `answers`, and `usage`. The model must equal the offered model. Existing `jev-latest`/`jev-preview` compatibility aliases may return a versioned `jev-X.Y.Z`, but a new integration should use its own exact stable identifier. `usage` contains `input_tokens` and `output_tokens` as nonnegative safe integers, representing real usage under that seller's implementation. Answer keys exactly match the question labels.

| Answer type | Exact fields |
| --- | --- |
| `noul` | `type: "noul"`, `noul: p` where `p` is the finite probability of true. |
| `choice` | `type: "choice"`, `choice` as an input option label, `probabilities` for every input option, `confidence` in `[0,1]`. The chosen option must have maximum probability. |
| `score` | `type: "score"`, `score` as the probability-weighted zero-based rubric index, `legend` mapping every index to its original rubric entry, `probabilities` for every index, `confidence` in `[0,1]`. |

All probabilities are finite values in `[0,1]` and sum within `0.0001` of 1. Score expectations match the distribution within `0.0001 * max(1, levels - 1)`. Legends reproduce the rubric exactly. No extra fields, missing options, renamed questions, normalized substitutions, or fabricated usage are accepted.

The server uses its explicit hostname allowlist and rejects private/reserved resolved addresses and redirects. Response bodies are limited to 262,144 bytes. Execution deadlines include body delivery. One admitted decision produces one endpoint request; ambiguous timeouts are not retried by the marketplace, and synthetic fallback answers are forbidden. Design the service's deadline and resource budget accordingly.

Offer registration fields:

- `id`: 1–64 lowercase letters, digits, underscores or hyphens; starts with a letter or digit.
- `name`: nonblank, at most 120 characters.
- `endpoint`: the actual complete public HTTPS URL, at most 2,048 characters, without embedded credentials or a fragment; server hostname policy applies.
- `apiKey`: seller-issued endpoint credential, 1–4,096 characters, transmitted privately to the configured marketplace and never returned in offer listings.
- `model`: exact nonblank identifier, at most 100 characters.
- `priceNanos`: positive integer string with at most 30 digits. One XEC is `1000000000` nanoXEC.

The authenticated ordinary account is the immutable seller owner and payout account. Registration starts unapproved. Seller updates accept only `priceNanos`, `apiKey`, and `paused`. Operator `enabled` and seller `paused` are independent; availability also requires an active owner. Response fields include `commissionBps`, the current rate in basis points; quotes snapshot their rate.

A schema-valid success charges the buyer even below the requested confidence threshold. The seller receives its quoted proceeds after commission in the server's ledger. Failed/indeterminate execution releases the buyer reservation while the seller may still have incurred compute cost. Do not treat self-reported confidence, a listed offer, or a healthy probe as evidence of realized earnings or task quality.
