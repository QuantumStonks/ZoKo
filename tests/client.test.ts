import test from 'node:test';
import assert from 'node:assert/strict';
import { AmbiguousDecisionError, ZokoApiError, ZokoClient, formatXec, parseXec, type RegisterSellerOfferInput, type UpdateSellerOfferInput } from '../src/client.js';
import type { DecisionInput } from '../src/protocol.js';

const input: DecisionInput = { state: 'The package was delivered with a damaged screen.', questions: { damaged: { type: 'noul', instructions: 'Is the item described as damaged?' } } };
const quote = { id: 'quote-1', sellerId: 'jev', priceNanos: '100000000', schemaHash: 'schema-hash', requestHash: 'request-hash', expiresAt: new Date(Date.now() + 60000).toISOString(), timeoutMs: 10000, minConfidence: 0 };
const done = { id: 'decision-1', status: 'succeeded', priceNanos: quote.priceNanos, sellerId: 'jev' };
const reply = (body: unknown, status = 200, headers: Record<string, string> = {}) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json', ...headers } });

test('money parsing and formatting preserve nanoXEC far beyond floating point precision', () => {
  const value = '12345678901234567890.000000001';
  assert.equal(formatXec(parseXec(value)), value);
  assert.equal(parseXec('0.01'), '10000000');
  assert.equal(parseXec('1'), '1000000000');
  assert.equal(formatXec('-10000001'), '-0.010000001');
  for (const invalid of ['1e9', '-1', '.1', '1.0000000001', 'NaN', '1,000', '01', '1.']) assert.throws(() => parseXec(invalid));
});

test('SDK rejects cleartext nonlocal origins and URL-embedded credentials', () => {
  for (const baseUrl of ['http://example.com', 'https://user:secret@example.com', 'https://example.com/?key=x', 'https://example.com/#secret']) assert.throws(() => new ZokoClient({ baseUrl, apiKey: 'key' }));
  assert.doesNotThrow(() => new ZokoClient({ baseUrl: 'http://127.0.0.1:3000', apiKey: 'key' }));
});

test('lost decision response retries the same body and key without creating a second quote', async () => {
  const calls: Array<{ url: string; body: string | undefined; key: string | null }> = [];
  let decisions = 0;
  const fetcher: typeof fetch = async (url, init) => {
    calls.push({ url: String(url), body: init?.body?.toString(), key: new Headers(init?.headers).get('Idempotency-Key') });
    if (String(url).endsWith('/v1/quotes')) return reply(quote);
    if (++decisions === 1) throw new TypeError('Response connection dropped after commit');
    return reply(done);
  };
  const client = new ZokoClient({ baseUrl: 'https://zoko.example', apiKey: 'test-key', fetch: fetcher, pollIntervalMs: 1 });
  const result = await client.decide(input, { maxPriceNanos: '100000000' }, { idempotencyKey: 'same-purchase-001' });
  assert.equal(result.id, done.id);
  assert.equal(calls.filter((call) => call.url.endsWith('/v1/quotes')).length, 1);
  assert.equal(calls[1]!.body, calls[2]!.body);
  assert.equal(calls[1]!.key, 'same-purchase-001');
  assert.equal(calls[2]!.key, 'same-purchase-001');
});

test('pending receipt is polled by ID and terminal failures return without fresh inference', async () => {
  const methods: string[] = [];
  const paths: string[] = [];
  const fetcher: typeof fetch = async (url, init) => {
    methods.push(init?.method ?? 'GET'); paths.push(String(url));
    if (methods.length === 1) return reply({ id: 'decision-1', status: 'running' }, 202, { 'retry-after': '0' });
    return reply({ id: 'decision-1', status: 'indeterminate', error: 'Execution deadline expired; refunded' });
  };
  const client = new ZokoClient({ baseUrl: 'https://zoko.example', apiKey: 'test-key', fetch: fetcher, pollIntervalMs: 1 });
  const result = await client.execute('quote-1', input, 'pending-purchase-001');
  assert.equal(result.status, 'indeterminate');
  assert.deepEqual(methods, ['POST', 'GET']);
  assert.ok(paths[1]!.endsWith('/v1/decisions/decision-1'));
});

test('a definitive payload conflict is not retried', async () => {
  let count = 0;
  const fetcher: typeof fetch = async () => { count++; return reply({ error: { code: 'idempotency_conflict', message: 'The key belongs to another input' } }, 409); };
  const client = new ZokoClient({ baseUrl: 'https://zoko.example', apiKey: 'test-key', fetch: fetcher });
  await assert.rejects(client.execute('quote-1', input, 'conflict-purchase-001'), (error: unknown) => error instanceof ZokoApiError && error.status === 409 && error.message === 'The key belongs to another input');
  assert.equal(count, 1);
});

test('upstream 502 recovers a durable terminal refund with the identical original key', async () => {
  const keys: Array<string | null> = [];
  const fetcher: typeof fetch = async (_url, init) => {
    keys.push(new Headers(init?.headers).get('Idempotency-Key'));
    return keys.length === 1 ? reply({ error: { code: 'provider_failure', message: 'Provider failed' } }, 502) : reply({ id: 'decision-1', status: 'failed', error: 'Provider failed' });
  };
  const client = new ZokoClient({ baseUrl: 'https://zoko.example', apiKey: 'test-key', fetch: fetcher });
  assert.equal((await client.execute('quote-1', input, 'failure-purchase-001')).status, 'failed');
  assert.deepEqual(keys, ['failure-purchase-001', 'failure-purchase-001']);
});

