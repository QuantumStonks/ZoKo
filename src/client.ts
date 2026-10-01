import { randomUUID } from 'node:crypto';
import type { DecisionInput } from './protocol.js';
import type { ProviderResult, AgentResult } from './provider.js';

/** Integer nanoXEC at every wire boundary. One XEC is 1,000,000,000 nanoXEC. */
export type NanoXec = string;
/** An agent-owned offer. Credentials are write-only and never included here. */
export interface SellerOffer {
  id: string;
  name: string;
  endpoint: string | null;
  deliveryMode?: 'https' | 'agent';
  readyUntil?: string | null;
  model: string;
  priceNanos: NanoXec;
  payoutAccountId: string;
  enabled: boolean;
  paused: boolean;
  /** Current marketplace commission in basis points; quotes snapshot their rate. */
  commissionBps: number;
}
export interface RegisterSellerOfferInput {
  id: string;
  name: string;
  endpoint: string;
  apiKey: string;
  model: string;
  priceNanos: NanoXec;
}
export interface UpdateSellerOfferInput {
  priceNanos?: NanoXec;
  apiKey?: string;
  paused?: boolean;
}
export interface SellerOffersPage {
  offers: SellerOffer[];
  nextCursor: string | null;
}
export interface DepositRecord {
  txid: string;
  vout: number;
  amountNanos: NanoXec;
  status: 'pending' | 'credited' | 'unsupported' | 'reorg_review';
  confirmations: number;
  avalancheFinalized: boolean;
  creditedAt: string | null;
  createdAt: string;
}
export interface PurchasePolicy {
  maxPriceNanos: NanoXec;
  maxLatencyMs?: number;
  minConfidence?: number;
  allowedSellers?: string[];
}
export interface Quote {
  id: string;
  sellerId: string;
  priceNanos: NanoXec;
  schemaHash: string;
  requestHash: string;
  expiresAt: string;
  timeoutMs: number;
  minConfidence: number;
}
export interface DecisionReceipt {
  id: string;
  status: string;
  sellerId?: string;
  priceNanos?: NanoXec;
  schemaHash?: string;
  requestHash?: string;
  result?: ProviderResult | AgentResult | null;
  confidence?: number | null;
  accepted?: boolean | null;
  latencyMs?: number | null;
  createdAt?: string;
  error?: unknown;
  [key: string]: unknown;
}
export interface ClientOptions {
  baseUrl: string;
  /** Omit for public discovery and catalog access. Private endpoints require it. */
  apiKey?: string;
  /** Per HTTP attempt; does not cause a fresh inference or fresh quote on retry. */
  requestTimeoutMs?: number;
  /** Deadline for execute(), including polling and same-key transport retries. */
  maxWaitMs?: number;
  pollIntervalMs?: number;
  fetch?: typeof globalThis.fetch;
}
export class ZokoApiError extends Error {
  constructor(public readonly status: number, public readonly body: unknown, message?: string) {
    super(message ?? apiErrorMessage(body, status));
    this.name = 'ZokoApiError';
  }
}
/** An interrupted purchase may already exist. Resume this exact quote, payload and key. */
export class AmbiguousDecisionError extends Error {
  constructor(
    public readonly quoteId: string,
    public readonly idempotencyKey: string,
    public readonly decisionId: string | undefined,
    cause: unknown,
  ) {
    super(`Decision outcome is not yet known. Recover ${decisionId ?? quoteId} using the original idempotency key; do not buy a new quote.`, { cause });
    this.name = 'AmbiguousDecisionError';
  }
}

