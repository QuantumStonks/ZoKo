# Zoko clients and operational console

## Browser console

The application serves its console at `/`. The catalog and live/readiness status work without credentials. Select **Connect account**, choose buyer/seller or operator, and enter the corresponding token. Tokens remain in the tab's memory: the console uses no local storage, session storage, analytics, or remotely loaded scripts. The Cashtab connector is bundled with the application. Disconnecting or leaving the page clears credentials and private rendered data. Use HTTPS outside localhost.

**Decision lab** accepts the real Jev question schema. The initial editable customer-support request can be submitted to a configured provider; it does not produce canned results. A quote makes no inference call. Review the chosen seller and exact XEC price, then purchase. Successful schema-valid responses are billable even when they fall below the requested confidence threshold. `accepted` communicates whether the result meets that threshold. It is not measured correctness.

The console retains the exact original quote, input, and idempotency key while a decision is unresolved. It retries only that purchase or polls the returned request ID. **Resume original purchase** recovers an interrupted call. A page-leave warning helps prevent losing a locally pending request. After reopening or reconnecting, retrieve the durable record in **Activity**. Do not create a new purchase merely because a response was lost.

**Wallet** displays actual available/reserved balances and the account's daily/per-call spending policy. Allocate your dedicated deposit address before transferring XEC. A transaction-ID check accelerates verification; it never assigns ownership to an unrelated deposit. Withdrawal review shows the destination, amount received, maximum fee, and maximum balance reservation. Interrupted withdrawal retries reuse the original key and payload. Unused reserved network fees return under the settlement contract.

**Operator** exposes actual account/seller creation, account/seller policy updates, and the audit API. Issued account credentials appear once and can be copied and dismissed. Provider keys are submitted directly to the server and cleared from the form after success. The endpoint must satisfy the configured server allowlist. The browser never calls a provider directly.

### Cashtab top-ups

In **Wallet**, enter the XEC amount and choose **Prepare top-up**. Amounts allow up to two decimal places and must be at least 5.46 XEC. The console allocates or retrieves the connected account's dedicated receiving address, checks its eCash checksum and mainnet prefix, and shows the exact amount, account, network, and destination before any wallet action. All amount calculations use integer atoms and nanoXEC strings. Your wallet's network fee is additional to the amount sent.

When the official extension is available, **Pay with Cashtab** invokes `cashtab-connect` 1.2.1's `sendXec(address, amount)` with the exact amount as a string. The extension presents the transaction for the user's approval. The console holds one SDK instance and permits only one active wallet request. It never requests the customer's wallet balance, seed, or private key. The SDK is bundled into a self-hosted browser asset by `npm run build:browser`, which is included in the normal build and development startup.

