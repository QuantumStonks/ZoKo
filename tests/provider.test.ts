import assert from 'node:assert/strict';
import { createServer, type RequestListener } from 'node:http';
import test from 'node:test';
import { DecisionInputSchema, MAX_INPUT_BYTES, type DecisionInput } from '../src/protocol.js';
import {
  evaluateProvider, MAX_PROVIDER_RESPONSE_BYTES, ProviderError, resultConfidence, type ProviderResult,
} from '../src/provider.js';

const input: DecisionInput = {
  state: { headline: 'The northern port is closed after a power outage.' },
  questions: {
    topic: { type: 'choice', instructions: 'What is the principal subject?', criteria: { logistics: 'Shipping and ports', other: null } },
    outage: { type: 'noul', instructions: 'Does the record describe an operational interruption?' },
    impact: { type: 'score', instructions: 'How broad is the interruption?', criteria: ['None', { scope: 'One site' }, 'Several regions'] },
  },
};
const result: ProviderResult = {
  model: 'jev-1.13.0',
  answers: {
    topic: { type: 'choice', choice: 'logistics', probabilities: { logistics: 0.9, other: 0.1 }, confidence: 0.8 },
    outage: { type: 'noul', noul: 0.95 },
    impact: { type: 'score', score: 1.1, legend: { '0': 'None', '1': { scope: 'One site' }, '2': 'Several regions' }, probabilities: { '0': 0.1, '1': 0.7, '2': 0.2 }, confidence: 0.65 },
  },
  usage: { input_tokens: 500, output_tokens: 60 },
};
const config = { endpoint: 'https://api.typesafe.ai/v1/systemone', apiKey: 'test-key', model: 'jev-1.13.0' };
const encode = (value: unknown): Response => new Response(JSON.stringify(value), { headers: { 'content-type': 'application/json' } });
const fetchResult = (value: unknown): typeof fetch => async () => encode(value);
const code = (expected: string) => (error: unknown) => error instanceof ProviderError && error.code === expected;

async function withServer(handler: RequestListener, action: (endpoint: string) => Promise<void>): Promise<void> {
  const server = createServer(handler);
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const address = server.address();
  assert(address && typeof address === 'object');
  try {
    await action(`http://127.0.0.1:${address.port}/v1/systemone`);
  } finally {
    server.closeAllConnections();
    await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
  }
}

test('protocol accepts all documented primitives and structured criteria', () => {
  assert.deepEqual(DecisionInputSchema.parse(input), input);
  assert(DecisionInputSchema.safeParse({ state: [], questions: { yes: { type: 'noul', criteria: { true: 'Yes', false: 'No' } } } }).success);
});

test('protocol measures the complete JSON byte budget, including UTF-8 encoding', () => {
  const base = { state: '', questions: { relevant: { type: 'noul' as const, instructions: 'Is this relevant?' } } };
  const overhead = Buffer.byteLength(JSON.stringify(base));
  assert(DecisionInputSchema.safeParse({ ...base, state: 'x'.repeat(MAX_INPUT_BYTES - overhead) }).success);
  assert(!DecisionInputSchema.safeParse({ ...base, state: 'x'.repeat(MAX_INPUT_BYTES - overhead + 1) }).success);
  assert(!DecisionInputSchema.safeParse({ ...base, state: '€'.repeat(11_000) }).success);
});

test('protocol rejects invalid shapes, extra properties, and unsupported bool primitive', () => {
  const cases = [
    { state: null, questions: input.questions },
    { state: 4, questions: input.questions },
    { state: true, questions: input.questions },
    { state: 'x', questions: {} },
    { ...input, extraneous: true },
    { state: 'x', questions: { a: { type: 'bool', instructions: 'Yes?' } } },
    { state: 'x', questions: { a: { type: 'noul', criteria: { yes: 'Yes' } } } },
    { state: 'x', questions: { a: { type: 'noul', instructions: 12 } } },
    { state: 'x', questions: { a: { type: 'choice', criteria: {} } } },
    { state: 'x', questions: { a: { type: 'score', criteria: ['One'] } } },
    { state: 'x', questions: { a: { type: 'score', criteria: Array.from({ length: 11 }, (_, i) => String(i)) } } },
    { state: 'x', questions: { a: { type: 'score', criteria: [null, 'One'] } } },
    { state: 'x', questions: Object.fromEntries(Array.from({ length: 21 }, (_, i) => [`q${i}`, { type: 'noul' }])) },
    { state: 'x', questions: { a: { type: 'choice', criteria: Object.fromEntries(Array.from({ length: 256 }, (_, i) => [`c${i}`, null])) } } },
    JSON.parse('{"state":"x","questions":{"__proto__":{"type":"noul"}}}'),
    JSON.parse('{"state":"x","questions":{"valid":{"type":"noul"},"__proto__":{"type":"noul"}}}'),
    JSON.parse('{"state":"x","questions":{"a":{"type":"choice","criteria":{"valid":null,"__proto__":null}}}}'),
    JSON.parse('{"state":"x","questions":{"a":{"type":"choice","criteria":{"constructor":null}}}}'),
  ];
  for (const invalid of cases) assert(!DecisionInputSchema.safeParse(invalid).success, JSON.stringify(invalid));
});