export function parseXec(value: string): NanoXec {
  const match = /^(0|[1-9]\d*)(?:\.(\d{1,9}))?$/.exec(value.trim());
  if (!match) throw new TypeError('XEC must be a nonnegative decimal with at most nine fractional places.');
  const nanos = BigInt(match[1]!) * 1_000_000_000n + BigInt((match[2] ?? '').padEnd(9, '0'));
  if (nanos.toString().length > 40) throw new RangeError('XEC amount exceeds the ledger limit.');
  return nanos.toString();
}
export function formatXec(nanos: NanoXec): string {
  if (!/^-?\d+$/.test(nanos)) throw new TypeError('nanoXEC must be an integer string.');
  const amount = BigInt(nanos);
  const sign = amount < 0n ? '-' : '';
  const absolute = amount < 0n ? -amount : amount;
  const fraction = (absolute % 1_000_000_000n).toString().padStart(9, '0').replace(/0+$/, '');
  return `${sign}${absolute / 1_000_000_000n}${fraction ? `.${fraction}` : ''}`;
}
function apiErrorMessage(body: unknown, status: number): string {
  if (body && typeof body === 'object') {
    const data = body as Record<string, unknown>;
    if (typeof data.message === 'string') return data.message;
    if (typeof data.error === 'string') return data.error;
    if (data.error && typeof data.error === 'object' && 'message' in data.error && typeof data.error.message === 'string') return data.error.message;
  }
  return `Zoko request failed (HTTP ${status}).`;
}
function duration(value: number | undefined, fallback: number, name: string): number {
  const actual = value ?? fallback;
  if (!Number.isSafeInteger(actual) || actual < 1 || actual > 3_600_000) throw new RangeError(`${name} must be between 1 and 3,600,000 milliseconds.`);
  return actual;
}
export function validateIdempotencyKey(key: string): void {
  if (!/^[A-Za-z0-9._:-]{8,128}$/.test(key)) throw new TypeError('Idempotency key must be 8–128 ASCII letters, numbers, periods, underscores, colons or hyphens.');
}
function validateOfferId(id: string): void {
  if (!/^[a-z0-9][a-z0-9_-]{0,63}$/.test(id)) throw new TypeError('Offer ID must be 1–64 lowercase letters, digits, underscores or hyphens, starting with a letter or digit.');
}
function validateOfferPrice(price: string): void {
  if (typeof price !== 'string' || !/^[1-9]\d{0,29}$/.test(price)) throw new TypeError('Offer price must be a positive nanoXEC integer string with at most 30 digits.');
}
function validateOfferCredential(apiKey: string): void {
  if (typeof apiKey !== 'string' || apiKey.length < 1 || apiKey.length > 4096) throw new TypeError('Agent endpoint API key must contain 1–4096 characters.');
}
function rejectUnknownFields(input: object, allowed: string[]): void {
  if (Object.keys(input).some((key) => !allowed.includes(key))) throw new TypeError('Offer ownership, payout account, approval and endpoint identity cannot be changed through seller controls.');
}
function throwIfAborted(signal?: AbortSignal): void {
  if (signal?.aborted) throw signal.reason ?? new Error('Operation aborted.');
}
async function sleep(milliseconds: number, signal?: AbortSignal): Promise<void> {
  throwIfAborted(signal);
  await new Promise<void>((resolve, reject) => {
    const onAbort = () => { clearTimeout(timer); reject(signal?.reason ?? new Error('Operation aborted.')); };
    const timer = setTimeout(() => { signal?.removeEventListener('abort', onAbort); resolve(); }, milliseconds);
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}
async function readJson(response: Response): Promise<unknown> {
  if (!response.body) return null;
  const reader = response.body.getReader();
  let total = 0;
  const chunks: Uint8Array[] = [];
  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > 2_097_152) throw new Error('Zoko response exceeded the 2 MiB client limit.');
      chunks.push(value);
    }
  } catch (error) {
    await reader.cancel().catch(() => {});
    throw error;
  } finally {
    reader.releaseLock();
  }
  const content = Buffer.concat(chunks).toString('utf8');
  if (!content) return null;
  try { return JSON.parse(content) as unknown; } catch { throw new Error('Zoko returned a non-JSON response.'); }
}

export class ZokoClient {
  readonly baseUrl: string;
  private readonly apiKey: string | undefined;
  private readonly requestTimeoutMs: number;
  private readonly maxWaitMs: number;
  private readonly pollIntervalMs: number;
  private readonly fetcher: typeof globalThis.fetch;