The mobile/web alternative is an ordinary link to `https://pay.e.cash/?bip21=<encoded-payment>&b=1`, containing only the validated address and exact amount. The official wallet link opens Cashtab or the payment landing page for review and approval. It does not automatically sign a payment. The console does not open a second popup, follow untrusted return URLs, or interpret a URL fragment as proof of payment. See the [official payment-link documentation](https://docs.e.cash/pay/).

A wallet response is **only a transaction hint**. A returned transaction ID is passed to `POST /v1/deposits/claim`, and the console reads the authenticated `GET /v1/deposits` endpoint to verify recorded outpoints. It displays credited funding only when the server reports `status: "credited"` with a credit timestamp. A changed account balance or a successful wallet callback alone cannot satisfy that condition. For mobile/web links without a transaction callback, the console watches outpoints newly recorded for the account relative to the pre-payment history. The displayed amount is the actual amount recorded by the server. A manual transaction-ID check is also available. See [payment operation](ecash.md) for the hosted Chronik trust boundary and server recovery rules.

Wallet timeouts, missing or malformed receipts, and generic `success: false` responses leave the outcome **unknown** and do not automatically enable another send. The SDK's `CashtabTransactionDeniedError` is not by itself sufficient evidence of cancellation: Zoko recognizes only the exact reason `User rejected the transaction` as an explicit refusal. The current official Cashtab [Reject-button implementation](https://github.com/Bitcoin-ABC/bitcoin-abc/blob/b53096bc43db49bc90a4c6c39a7c0106d4be2d78/cashtab/src/components/Send/SendXec.tsx) emits that reason, and the button is disabled while sending. Other post-dispatch errors lead to deposit reconciliation. No error path automatically sends again.

Automatic reconciliation runs for at most two minutes and 25 reads, with a maximum of three consecutive read failures. Network confirmation may take longer; the payment worker continues independently. **Check funding** starts another bounded read-only check. **Prepare another top-up** explicitly begins a separate payment and warns that the previous one may still arrive. It does not cancel an existing on-chain payment. Inspect your wallet and deposit history before approving another transfer after an unknown outcome. A page-leave warning applies while a wallet approval or local polling session is active; it does not keep the page blocked throughout a longer confirmation wait.

Cashtab payment links are enabled for mainnet `ecash:` addresses. The manual address flow remains available for another configured network with a wallet that supports it. Customer wallet funding is separate from the operator's dedicated service-wallet seed and payout signing.

## TypeScript SDK

The SDK is available as `src/client.ts`, or `dist/src/client.js` after building this repository. It uses Node 24's built-in `fetch` and exact decimal money helpers.

```ts
import {
  ZokoClient,
  AmbiguousDecisionError,
  parseXec,
} from './dist/src/client.js';

const client = new ZokoClient({
  baseUrl: process.env.ZOKO_URL!,
  apiKey: process.env.ZOKO_API_KEY!,
  requestTimeoutMs: 30_000,
  maxWaitMs: 120_000,
});

const input = {
  state: {
    message: 'My order arrived yesterday with a cracked screen.',
    policy: 'Damaged items reported within 14 days qualify for replacement.',
  },
  questions: {
    replacement: {
      type: 'noul' as const,
      instructions: 'Does the stated replacement policy apply?',
      criteria: {
        true: 'The message satisfies the stated replacement policy.',
        false: 'The message does not establish eligibility.',
      },
    },
  },
};

const quote = await client.quote(input, {
  maxPriceNanos: parseXec('100'),
  maxLatencyMs: 10_000,
  minConfidence: 0.8,
});

// Persist input, quote.id and this key in your application's durable job record
// before calling execute. One business action must retain one purchase identity.
const idempotencyKey = crypto.randomUUID();
try {
  const receipt = await client.execute(quote.id, input, idempotencyKey);
  if (receipt.status === 'succeeded' && receipt.accepted === true) {
    // Pass the validated answers to your application's own action policy.
    console.log(receipt.result?.answers);
  } else {
    // Persist this terminal outcome for review; do not automatically repurchase.
    console.log(receipt);
  }
} catch (error) {
  if (error instanceof AmbiguousDecisionError) {
    // Retain the original durable job. Resume execute with the same three
    // arguments, or retrieve error.decisionId when available. Never re-quote.
    console.error({ quoteId: error.quoteId, idempotencyKey: error.idempotencyKey,
      decisionId: error.decisionId });
  } else {
    throw error;
  }
}
```

`client.decide(input, policy, {idempotencyKey, signal})` combines one quote and one execution. Use explicit `quote`/`execute` when durable preparation and caller-controlled approval are required. `execute` retries connection failures and selected transient HTTP responses with the identical payload/key. Once a request ID is known, it polls `GET /v1/decisions/:id`. Four consecutive failed attempts or the overall deadline raise `AmbiguousDecisionError`, including the original recovery identity. An abort after dispatch is also ambiguous. It does not imply the server canceled the request.

`ZokoApiError` exposes `status` and the structured server error `body`. A definitive request rejection, such as a `409` idempotency conflict, is never retried. Terminal failed/refunded receipts are returned for the caller to inspect. Neither a successful HTTP status nor a high confidence score automatically authorizes a downstream real-world action.

The generic `request(method, path, body?, {idempotencyKey?, signal?})` calls the configured origin only and never retries mutations automatically. `me`, `catalog`, `history`, and `getDecision` are read helpers. `deposits({txid?, limit?, signal?})` returns up to 100 deposit outputs belonging to the authenticated account, optionally filtered by transaction ID. Records include exact `amountNanos`, `vout`, confirmation/finality evidence, and `status` (`pending`, `credited`, `unsupported`, or `reorg_review`). The helper is read-only. Redirects are rejected. HTTPS is required except for loopback HTTP. Responses are limited to 2 MiB.

### Monetary units

| Unit | Exact relation |
|---|---|
| 1 XEC | 1,000,000,000 nanoXEC |
| 1 native eCash atom | 10,000,000 nanoXEC = 0.01 XEC |
| API money values | Decimal integer strings |
| `parseXec('0.01')` | `'10000000'` |
| `formatXec('100000001')` | `'0.100000001'` |

Never convert money to JavaScript `number`. The ledger supports sub-atom internal prices; on-chain withdrawals must be whole atoms. The server's configured account, price, withdrawal and fee limits remain authoritative.

## CLI

`npm run cli -- help` prints the full command reference. Set `ZOKO_URL` and `ZOKO_API_KEY` in the environment. The default URL is `http://127.0.0.1:3000`; operator commands use the operator token as `ZOKO_API_KEY`. Avoid passing credentials as command-line arguments. No command stores API keys in a configuration file.

| Command | Effect |
|---|---|
| `keygen [--out FILE]` | Generate `ZOKO_ADMIN_TOKEN` and base64 `ZOKO_ENCRYPTION_KEY`; exclusive file creation with mode 0600 when `--out` is supplied |
| `doctor` | Read public liveness/readiness probes; no state changes |
| `catalog`, `me`, `history [--limit N]` | Retrieve live catalog or account state |
| `quote --input FILE --max-price XEC` | Create one bounded quote, without purchasing |
| `decide --input FILE --max-price XEC [--journal FILE]` | Quote once, prepare recovery data, purchase, and poll |
| `execute --input FILE --quote ID --key KEY` | Execute or recover the exact original purchase |
| `recover --journal FILE` | Recover the original payload/quote/key from a journal |
| `account create --name NAME --daily-limit XEC --max-price XEC` | Issue a new scoped account and return its key once |
| `seller add --input FILE` | Register a configured provider offer |
| `api METHOD /v1/PATH [--input FILE] [--key KEY]` | Explicit API request with no automatic mutation retries |

Quote and decide commands also accept `--latency-ms N`, `--confidence 0..1`, and `--sellers ID,ID`. `decide` accepts a supplied `--key`; otherwise it generates a UUID. Account creation accepts optional `--sellers ID,ID`.

For purchases, use `--journal purchase.json`. The CLI writes the original URL, input, quote, and idempotency key **before** executing, refuses to overwrite an existing journal, and uses mode 0600. Journals contain sensitive input and should be protected under your application's data policy. They contain no API credential. `recover` requires `ZOKO_URL` to match the journal's origin and sends the unchanged original request. Keep the journal until its outcome is reconciled. The CLI also prints a `purchase_prepared` event to stderr before dispatch and the final JSON receipt to stdout.

Exit code `0` indicates that the operation completed, including a terminal failed decision receipt. Inspect `receipt.status` and `receipt.accepted`. Exit code `1` indicates a definitive command/API error. Exit code `2` indicates an ambiguous decision outcome with recovery information on stderr. None of those statuses should trigger a blind new purchase.

To register the official provider, a seller input file has this shape (replace the key with the real provider credential):

```json
{
  "id": "jev-primary",
  "name": "Jev decisions",
  "endpoint": "https://api.typesafe.ai/v1/systemone",
  "apiKey": "YOUR_TYPESAFE_API_KEY",
  "model": "jev-1.13.0",
  "priceNanos": "100000000000",
  "enabled": true
}
```

The listed price is the operator's explicit fixed offer, not a claim about the provider's underlying cost. Add `payoutAccountId` to credit an existing seller account. Keep credential-bearing provisioning files outside source control and remove them after secure provisioning.