test('protocol rejects cycles, excessive nesting, accessors, nonfinite and non-JSON values', () => {
  const cycle: Record<string, unknown> = {};
  cycle['self'] = cycle;
  let deep: unknown = 'leaf';
  for (let i = 0; i < 40; i++) deep = { child: deep };
  let getterCalls = 0;
  const accessor = Object.defineProperty({}, 'sensitive', { enumerable: true, get() { getterCalls++; return 'private'; } });
  for (const state of [cycle, deep, accessor, { date: new Date() }, { big: 1n }, { invalid: undefined }, { invalid: Infinity }, { invalid: NaN }, new Array(2)]) {
    assert(!DecisionInputSchema.safeParse({ state, questions: input.questions }).success);
  }
  assert.equal(getterCalls, 0);
});

test('provider sends the verified wire contract and preserves a valid typed result', async () => {
  let calls = 0;
  const request: typeof fetch = async (url, init) => {
    calls++;
    assert.equal(url, config.endpoint);
    assert.equal(init?.method, 'POST');
    assert.equal(init?.redirect, 'error');
    assert.equal(new Headers(init?.headers).get('authorization'), 'Bearer test-key');
    assert.equal(new Headers(init?.headers).get('content-type'), 'application/json');
    assert.deepEqual(JSON.parse(String(init?.body)), { ...input, model: config.model });
    assert(init?.signal instanceof AbortSignal);
    return encode(result);
  };
  assert.deepEqual(await evaluateProvider(config, input, 1000, request), result);
  assert.equal(calls, 1);
  assert.equal(resultConfidence(result), 0.65);
});

test('Noul confidence is explicitly derived from its returned probability', () => {
  const one: ProviderResult = { model: result.model, usage: result.usage, answers: { yes: { type: 'noul', noul: 0.2 } } };
  assert.equal(resultConfidence(one), 0.8);
  one.answers['yes'] = { type: 'noul', noul: 0.5 };
  assert.equal(resultConfidence(one), 0.5);
  one.answers['yes'] = { type: 'noul', noul: NaN };
  assert.throws(() => resultConfidence(one), code('provider_invalid_result'));
  assert.throws(() => resultConfidence({ ...one, answers: {} }), code('provider_invalid_result'));
});

