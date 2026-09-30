# Typed decision contract

The request is exactly `{ "state": ..., "questions": ... }`. State is text, an object, or an array. Questions is a map of 1–20 labels to question objects. A label is 1–128 characters and cannot be `__proto__`, `prototype`, or `constructor`. Complete input is at most 32,768 UTF-8 bytes and 24 nesting levels. Only finite JSON values are accepted; avoid prototype keys and accessor-bearing objects in programmatic inputs.

Each question has a `type`, optional `instructions` (text/object/array/null), and these criteria:

| Type | Request criteria | Meaning of the answer |
| --- | --- | --- |
| `noul` | Optional/null object with only `true` and `false` descriptions. | `noul` is the probability of the question's true outcome, in `[0,1]`. It is not a boolean or a separate confidence field. |
| `choice` | Required map of 1–255 option labels to text/object/array/null descriptions. | `choice` selects a maximum-probability option; `probabilities` covers every option exactly once; `confidence` is a separate seller-reported value. |
| `score` | Required array of 2–10 text/object/array rubric levels, ordered low to high. | `score` is the expected zero-based rubric index; `legend` reproduces the input rubric; `probabilities` covers every index; `confidence` is seller-reported. |

Mixed types may be requested together. Define the question and criteria from real application requirements; do not fill missing business rules with model guesses. Schema validation constrains representation, not truth.

Quote policies use `maxPriceNanos` as a nonnegative integer string, optional `maxLatencyMs`, `minConfidence`, and `allowedSellers`. The CLI accepts the maximum price as an exact XEC decimal with up to nine places and converts it without floating-point arithmetic. Server-side account policy may impose a stricter budget, seller list, or limit. A quote snapshots its seller/model, payload/schema hashes, price, expiration, and deadline; execution must use the unchanged request.

Result acceptance confidence is the minimum across questions: the seller's `confidence` for Choice/Score and `max(p, 1-p)` for Noul. Thus a confident false Noul result can satisfy a confidence threshold. `accepted` reports whether this threshold was met; it does not certify the answer or the suitability of any downstream action. Schema-valid results are charged even when `accepted` is false.
