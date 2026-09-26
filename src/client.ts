import { randomUUID } from 'node:crypto';
import type { DecisionInput } from './protocol.js';
import type { ProviderResult } from './provider.js';

/** Integer nanoXEC at every wire boundary. One XEC is 1,000,000,000 nanoXEC. */
export type NanoXec = string;
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
  result?: ProviderResult | null;
  confidence?: number | null;
  accepted?: boolean | null;
  latencyMs?: number | null;
  createdAt?: string;
  error?: unknown;
  [key: string]: unknown;
}
export interface ClientOptions {
  baseUrl: string;
  apiKey: string;
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
function validateKey(key: string): void {
  if (!/^[A-Za-z0-9._:-]{8,128}$/.test(key)) throw new TypeError('Idempotency key must be 8–128 ASCII letters, numbers, periods, underscores, colons or hyphens.');
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
  private readonly apiKey: string;
  private readonly requestTimeoutMs: number;
  private readonly maxWaitMs: number;
  private readonly pollIntervalMs: number;
  private readonly fetcher: typeof globalThis.fetch;

  constructor(options: ClientOptions) {
    const url = new URL(options.baseUrl);
    if (url.username || url.password || url.search || url.hash) throw new TypeError('Zoko URL cannot contain credentials, query parameters or a fragment.');
    const local = ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname);
    if (url.protocol !== 'https:' && !(url.protocol === 'http:' && local)) throw new TypeError('Use HTTPS for Zoko, or HTTP on localhost for local development.');
    if (!options.apiKey.trim()) throw new TypeError('A Zoko API key is required.');
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

  private async requestWithStatus<T>(method: string, path: string, body?: unknown, options: { idempotencyKey?: string; signal?: AbortSignal; timeoutMs?: number } = {}): Promise<{ body: T; status: number; retryAfterMs?: number }> {
    if (!path.startsWith('/') || path.startsWith('//') || path.includes('://')) throw new TypeError('API path must be relative to the configured Zoko origin.');
    if (options.idempotencyKey) validateKey(options.idempotencyKey);
    throwIfAborted(options.signal);
    const timeout = AbortSignal.timeout(Math.max(1, Math.min(options.timeoutMs ?? this.requestTimeoutMs, this.requestTimeoutMs)));
    const response = await this.fetcher(`${this.baseUrl}${path}`, {
      method,
      headers: {
        Accept: 'application/json',
        Authorization: `Bearer ${this.apiKey}`,
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
  catalog<T = unknown>(signal?: AbortSignal): Promise<T> { return this.request<T>('GET', '/v1/catalog', undefined, { signal }); }
  history<T = unknown>(limit = 50, signal?: AbortSignal): Promise<T> {
    if (!Number.isInteger(limit) || limit < 1 || limit > 100) throw new RangeError('History limit must be between 1 and 100.');
    return this.request<T>('GET', `/v1/decisions?limit=${limit}`, undefined, { signal });
  }
  getDecision(id: string, signal?: AbortSignal): Promise<DecisionReceipt> {
    return this.request<DecisionReceipt>('GET', `/v1/decisions/${encodeURIComponent(id)}`, undefined, { signal });
  }
  async quote(input: DecisionInput, policy: PurchasePolicy, signal?: AbortSignal): Promise<Quote> {
    if (!/^(0|[1-9]\d{0,39})$/.test(policy.maxPriceNanos)) throw new TypeError('maxPriceNanos must be an integer string with at most 40 digits.');
    return this.request<Quote>('POST', '/v1/quotes', { ...input, policy }, { signal });
  }

  /** Obtain one quote, then execute it. Transport ambiguity never creates another quote. */
  async decide(input: DecisionInput, policy: PurchasePolicy, options: { idempotencyKey?: string; signal?: AbortSignal } = {}): Promise<DecisionReceipt> {
    const idempotencyKey = options.idempotencyKey ?? randomUUID();
    validateKey(idempotencyKey);
    const quote = await this.quote(input, policy, options.signal);
    return this.execute(quote.id, input, idempotencyKey, options.signal);
  }

  /** Safe recovery API: pass the ORIGINAL quote, unchanged input and ORIGINAL key. */
  async execute(quoteId: string, input: DecisionInput, idempotencyKey: string, signal?: AbortSignal): Promise<DecisionReceipt> {
    validateKey(idempotencyKey);
    throwIfAborted(signal);
    const payload = { quoteId, ...input };
    const deadline = Date.now() + this.maxWaitMs;
    let decisionId: string | undefined;
    let failures = 0;
    let lastError: unknown = new Error('Decision polling deadline reached.');
    while (Date.now() < deadline) {
      try {
        const response = decisionId
          ? await this.requestWithStatus<DecisionReceipt>('GET', `/v1/decisions/${encodeURIComponent(decisionId)}`, undefined, { signal, timeoutMs: deadline - Date.now() })
          : await this.requestWithStatus<DecisionReceipt>('POST', '/v1/decisions', payload, { idempotencyKey, signal, timeoutMs: deadline - Date.now() });
        if (!response.body || typeof response.body.id !== 'string' || typeof response.body.status !== 'string') throw new Error('Zoko returned an invalid decision receipt.');
        decisionId = response.body.id;
        failures = 0;
        if (response.status !== 202 && !['pending', 'queued', 'calling', 'running'].includes(response.body.status)) return response.body;
        await sleep(Math.min(response.retryAfterMs ?? this.pollIntervalMs, Math.max(1, deadline - Date.now())), signal);
      } catch (error) {
        lastError = error;
        // A definitive application rejection is terminal. Never re-quote or mutate the body.
        if (error instanceof ZokoApiError && error.status < 500 && ![408, 425, 429].includes(error.status)) throw error;
        failures++;
        if (signal?.aborted || failures >= 4 || Date.now() >= deadline) break;
        try { await sleep(Math.min(250 * 2 ** (failures - 1), Math.max(1, deadline - Date.now())), signal); }
        catch (abortError) { lastError = abortError; break; }
      }
    }
    throw new AmbiguousDecisionError(quoteId, idempotencyKey, decisionId, lastError);
  }
}