test('provider rejects malformed and inconsistent responses instead of coercing or normalizing them', async () => {
  const mutate = (fn: (value: Record<string, any>) => void): unknown => {
    const copy = structuredClone(result) as unknown as Record<string, any>;
    fn(copy);
    return copy;
  };
  const invalid = [
    null, {}, [],
    mutate(v => { v.usage.input_tokens = -1; }),
    mutate(v => { v.usage.input_tokens = 0.5; }),
    mutate(v => { v.usage.input_tokens = Number.MAX_SAFE_INTEGER + 1; }),
    mutate(v => { v.usage.output_tokens = null; }),
    mutate(v => { v.usage.output_tokens = '10'; }),
    mutate(v => { v.extra = true; }),
    mutate(v => { v.model = 'other-model'; }),
    mutate(v => { delete v.answers.outage; }),
    mutate(v => { v.answers.extra = { type: 'noul', noul: 0.9 }; }),
    mutate(v => { v.answers.outage = { type: 'choice', choice: 'yes', probabilities: { yes: 1 }, confidence: 1 }; }),
    mutate(v => { v.answers.outage.noul = -0.1; }),
    mutate(v => { v.answers.outage.noul = 1.01; }),
    mutate(v => { v.answers.outage.noul = '0.9'; }),
    mutate(v => { v.answers.topic.confidence = 2; }),
    mutate(v => { v.answers.topic.probabilities.other = -0.1; }),
    mutate(v => { v.answers.topic.probabilities.logistics = 1.1; }),
    mutate(v => { v.answers.topic.probabilities.other = 0; }),
    mutate(v => { v.answers.topic.probabilities.other = 0.2; }),
    mutate(v => { v.answers.topic.probabilities.extra = 0; }),
    mutate(v => { v.answers.topic.choice = 'absent'; }),
    mutate(v => { v.answers.topic.choice = 'other'; }),
    mutate(v => { v.answers.impact.score = -1; }),
    mutate(v => { v.answers.impact.score = 3; }),
    mutate(v => { v.answers.impact.score = 0.9; }),
    mutate(v => { v.answers.impact.legend['1'] = { scope: 'Different rubric' }; }),
    mutate(v => { v.answers.impact.legend['3'] = 'Extra rubric'; }),
    mutate(v => { delete v.answers.impact.probabilities['2']; }),
    mutate(v => { Object.defineProperty(v.answers, '__proto__', { value: { type: 'noul', noul: 1 }, enumerable: true }); }),
    mutate(v => { Object.defineProperty(v.answers.topic.probabilities, '__proto__', { value: 0, enumerable: true }); }),
    mutate(v => { Object.defineProperty(v.answers.impact.legend, '__proto__', { value: 'Unexpected', enumerable: true }); }),
  ];
  for (const value of invalid) await assert.rejects(evaluateProvider(config, input, 1000, fetchResult(value)), code('provider_invalid_result'));
});

test('provider permits only known aliases to resolve to versioned Jev models', async () => {
  assert.deepEqual(await evaluateProvider({ ...config, model: 'jev-latest' }, input, 1000, fetchResult(result)), result);
  assert.deepEqual(await evaluateProvider({ ...config, model: 'jev-preview' }, input, 1000, fetchResult(result)), result);
  await assert.rejects(evaluateProvider({ ...config, model: 'custom-latest' }, input, 1000, fetchResult(result)), code('provider_invalid_result'));
  await assert.rejects(evaluateProvider({ ...config, model: 'jev-latest' }, input, 1000, fetchResult({ ...result, model: 'unrelated' })), code('provider_invalid_result'));
});

test('provider accepts zero token counts and tiny floating-point rounding differences', async () => {
  const value = structuredClone(result);
  value.usage = { input_tokens: 0, output_tokens: 0 };
  const topic = value.answers['topic'];
  assert(topic.type === 'choice');
  topic.probabilities['other'] += 0.000001;
  assert.deepEqual(await evaluateProvider(config, input, 1000, fetchResult(value)), value);
});

test('provider rejects unsupported transport configuration before network access', async () => {
  let calls = 0;
  const request: typeof fetch = async () => { calls++; return encode(result); };
  for (const endpoint of ['ftp://provider/x', 'https://user:secret@provider/x', 'https://provider/x#fragment', '/relative']) {
    await assert.rejects(evaluateProvider({ ...config, endpoint }, input, 1000, request), code('provider_configuration'));
  }
  for (const apiKey of ['', 'contains space', 'secret\nInjected: true']) {
    await assert.rejects(evaluateProvider({ ...config, apiKey }, input, 1000, request), code('provider_configuration'));
  }
  for (const timeout of [0, -1, 0.5, NaN, Infinity, 60_001]) {
    await assert.rejects(evaluateProvider(config, input, timeout, request), code('provider_configuration'));
  }
  assert.equal(calls, 0);
});

test('provider rejects non-JSON content and malformed JSON without exposing bodies', async () => {
  const secret = 'do-not-log-this-provider-body';
  for (const response of [
    new Response(secret, { headers: { 'content-type': 'text/html' } }),
    new Response(`{"secret":"${secret}"`, { headers: { 'content-type': 'application/json' } }),
    new Response('{"value":Infinity}', { headers: { 'content-type': 'application/json' } }),
    new Response(new Uint8Array([0xff, 0xfe]), { headers: { 'content-type': 'application/json' } }),
  ]) {
    await assert.rejects(evaluateProvider(config, input, 1000, async () => response), error => {
      assert(error instanceof ProviderError);
      assert(!error.message.includes(secret));
      return true;
    });
  }
});

test('real HTTP handles the official payload and rejects redirects without following them', async () => {
  let targetCalls = 0;
  await withServer((request, response) => {
    if (request.url === '/target') { targetCalls++; response.end(JSON.stringify(result)); return; }
    response.writeHead(307, { location: '/target' });
    response.end();
  }, async endpoint => {
    await assert.rejects(evaluateProvider({ ...config, endpoint }, input, 1000), ProviderError);
    assert.equal(targetCalls, 0);
  });
});

