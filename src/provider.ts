import { performance } from 'node:perf_hooks';
import { z } from 'zod';
import { DecisionInputSchema, type DecisionInput, type JsonEntry } from './protocol.js';

export const MAX_PROVIDER_RESPONSE_BYTES = 262_144;
export const MAX_PROVIDER_TIMEOUT_MS = 60_000;
export const PROBABILITY_TOLERANCE = 0.0001;

export type Answer =
  | { type: 'noul'; noul: number }
  | { type: 'choice'; choice: string; probabilities: Record<string, number>; confidence: number }
  | { type: 'score'; score: number; legend: Record<string, JsonEntry>; probabilities: Record<string, number>; confidence: number };
export interface ProviderResult {
  model: string;
  answers: Record<string, Answer>;
  usage: { input_tokens: number; output_tokens: number };
}
export type AgentResult = Omit<ProviderResult,'usage'> & { usage: null };
export interface Provider {
  /** Complete endpoint URL, e.g. https://api.typesafe.ai/v1/systemone. */
  endpoint: string;
  apiKey: string;
  model: string;
}
export class ProviderError extends Error {
  constructor(readonly code: string, message: string, readonly status?: number) {
    super(message);
    this.name = 'ProviderError';
  }
}

const Probability = z.number().finite().min(0).max(1);
const RecordGuard = z.unknown().refine(value => value === null || typeof value !== 'object'
  || !['__proto__', 'prototype', 'constructor'].some(key => Object.hasOwn(value, key)));
const ProbabilityMap = RecordGuard.pipe(z.record(z.string(), Probability));
const AnswerSchema = z.discriminatedUnion('type', [
  z.strictObject({ type: z.literal('noul'), noul: Probability }),
  z.strictObject({ type: z.literal('choice'), choice: z.string(), probabilities: ProbabilityMap, confidence: Probability }),
  z.strictObject({
    type: z.literal('score'), score: z.number().finite(),
    legend: RecordGuard.pipe(z.record(z.string(), z.unknown())), probabilities: ProbabilityMap, confidence: Probability,
  }),
]);
const ResultSchema = z.strictObject({
  model: z.string().min(1).max(128),
  answers: RecordGuard.pipe(z.record(z.string(), AnswerSchema)),
  usage: z.strictObject({ input_tokens: z.number().int().nonnegative().safe(), output_tokens: z.number().int().nonnegative().safe() }),
});

function sameKeys(actual: Record<string, unknown>, expected: string[]): boolean {
  const keys = Object.keys(actual);
  return keys.length === expected.length && expected.every(key => Object.hasOwn(actual, key));
}

function sameJson(actual: unknown, expected: unknown): boolean {
  if (actual === expected) return true;
  if (actual === null || expected === null || typeof actual !== 'object' || typeof expected !== 'object') return false;
  if (Array.isArray(actual) !== Array.isArray(expected)) return false;
  const a = actual as Record<string, unknown>;
  const b = expected as Record<string, unknown>;
  return sameKeys(a, Object.keys(b)) && Object.keys(b).every(key => sameJson(a[key], b[key]));
}

function invalidResult(): never {
  // Do not include upstream response bodies, state, or credentials in errors.
  throw new ProviderError('provider_invalid_result', 'Provider returned an invalid or inconsistent typed result');
}

function validateTypedResult(value: unknown, input: DecisionInput, model: string, agent: boolean): ProviderResult | AgentResult {
  const parsed = (agent ? ResultSchema.extend({usage:z.null()}) : ResultSchema).safeParse(value);
  if (!parsed.success) invalidResult();
  const result = parsed.data;
  const resolvesAlias = (model === 'jev-latest' || model === 'jev-preview') && /^jev-[0-9]+\.[0-9]+\.[0-9]+$/.test(result.model);
  if (result.model !== model && !resolvesAlias) invalidResult();
  if (!sameKeys(result.answers, Object.keys(input.questions))) invalidResult();
  for (const [key, question] of Object.entries(input.questions)) {
    const answer = result.answers[key];
    if (answer.type !== question.type) invalidResult();
    if (answer.type === 'noul') continue;
    const expectedKeys = question.type === 'choice' ? Object.keys(question.criteria)
      : question.type === 'score' ? question.criteria.map((_, index) => String(index)) : [];
    if (!sameKeys(answer.probabilities, expectedKeys)) invalidResult();
    const probabilities = Object.values(answer.probabilities);
    const total = probabilities.reduce((sum, probability) => sum + probability, 0);
    if (Math.abs(total - 1) > PROBABILITY_TOLERANCE) invalidResult();
    if (answer.type === 'choice') {
      if (!Object.hasOwn(answer.probabilities, answer.choice)) invalidResult();
      if (answer.probabilities[answer.choice] + Number.EPSILON < Math.max(...probabilities)) invalidResult();
    } else {
      if (question.type !== 'score' || !sameKeys(answer.legend, expectedKeys)) invalidResult();
      for (const index of expectedKeys) {
        if (!sameJson(answer.legend[index], question.criteria[Number(index)])) invalidResult();
      }
      const maximum = question.criteria.length - 1;
      const expectation = expectedKeys.reduce((sum, index) => sum + Number(index) * answer.probabilities[index], 0);
      if (answer.score < 0 || answer.score > maximum || Math.abs(answer.score - expectation) > PROBABILITY_TOLERANCE * Math.max(1, maximum)) invalidResult();
    }
  }
  return result as ProviderResult | AgentResult;
}

function validateResult(value:unknown,input:DecisionInput,model:string):ProviderResult {
  return validateTypedResult(value,input,model,false) as ProviderResult;
}
/** Active agents do not expose a reliable per-job token meter. Never invent one. */
export function validateAgentResult(value:unknown,input:DecisionInput,model:string):AgentResult {
  return validateTypedResult(value,DecisionInputSchema.parse(input),model,true) as AgentResult;
}