test('interrupted post carries recovery information and never silently re-quotes', async () => {
  const controller = new AbortController();
  let calls = 0;
  const fetcher: typeof fetch = async () => { calls++; controller.abort(new Error('User interrupted after dispatch')); throw new TypeError('Connection aborted'); };
  const client = new ZokoClient({ baseUrl: 'https://zoko.example', apiKey: 'test-key', fetch: fetcher });
  await assert.rejects(client.execute('quote-1', input, 'interrupted-purchase-001', controller.signal), (error: unknown) => error instanceof AmbiguousDecisionError && error.quoteId === 'quote-1' && error.idempotencyKey === 'interrupted-purchase-001');
  assert.equal(calls, 1);
});

const registration: RegisterSellerOfferInput = {
  id: 'routing-agent', name: 'Routing agent', endpoint: 'https://agent.example/decide',
  model: 'acme/routing-agent:2026-09', apiKey: 'endpoint-credential', priceNanos: '123456789012345678901',
};
const ownedOffer = { id: registration.id, name: registration.name, endpoint: registration.endpoint, model: registration.model, priceNanos: registration.priceNanos, payoutAccountId: 'seller-account-id', enabled: false, paused: false, commissionBps: 725 };

test('seller offer registration uses agent credentials and preserves its exact custom model and price', async () => {
  const calls: Array<{ method: string | undefined; url: string; auth: string | null; body: unknown }> = [];
  const fetcher: typeof fetch = async (url, init) => {
    calls.push({ url: String(url), method: init?.method, auth: new Headers(init?.headers).get('Authorization'), body: JSON.parse(String(init?.body)) });
    return reply(ownedOffer, 201);
  };
  const client = new ZokoClient({ baseUrl: 'https://zoko.example', apiKey: 'seller-agent-key', fetch: fetcher });
  const offer = await client.registerOffer(registration);
  assert.deepEqual(calls, [{ url: 'https://zoko.example/v1/seller/offers', method: 'POST', auth: 'Bearer seller-agent-key', body: registration }]);
  assert.equal(offer.model, 'acme/routing-agent:2026-09');
  assert.equal(offer.priceNanos, '123456789012345678901');
  assert.equal(offer.enabled, false);
  assert.equal('apiKey' in offer, false);
});

test('seller listing pagination is explicit, bounded and does not fetch another page automatically', async () => {
  const urls: string[] = [];
  const fetcher: typeof fetch = async (url) => { urls.push(String(url)); return reply({ offers: [ownedOffer], nextCursor: 'routing-agent' }); };
  const client = new ZokoClient({ baseUrl: 'https://zoko.example', apiKey: 'seller-agent-key', fetch: fetcher });
  const page = await client.listOffers({ limit: 20, after: 'prior-agent' });
  assert.equal(page.nextCursor, 'routing-agent');
  assert.deepEqual(urls, ['https://zoko.example/v1/seller/offers?limit=20&after=prior-agent']);
  for (const limit of [0, 101, 1.5]) assert.throws(() => client.listOffers({ limit }));
  assert.throws(() => client.listOffers({ after: '../other-owner' }));
  assert.equal(urls.length, 1);
});

test('seller controls cannot submit ownership, approval or endpoint identity changes', () => {
  let calls = 0;
  const fetcher: typeof fetch = async () => { calls++; return reply(ownedOffer); };
  const client = new ZokoClient({ baseUrl: 'https://zoko.example', apiKey: 'seller-agent-key', fetch: fetcher });
  for (const forbidden of [{ enabled: true }, { payoutAccountId: 'other-account' }, { ownerAccountId: 'other-account' }]) assert.throws(() => client.registerOffer({ ...registration, ...forbidden } as RegisterSellerOfferInput));
  for (const forbidden of [{ enabled: true }, { payoutAccountId: 'other-account' }, { endpoint: 'https://different.example' }, { model: 'different-model' }]) assert.throws(() => client.updateOffer(registration.id, forbidden as UpdateSellerOfferInput));
  assert.throws(() => client.updateOffer(registration.id, {}));
  assert.throws(() => client.updateOffer(registration.id, { priceNanos: '0' }));
  assert.throws(() => client.updateOffer(registration.id, { priceNanos: '1.5' }));
  assert.equal(calls, 0);
});

test('seller updates explicitly set price, credential and paused state without automatically retrying an uncertain mutation', async () => {
  const bodies: unknown[] = [];
  const fetcher: typeof fetch = async (url, init) => {
    assert.equal(String(url), 'https://zoko.example/v1/seller/offers/routing-agent');
    assert.equal(init?.method, 'PATCH');
    bodies.push(JSON.parse(String(init?.body)));
    if (bodies.length === 1) return reply({ ...ownedOffer, priceNanos: '123', paused: true });
    throw new TypeError('Reply lost after update');
  };
  const client = new ZokoClient({ baseUrl: 'https://zoko.example', apiKey: 'seller-agent-key', fetch: fetcher });
  const offer = await client.updateOffer('routing-agent', { priceNanos: '123', paused: true, apiKey: 'rotated-credential' });
  assert.equal(offer.paused, true);
  assert.deepEqual(bodies[0], { priceNanos: '123', paused: true, apiKey: 'rotated-credential' });
  await assert.rejects(client.updateOffer('routing-agent', { paused: false }), /Reply lost/);
  assert.equal(bodies.length, 2);
});
