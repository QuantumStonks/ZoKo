# Jev provider contract

Zoko invokes the [documented TypeSafe HTTP API](https://docs.typesafe.ai/api):

```http
POST https://api.typesafe.ai/v1/systemone
Authorization: Bearer <TYPESAFE_API_KEY>
Content-Type: application/json
```

The seller endpoint is the complete URL. Configure the host allowlist before enabling a seller. Credentials remain on the server. A decision sends `{state, model, questions}` and receives `{model, answers, usage}`. The supported question types are `noul`, `choice`, and `score`. Noul returns a yes probability, Choice returns a label and distribution, and Score returns a probability-weighted zero-based rubric level. Questions may be mixed in one call.

Pin `jev-1.13.0` for reproducibility. The [model reference](https://docs.typesafe.ai/models) currently maps `jev-latest` and `jev-preview` to that version; aliases can change. Zoko records and validates the returned model ID. Published provider limits are 64k total tokens and 32k for state plus the longest question, with dynamically changing request and token rate limits. Zoko additionally limits the complete input JSON to 32,768 UTF-8 bytes, 20 questions, and 24 levels of nesting. Choices allow 1–255 named options and scores require 2–10 levels. Question and option names are nonempty, at most 128 characters, and cannot be `__proto__`, `prototype`, or `constructor`.

The provider adapter makes one HTTP request. It rejects redirects, enforces a total deadline that includes response-body delivery, and reads at most 262,144 response bytes. An uncertain timeout is terminal; it is never retried automatically. An HTTP error or malformed result is not replaced with a synthetic result. Responses must be JSON with exact answer types and keys, finite probabilities in `[0,1]`, probability totals within `0.0001` of one, a selected maximum-probability choice, and score legends matching the submitted rubric. Expected scores must match their distributions within `0.0001 × max(1, number of levels − 1)`. Tolerance handles floating-point rounding; probabilities are never silently normalized.

Zoko's acceptance confidence is the minimum of the provider's Choice/Score confidence values and `max(p, 1-p)` for each Noul. The Noul measure is **derived**, because TypeSafe returns no independent Noul confidence. [TypeSafe confidence](https://docs.typesafe.ai/confidence) summarizes a model distribution; neither this statistic nor a valid schema proves factual correctness. Validate thresholds against representative labeled records before depending on them.

Keep accounting, fees, budget checks, date arithmetic, and access control in deterministic code. TypeSafe's [published limitations](https://docs.typesafe.ai/model-jaggedness/jev-1.13) include numeric precision, date comparison, adversarial state content, and absent probability identities across independently evaluated questions. Jev makes semantic judgments inside those controls. Provider availability, funded API access, measured latency, and quality on a customer's task require that customer's real credentials and evaluation data; tests use controlled HTTP servers to verify transport and schema enforcement.