/**
 * Official wire protocol: https://docs.typesafe.ai/api.
 * Caller must authorize and resolve the endpoint against its configured host allowlist.
 * One invocation, no redirects or retries, including no retry after an uncertain timeout.
 */
export async function evaluateProvider(
  provider: Provider,
  input: DecisionInput,
  timeoutMs: number,
  fetchImpl: typeof fetch = globalThis.fetch,
): Promise<ProviderResult> {
  const started = performance.now();
  if (!Number.isInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > MAX_PROVIDER_TIMEOUT_MS) {
    throw new ProviderError('provider_configuration', `Timeout must be an integer between 1 and ${MAX_PROVIDER_TIMEOUT_MS} milliseconds`);
  }
  let endpoint: URL;
  try { endpoint = new URL(provider.endpoint); } catch {
    throw new ProviderError('provider_configuration', 'Provider endpoint is not an absolute URL');
  }
  if (!['https:', 'http:'].includes(endpoint.protocol) || endpoint.username || endpoint.password || endpoint.hash) {
    throw new ProviderError('provider_configuration', 'Provider endpoint has unsupported URL components');
  }
  if (!provider.apiKey || /[^\x21-\x7e]/.test(provider.apiKey) || provider.apiKey.length > 4096
    || !provider.model || provider.model.length > 128 || /[\x00-\x1f\x7f]/.test(provider.model)) {
    throw new ProviderError('provider_configuration', 'Provider credential or model configuration is invalid');
  }
  // Validate again at the trust boundary, then snapshot before the first await.
  const snapshot = JSON.parse(JSON.stringify(DecisionInputSchema.parse(input))) as DecisionInput;
  const requestedModel = provider.model;
  const body = JSON.stringify({ ...snapshot, model: requestedModel });
  const remaining = timeoutMs - (performance.now() - started);
  if (remaining <= 0) throw new ProviderError('provider_timeout', 'Provider exceeded the total deadline');
  const controller = new AbortController();
  let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeoutError = () => new ProviderError('provider_timeout', 'Provider exceeded the total deadline');
  const deadline = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      controller.abort();
      void reader?.cancel().catch(() => undefined);
      reject(timeoutError());
    }, remaining);
  });
  const operation = (async (): Promise<ProviderResult> => {
    const response = await fetchImpl(endpoint.href, {
      method: 'POST', redirect: 'error', signal: controller.signal,
      headers: { Authorization: `Bearer ${provider.apiKey}`, 'Content-Type': 'application/json', Accept: 'application/json' },
      body,
    });
    if (response.redirected || (response.status >= 300 && response.status < 400)) {
      throw new ProviderError('provider_redirect', 'Provider redirects are not permitted');
    }
    if (!response.ok) throw new ProviderError('provider_http_error', `Provider returned HTTP ${response.status}`, response.status);
    const contentType = response.headers.get('content-type')?.split(';', 1)[0].trim().toLowerCase();
    if (contentType !== 'application/json') invalidResult();
    const declaredLength = response.headers.get('content-length');
    if (declaredLength !== null && (!/^[0-9]+$/.test(declaredLength) || Number(declaredLength) > MAX_PROVIDER_RESPONSE_BYTES)) {
      throw new ProviderError('provider_response_too_large', 'Provider response exceeds the byte limit');
    }
    if (!response.body) invalidResult();
    reader = response.body.getReader();
    const decoder = new TextDecoder('utf-8', { fatal: true });
    let bytes = 0;
    let text = '';
    let bodyComplete = false;
    try {
      while (true) {
        const chunk = await reader.read();
        if (performance.now() - started >= timeoutMs) throw timeoutError();
        if (chunk.done) break;
        bytes += chunk.value.byteLength;
        if (bytes > MAX_PROVIDER_RESPONSE_BYTES) {
          throw new ProviderError('provider_response_too_large', 'Provider response exceeds the byte limit');
        }
        text += decoder.decode(chunk.value, { stream: true });
      }
      text += decoder.decode();
      bodyComplete = true;
    } finally {
      if (!bodyComplete) void reader.cancel().catch(() => undefined);
      reader.releaseLock();
      reader = undefined;
    }
    let decoded: unknown;
    try { decoded = JSON.parse(text); } catch { invalidResult(); }
    const result = validateResult(decoded, snapshot, requestedModel);
    if (performance.now() - started >= timeoutMs) throw timeoutError();
    return result;
  })();
  try {
    return await Promise.race([operation, deadline]);
  } catch (error) {
    if (error instanceof ProviderError) throw error;
    if (controller.signal.aborted) throw timeoutError();
    throw new ProviderError('provider_unavailable', 'Provider request or response transport failed');
  } finally {
    if (timer !== undefined) clearTimeout(timer);
    controller.abort();
    void reader?.cancel().catch(() => undefined);
  }
}

/**
 * Minimum reported confidence across Choice/Score answers. For Noul only, use the
 * derived concentration max(p, 1-p). Neither is a proof of real-world correctness.
 */
export function resultConfidence(result: ProviderResult | AgentResult): number {
  const answers = Object.values(result.answers);
  if (answers.length === 0) throw new ProviderError('provider_invalid_result', 'Provider returned no answers');
  let minimum = 1;
  for (const answer of answers) {
    const value = answer.type === 'noul' ? Math.max(answer.noul, 1 - answer.noul) : answer.confidence;
    if (!Number.isFinite(value) || value < 0 || value > 1) invalidResult();
    minimum = Math.min(minimum, value);
  }
  return minimum;
}