  constructor(options: ClientOptions) {
    const url = new URL(options.baseUrl);
    if (url.username || url.password || url.search || url.hash) throw new TypeError('Zoko URL cannot contain credentials, query parameters or a fragment.');
    const local = ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname);
    if (url.protocol !== 'https:' && !(url.protocol === 'http:' && local)) throw new TypeError('Use HTTPS for Zoko, or HTTP on localhost for local development.');
    if (options.apiKey !== undefined && !/^[\x21-\x7e]{1,512}$/.test(options.apiKey)) throw new TypeError('A Zoko API key must contain 1–512 visible ASCII characters without whitespace.');
    this.baseUrl = url.toString().replace(/\/$/, '');
    this.apiKey = options.apiKey;
    this.requestTimeoutMs = duration(options.requestTimeoutMs, 30_000, 'requestTimeoutMs');
    this.maxWaitMs = duration(options.maxWaitMs, 120_000, 'maxWaitMs');
    this.pollIntervalMs = duration(options.pollIntervalMs, 750, 'pollIntervalMs');
    this.fetcher = options.fetch ?? globalThis.fetch;
  }

  /** Generic authenticated endpoint access; never retries mutations automatically. */
  async request<T = unknown>(method: string, path: string, body?: unknown, options: { idempotencyKey?: string; signal?: AbortSignal; timeoutMs?: number } = {}): Promise<T> {
    const response = await this.requestWithStatus<T>(method, path, body, options);
    return response.body;
  }

  private async requestWithStatus<T>(method: string, path: string, body?: unknown, options: { idempotencyKey?: string; signal?: AbortSignal; timeoutMs?: number; public?: boolean } = {}): Promise<{ body: T; status: number; retryAfterMs?: number }> {
    if (!path.startsWith('/') || path.startsWith('//') || /[\\#\s\x00-\x1f\x7f]/.test(path)) throw new TypeError('API path must be relative to the configured Zoko origin.');
    const target = new URL(`${this.baseUrl}${path}`);
    const base = new URL(this.baseUrl);
    if (target.origin !== base.origin || !target.pathname.startsWith(`${base.pathname.replace(/\/$/, '')}/`)) throw new TypeError('API path cannot escape the configured Zoko base URL.');
    if (!options.public && !this.apiKey) throw new TypeError('Set ZOKO_API_KEY for authenticated Zoko endpoints.');
    if (options.idempotencyKey !== undefined) validateIdempotencyKey(options.idempotencyKey);
    throwIfAborted(options.signal);
    const timeout = AbortSignal.timeout(Math.max(1, Math.min(options.timeoutMs ?? this.requestTimeoutMs, this.requestTimeoutMs)));
    const response = await this.fetcher(target.toString(), {
      method,
      headers: {
        Accept: 'application/json',
        ...(options.public ? {} : { Authorization: `Bearer ${this.apiKey}` }),
        ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
        ...(options.idempotencyKey ? { 'Idempotency-Key': options.idempotencyKey } : {}),
      },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: options.signal ? AbortSignal.any([timeout, options.signal]) : timeout,
      redirect: 'error',
      cache: 'no-store',
    });
    const data = await readJson(response);
    if (!response.ok) throw new ZokoApiError(response.status, data);
    const retryHeader = response.headers.get('retry-after');
    const seconds = retryHeader && /^\d+$/.test(retryHeader) ? Number(retryHeader) : undefined;
    return { body: data as T, status: response.status, retryAfterMs: seconds === undefined ? undefined : Math.min(seconds * 1000, 10_000) };
  }

  me<T = unknown>(signal?: AbortSignal): Promise<T> { return this.request<T>('GET', '/v1/me', undefined, { signal }); }
  async catalog<T = unknown>(signal?: AbortSignal): Promise<T> { return (await this.requestWithStatus<T>('GET', '/v1/catalog', undefined, { signal, public: true })).body; }
  /** Public machine-readable protocol, billing rules and marketplace capabilities. */
  async discover<T = unknown>(signal?: AbortSignal): Promise<T> { return (await this.requestWithStatus<T>('GET', '/.well-known/zoko.json', undefined, { signal, public: true })).body; }
  /** Enroll with a locally generated key; replay the same key and exact input after interruption. */
  enroll(input: {name:string;dailyLimitNanos:string;maxPriceNanos:string;allowedSellers?:string[]}): Promise<unknown> {
    return this.request('POST','/v1/enroll',input);
  }
  async health<T = unknown>(probe: 'live' | 'ready', signal?: AbortSignal): Promise<T> {
    if (!['live', 'ready'].includes(probe)) throw new TypeError('Health probe must be live or ready.');
    return (await this.requestWithStatus<T>('GET', `/health/${probe}`, undefined, { signal, public: true })).body;
  }
  /** List only the offers owned by this ordinary agent account. */
  listOffers(options: { limit?: number; after?: string; signal?: AbortSignal } = {}): Promise<SellerOffersPage> {
    const limit = options.limit ?? 100;
    if (!Number.isInteger(limit) || limit < 1 || limit > 100) throw new RangeError('Offer page limit must be between 1 and 100.');
    const query = new URLSearchParams({ limit: String(limit) });
    if (options.after !== undefined) { validateOfferId(options.after); query.set('after', options.after); }
    return this.request('GET', `/v1/seller/offers?${query}`, undefined, { signal: options.signal });
  }
  /** Submit an agent's offer for operator approval. No mutation retry is performed. */
  registerOffer(input: RegisterSellerOfferInput, signal?: AbortSignal): Promise<SellerOffer> {
    rejectUnknownFields(input, ['id', 'name', 'endpoint', 'apiKey', 'model', 'priceNanos']);
    validateOfferId(input.id);
    validateOfferPrice(input.priceNanos);
    validateOfferCredential(input.apiKey);
    if (typeof input.name !== 'string' || !input.name.trim() || input.name.trim().length > 120) throw new TypeError('Offer name must contain 1–120 characters.');
    if (typeof input.model !== 'string' || !input.model || input.model.length > 100) throw new TypeError('An exact agent model identifier of 1–100 characters is required.');
    const endpoint = new URL(input.endpoint);
    if (endpoint.protocol !== 'https:' || endpoint.username || endpoint.password || endpoint.hash || input.endpoint.length > 2048) throw new TypeError('An agent offer requires a credential-free HTTPS endpoint without a fragment.');
    return this.request('POST', '/v1/seller/offers', input, { signal });
  }
  /** Adjust your price, rotate your endpoint credential, or pause your own offer. */
  updateOffer(id: string, changes: UpdateSellerOfferInput, signal?: AbortSignal): Promise<SellerOffer> {
    validateOfferId(id);
    rejectUnknownFields(changes, ['priceNanos', 'apiKey', 'paused']);
    if (changes.priceNanos !== undefined) validateOfferPrice(changes.priceNanos);
    if (changes.apiKey !== undefined) validateOfferCredential(changes.apiKey);
    if (changes.paused !== undefined && typeof changes.paused !== 'boolean') throw new TypeError('Offer paused state must be a boolean.');
    if (changes.priceNanos === undefined && changes.apiKey === undefined && changes.paused === undefined) throw new TypeError('At least one offer change is required.');
    return this.request('PATCH', `/v1/seller/offers/${encodeURIComponent(id)}`, changes, { signal });
  }
  /** Payment evidence from Zoko's verifier, scoped to this API key's account. */
  deposits(options: { txid?: string; limit?: number; signal?: AbortSignal } = {}): Promise<{ deposits: DepositRecord[] }> {
    const limit=options.limit??100;
    if(!Number.isInteger(limit)||limit<1||limit>100)throw new RangeError('Deposit limit must be between 1 and 100.');
    const query=new URLSearchParams({limit:String(limit)});
    if(options.txid!==undefined){
      if(!/^[0-9a-fA-F]{64}$/.test(options.txid))throw new TypeError('Transaction ID must contain 64 hexadecimal characters.');
      query.set('txid',options.txid.toLowerCase());
    }
    return this.request('GET',`/v1/deposits?${query}`,undefined,{signal:options.signal});
  }
  history<T = unknown>(limit = 50, signal?: AbortSignal): Promise<T> {
    if (!Number.isInteger(limit) || limit < 1 || limit > 100) throw new RangeError('History limit must be between 1 and 100.');
    return this.request<T>('GET', `/v1/decisions?limit=${limit}`, undefined, { signal });
  }
  getDecision(id: string, signal?: AbortSignal): Promise<DecisionReceipt> {
    return this.request<DecisionReceipt>('GET', `/v1/decisions/${encodeURIComponent(id)}`, undefined, { signal });
  }
  async quote(input: DecisionInput, policy: PurchasePolicy, signal?: AbortSignal): Promise<Quote> {
    if (!/^(0|[1-9]\d{0,39})$/.test(policy.maxPriceNanos)) throw new TypeError('maxPriceNanos must be an integer string with at most 40 digits.');
    if (policy.maxLatencyMs !== undefined && (!Number.isInteger(policy.maxLatencyMs) || policy.maxLatencyMs < 100 || policy.maxLatencyMs > 60_000)) throw new TypeError('maxLatencyMs must be an integer between 100 and 60,000.');
    if (policy.minConfidence !== undefined && (!Number.isFinite(policy.minConfidence) || policy.minConfidence < 0 || policy.minConfidence > 1)) throw new TypeError('minConfidence must be between 0 and 1.');
    if (policy.allowedSellers !== undefined && (!Array.isArray(policy.allowedSellers) || !policy.allowedSellers.length || policy.allowedSellers.length > 100 || policy.allowedSellers.some((id) => typeof id !== 'string' || !/^[a-z0-9][a-z0-9_-]{0,63}$/.test(id)))) throw new TypeError('allowedSellers must contain 1–100 valid offer IDs.');
    const quote = await this.request<Quote>('POST', '/v1/quotes', { ...input, policy }, { signal });
    if (!quote || typeof quote.id !== 'string' || !quote.id || typeof quote.sellerId !== 'string' || typeof quote.priceNanos !== 'string' || !/^[1-9]\d{0,39}$/.test(quote.priceNanos) || BigInt(quote.priceNanos) > BigInt(policy.maxPriceNanos)
      || typeof quote.schemaHash !== 'string' || typeof quote.requestHash !== 'string' || typeof quote.expiresAt !== 'string' || !Number.isFinite(Date.parse(quote.expiresAt))
      || !Number.isInteger(quote.timeoutMs) || quote.timeoutMs < 100 || quote.timeoutMs > (policy.maxLatencyMs ?? 60_000)
      || !Number.isFinite(quote.minConfidence) || quote.minConfidence < 0 || quote.minConfidence > 1 || (policy.minConfidence !== undefined && quote.minConfidence !== policy.minConfidence)
      || (policy.allowedSellers !== undefined && !policy.allowedSellers.includes(quote.sellerId))) throw new Error('Zoko returned an invalid quote or a quote outside the requested purchase policy.');
    return quote;
  }

  /** Obtain one quote, then execute it. Transport ambiguity never creates another quote. */
  async decide(input: DecisionInput, policy: PurchasePolicy, options: { idempotencyKey?: string; signal?: AbortSignal } = {}): Promise<DecisionReceipt> {
    const idempotencyKey = options.idempotencyKey ?? randomUUID();
    validateIdempotencyKey(idempotencyKey);
    const snapshot = JSON.parse(JSON.stringify(input)) as DecisionInput;
    const quote = await this.quote(snapshot, policy, options.signal);
    return this.execute(quote.id, snapshot, idempotencyKey, options.signal);
  }

  /** Safe recovery API: pass the ORIGINAL quote, unchanged input and ORIGINAL key. */
  async execute(quoteId: string, input: DecisionInput, idempotencyKey: string, signal?: AbortSignal): Promise<DecisionReceipt> {
    validateIdempotencyKey(idempotencyKey);
    if (!this.apiKey) throw new TypeError('Set ZOKO_API_KEY for authenticated Zoko endpoints.');
    throwIfAborted(signal);
    // Hold a private JSON snapshot: caller mutations cannot alter same-key retries.
    const payload: unknown = JSON.parse(JSON.stringify({ quoteId, state: input.state, questions: input.questions }));
    const deadline = Date.now() + this.maxWaitMs;
    let decisionId: string | undefined;
    let failures = 0;
    let uncertainDispatch = false;
    let lastError: unknown = new Error('Decision polling deadline reached.');
    while (Date.now() < deadline) {
      try {
        const response = decisionId
          ? await this.requestWithStatus<DecisionReceipt>('GET', `/v1/decisions/${encodeURIComponent(decisionId)}`, undefined, { signal, timeoutMs: deadline - Date.now() })
          : await this.requestWithStatus<DecisionReceipt>('POST', '/v1/decisions', payload, { idempotencyKey, signal, timeoutMs: deadline - Date.now() });
        if (!response.body || typeof response.body.id !== 'string' || !response.body.id || !['pending', 'queued', 'calling', 'running', 'succeeded', 'failed', 'indeterminate'].includes(response.body.status)) throw new Error('Zoko returned an invalid decision receipt.');
        if (decisionId !== undefined && response.body.id !== decisionId) throw new Error('Zoko returned a different decision identity during recovery.');
        decisionId = response.body.id;
        failures = 0;
        if (response.status !== 202 && !['pending', 'queued', 'calling', 'running'].includes(response.body.status)) return response.body;
        await sleep(Math.min(response.retryAfterMs ?? this.pollIntervalMs, Math.max(1, deadline - Date.now())), signal);
      } catch (error) {
        lastError = error;
        // A definitive application rejection is terminal. Never re-quote or mutate the body.
        if (error instanceof ZokoApiError && error.status < 500 && ![408, 425, 429].includes(error.status)) {
          if (!decisionId && !uncertainDispatch) throw error;
          break;
        }
        uncertainDispatch = true;
        failures++;
        if (signal?.aborted || failures >= 4 || Date.now() >= deadline) break;
        try { await sleep(Math.min(250 * 2 ** (failures - 1), Math.max(1, deadline - Date.now())), signal); }
        catch (abortError) { lastError = abortError; break; }
      }
    }
    throw new AmbiguousDecisionError(quoteId, idempotencyKey, decisionId, lastError);
  }
}