test('real HTTP overload is attempted once and returned without retry or upstream body disclosure', async () => {
  let calls = 0;
  await withServer((_request, response) => {
    calls++;
    response.writeHead(529, { 'content-type': 'application/json', 'retry-after': '1' });
    response.end('{"detail":"sensitive vendor error"}');
  }, async endpoint => {
    await assert.rejects(evaluateProvider({ ...config, endpoint }, input, 1000), code('provider_http_error'));
    assert.equal(calls, 1);
  });
});

test('total timeout applies while waiting for HTTP response headers', async () => {
  await withServer(() => undefined, async endpoint => {
    const started = performance.now();
    await assert.rejects(evaluateProvider({ ...config, endpoint }, input, 80), code('provider_timeout'));
    assert(performance.now() - started < 1000);
  });
});

test('total timeout also applies during a stalled HTTP response body', async () => {
  await withServer((_request, response) => {
    response.writeHead(200, { 'content-type': 'application/json' });
    response.write('{"model":');
  }, async endpoint => {
    await assert.rejects(evaluateProvider({ ...config, endpoint }, input, 80), code('provider_timeout'));
  });
});

test('deadline remains bounded even if an injected transport ignores the abort signal', async () => {
  let signal: AbortSignal | null | undefined;
  const request: typeof fetch = async (_url, init) => {
    signal = init?.signal;
    return new Promise<Response>(() => undefined);
  };
  await assert.rejects(evaluateProvider(config, input, 30, request), code('provider_timeout'));
  assert(signal?.aborted);
});

test('real HTTP rejects declared oversize and chunked oversize responses', async () => {
  await withServer((_request, response) => {
    response.writeHead(200, { 'content-type': 'application/json', 'content-length': String(MAX_PROVIDER_RESPONSE_BYTES + 1) });
    response.end('x');
  }, async endpoint => {
    await assert.rejects(evaluateProvider({ ...config, endpoint }, input, 1000), code('provider_response_too_large'));
  });
  await withServer((_request, response) => {
    response.writeHead(200, { 'content-type': 'application/json' });
    response.write(' '.repeat(150_000));
    response.end(' '.repeat(150_000));
  }, async endpoint => {
    await assert.rejects(evaluateProvider({ ...config, endpoint }, input, 1000), code('provider_response_too_large'));
  });
});

test('real HTTP accepts exactly the response byte ceiling', async () => {
  const text = JSON.stringify(result);
  const padding = ' '.repeat(MAX_PROVIDER_RESPONSE_BYTES - Buffer.byteLength(text));
  await withServer((_request, response) => {
    response.writeHead(200, { 'content-type': 'application/json; charset=utf-8' });
    response.write(text.slice(0, 30));
    response.write(text.slice(30));
    response.end(padding);
  }, async endpoint => {
    assert.deepEqual(await evaluateProvider({ ...config, endpoint }, input, 1000), result);
  });
});

test('real HTTP decodes a UTF-8 code point split across body chunks', async () => {
  const localizedInput = structuredClone(input);
  const question = localizedInput.questions['impact'];
  assert(question.type === 'score');
  question.criteria[0] = '港口';
  const localizedResult = structuredClone(result);
  const answer = localizedResult.answers['impact'];
  assert(answer.type === 'score');
  answer.legend['0'] = '港口';
  const wire = Buffer.from(JSON.stringify(localizedResult));
  const split = wire.indexOf(Buffer.from('港口')) + 1;
  await withServer((_request, response) => {
    response.writeHead(200, { 'content-type': 'application/json' });
    response.write(wire.subarray(0, split));
    setImmediate(() => response.end(wire.subarray(split)));
  }, async endpoint => {
    assert.deepEqual(await evaluateProvider({ ...config, endpoint }, localizedInput, 1000), localizedResult);
  });
});

test('provider snapshots the submitted schema before yielding to the transport', async () => {
  const mutable = structuredClone(input);
  let finish: (response: Response) => void = () => assert.fail('Transport was not called');
  const request: typeof fetch = async () => new Promise<Response>(resolve => { finish = resolve; });
  const pending = evaluateProvider(config, mutable, 1000, request);
  delete mutable.questions['impact'];
  finish(encode(result));
  assert.deepEqual(await pending, result);
});
