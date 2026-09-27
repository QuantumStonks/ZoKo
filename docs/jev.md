# Seller agent endpoint contract

Zoko purchases typed decisions from independently operated seller agents. Each seller hosts its own service, chooses its own implementation and price, and bears its compute costs. The marketplace enforces the request and response contract, buyer budgets, settlement and commission. It does not provision a platform model or an inference subscription.

The wire format is compatible with the [TypeSafe SystemOne API](https://docs.typesafe.ai/api). The protocol identifier `typesafe-systemone-v1` describes that JSON format; it does not select the seller's implementation. The executable schemas are in [`src/protocol.ts`](../src/protocol.ts) and [`src/provider.ts`](../src/provider.ts).

## Publish an offer

An operator first issues the seller its own Zoko account and adds the reviewed endpoint's exact hostname to `ZOKO_PROVIDER_HOSTS`. The seller authenticates with that account key and submits `POST /v1/seller/offers` with `id`, `name`, `endpoint`, `apiKey`, `model` and `priceNanos`. The endpoint is a complete public HTTPS URL on port 443. The seller supplies an endpoint credential that Zoko will use when buying a decision; it is distinct from the seller's Zoko account key.

Ownership is assigned from the authenticated account, and the new offer remains disabled until the operator approves it. Sellers can list their own offers with `GET /v1/seller/offers` and change only `priceNanos`, `apiKey` and `paused` through `PATCH /v1/seller/offers/:id`. A different endpoint, model or owner requires a new offer. Offer responses omit credentials and include ownership, approval, pause state and the configured commission. The [deployment guide](deployment.md#4-onboard-seller-agents-and-complete-acceptance) shows the exact registration body and approval sequence.

## HTTP request and response

For an admitted purchase, Zoko makes one request to the offer's stored endpoint:

```http
POST /decide HTTP/1.1
Host: agent.example.com
Authorization: Bearer <seller-issued-endpoint-credential>
Content-Type: application/json
Accept: application/json
```

The hostname and path above illustrate an agent-owned endpoint. The request body contains the quoted model identifier and the buyer's state and questions:

```json
{
  "model": "support-router-v1",
  "state": { "message": "My parcel arrived with a broken screen." },
  "questions": {
    "damaged_item": {
      "type": "noul",
      "instructions": "Does the message report that a delivered item is damaged?"
    }
  }
}
```

A successful endpoint returns HTTP 2xx, `Content-Type: application/json` and the complete typed result. This illustrates the response shape; an actual seller must return its computed result:

```json
{
  "model": "support-router-v1",
  "answers": {
    "damaged_item": { "type": "noul", "noul": 0.98 }
  },
  "usage": { "input_tokens": 42, "output_tokens": 3 }
}
```

The top-level fields are exactly `model`, `answers` and `usage`. Usage values must be nonnegative safe integers. The returned model must match the offered model; the existing `jev-latest` and `jev-preview` compatibility aliases additionally accept a versioned `jev-X.Y.Z` response. A stable, versioned model identifier makes a seller's offered behavior easier to evaluate. Answer keys must exactly match the submitted question keys.

| Question | Required answer fields and meaning |
|---|---|
| `noul` | `{"type":"noul","noul":p}` gives a probability between 0 and 1 for the question's true outcome. Optional request criteria describe the true and false outcomes. |
| `choice` | `type`, `choice`, `probabilities` and `confidence`. The probability map contains every requested option exactly once; `choice` selects a maximum-probability option. |
| `score` | `type`, `score`, `legend`, `probabilities` and `confidence`. Probability keys are zero-based rubric indexes, the legend reproduces each submitted rubric entry, and the score equals the probability-weighted index. |

Mixed question types are supported in one request. The complete input JSON is limited to 32,768 UTF-8 bytes, 20 questions and 24 levels of nesting. Choices allow 1–255 named options and scores require 2–10 rubric levels. Question and option names are nonempty, at most 128 characters, and cannot be `__proto__`, `prototype` or `constructor`.

## Validation, billing and failure behavior

Responses must have exact fields and answer types, finite probabilities in `[0,1]`, probability totals within `0.0001` of one and score legends matching the submitted rubric. Expected scores must match their distributions within `0.0001 × max(1, number of levels − 1)`. Tolerances handle floating-point rounding; probabilities are never silently normalized.

Endpoint hostnames are explicitly allowlisted, and the actual outbound connection rejects private and reserved addresses after DNS resolution. Redirects are rejected. The adapter reads at most 262,144 response bytes and enforces the total execution deadline, including body delivery. It makes one HTTP request per admitted decision. It never substitutes a synthetic answer for an HTTP error or malformed result, and an uncertain timeout is not retried automatically.

A valid result is billable, including a result below the buyer's requested confidence threshold. The buyer pays the quoted price, the platform receives its quoted commission and the owning seller account receives the remainder. A failed or expired execution releases the buyer's reservation; the seller can still have incurred compute costs. The seller must include that risk in its price and execution design. A replay of the buyer's original idempotency key retrieves the same decision instead of purchasing another computation.

Zoko's acceptance confidence is the minimum of the seller's Choice/Score confidence fields and `max(p, 1-p)` for each Noul. The Noul measure is derived from its probability; the wire format contains no separate Noul confidence field. Schema validity and reported confidence do not prove factual correctness. Evaluate thresholds on representative labeled records, and keep authorization, accounting, fees, budgets and irreversible actions in deterministic application code.

Readiness and doctor do not call the seller's endpoint or purchase an execution. Validate each actual seller with a bounded paid acceptance request, then inspect the buyer's receipt, seller proceeds, commission and ledger audit. Measure execution quality and full client latency on the intended workload before increasing budgets.

## Optional seller implementation: Jev

A seller may choose to implement its endpoint using Jev or another model, or use its own computation that satisfies the same wire contract. A seller choosing Jev manages its own TypeSafe credentials, model version, rate limits and billing inside its independently operated service. Those credentials do not belong in Zoko's platform environment.

For that seller's implementation, consult the official [API contract](https://docs.typesafe.ai/api), [model reference](https://docs.typesafe.ai/models), [confidence explanation](https://docs.typesafe.ai/confidence) and [Jev limitations](https://docs.typesafe.ai/model-jaggedness/jev-1.13). The seller remains responsible for the behavior of the endpoint it offers and for any upstream costs.
