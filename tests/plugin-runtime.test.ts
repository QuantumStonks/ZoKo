import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createServer, type IncomingHttpHeaders } from 'node:http';
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { AmbiguousDecisionError, ZokoApiError, ZokoClient } from '../src/client.js';
import type { DecisionInput } from '../src/protocol.js';

const input: DecisionInput = { state: { delivery: 'damaged' }, questions: { damaged: { type: 'noul', instructions: 'Is the delivery damaged?' } } };
const account = 'bf51117d-bd65-491e-b16d-aa9006cb1674';
const quote = { id: '8712d739-f188-4074-a646-d313704fd4ac', sellerId: 'routing-agent', priceNanos: '100000000', schemaHash: 'schema-hash', requestHash: 'request-hash', expiresAt: '2099-01-01T00:00:00.000Z', timeoutMs: 10000, minConfidence: 0 };
const receipt = { id: 'c0334b73-8fc1-4f29-b64c-d4d69a9d544a', status: 'succeeded', priceNanos: quote.priceNanos, sellerId: quote.sellerId, accepted: true };
const reply = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
const cliPath = fileURLToPath(new URL('../src/cli.ts', import.meta.url));

type Call = { method: string; path: string; headers: IncomingHttpHeaders; body?: unknown };
async function server(t: TestContext, handler: (call: Call) => Promise<{ body: unknown; status?: number }> | { body: unknown; status?: number }) {
  const calls: Call[] = [];
  const app = createServer(async (request, response) => {
    try {
      const chunks: Buffer[] = [];
      for await (const chunk of request) chunks.push(Buffer.from(chunk));
      const data = Buffer.concat(chunks).toString('utf8');
      const call = { method: request.method!, path: request.url!, headers: request.headers, body: data ? JSON.parse(data) as unknown : undefined };
      calls.push(call);
      const result = await handler(call);
      response.writeHead(result.status ?? 200, { 'content-type': 'application/json' });
      response.end(JSON.stringify(result.body));
    } catch (error) {
      response.writeHead(500, { 'content-type': 'application/json' });
      response.end(JSON.stringify({ error: error instanceof Error ? error.message : 'Fixture failed' }));
    }
  });
  await new Promise<void>((resolve) => app.listen(0, '127.0.0.1', resolve));
  t.after(async () => { app.closeAllConnections(); await new Promise<void>((resolve, reject) => app.close((error) => error ? reject(error) : resolve())); });
  const address = app.address();
  assert.ok(address && typeof address !== 'string');
  return { url: `http://127.0.0.1:${address.port}`, calls };
}
async function fixture(t: TestContext) {
  const directory = await mkdtemp(join(tmpdir(), 'zoko-plugin-runtime-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const inputFile = join(directory, 'decision.json');
  await writeFile(inputFile, JSON.stringify(input));
  return { directory, inputFile, journal: join(directory, 'purchase.json') };
}
async function cli(args: string[], baseUrl: string, extraEnv: Record<string, string> = {}) {
  return new Promise<{ code: number | null; stdout: string; stderr: string }>((resolve, reject) => {
    const child = spawn(process.execPath, ['--import', 'tsx', cliPath, ...args], {
      env: { ...process.env, ZOKO_URL: baseUrl, ZOKO_API_KEY: 'plugin-test-key', ...extraEnv },
      stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true,
    });
    let stdout = '', stderr = '';
    const timer = setTimeout(() => { child.kill(); reject(new Error('CLI fixture exceeded 20 seconds.')); }, 20_000);
    child.stdout.setEncoding('utf8').on('data', (chunk: string) => { stdout += chunk; });
    child.stderr.setEncoding('utf8').on('data', (chunk: string) => { stderr += chunk; });
    child.on('error', (error) => { clearTimeout(timer); reject(error); });
    child.on('close', (code) => { clearTimeout(timer); resolve({ code, stdout, stderr }); });
  });
}

test('public discovery/catalog/probes omit authorization even with a configured account', async () => {
  const paths: string[] = [];
  const fetcher: typeof fetch = async (url, options) => {
    paths.push(String(url));
    assert.equal(new Headers(options?.headers).get('authorization'), null);
    assert.equal(options?.redirect, 'error');
    assert.equal(options?.cache, 'no-store');
    return reply({ ok: true });
  };
  const client = new ZokoClient({ baseUrl: 'https://zoko.example', apiKey: 'private-key', fetch: fetcher });
  await client.discover(); await client.catalog(); await client.health('ready');
  assert.deepEqual(paths, ['https://zoko.example/.well-known/zoko.json', 'https://zoko.example/v1/catalog', 'https://zoko.example/health/ready']);
  const anonymous = new ZokoClient({ baseUrl: 'https://zoko.example', fetch: fetcher });
  await assert.rejects(anonymous.me(), /ZOKO_API_KEY/);
  await assert.rejects(anonymous.execute(quote.id, input, 'anonymous-test-001'), /ZOKO_API_KEY/);
  assert.equal(paths.length, 3);
});

test('transport rejects unsafe API paths and malformed account keys before network access', async () => {
  const client = new ZokoClient({ baseUrl: 'https://zoko.example/market', apiKey: 'private-key', fetch: async () => { assert.fail('Unsafe request dispatched'); } });
  for (const path of ['//another.example', '/\\another.example', '/../other', '/%2e%2e/other', '/v1/me#secret', '/v1/me\r\nInjected: value']) await assert.rejects(client.request('GET', path), /API path/);
  for (const apiKey of ['', ' padded', 'with space', 'line\r\nbreak', 'x'.repeat(513)]) assert.throws(() => new ZokoClient({ baseUrl: 'https://zoko.example', apiKey }), /API key/);
});

test('same-key retry snapshots nested caller input before first dispatch', async () => {
  const mutable = structuredClone(input);
  const payloads: string[] = [];
  const client = new ZokoClient({ baseUrl: 'https://zoko.example', apiKey: 'private-key', fetch: async (_url, options) => {
    payloads.push(String(options?.body));
    if (payloads.length === 1) {
      (mutable.state as Record<string, string>).delivery = 'changed after dispatch';
      throw new TypeError('Lost response after commit');
    }
    return reply(receipt);
  } });
  assert.equal((await client.execute(quote.id, mutable, 'immutable-key-001')).id, receipt.id);
  assert.equal(payloads.length, 2);
  assert.equal(payloads[0], payloads[1]);
  assert.equal((JSON.parse(payloads[1]!) as { state: { delivery: string } }).state.delivery, 'damaged');
});

test('a rejected poll preserves an ambiguous original purchase identity', async () => {
  let count = 0;
  const client = new ZokoClient({ baseUrl: 'https://zoko.example', apiKey: 'private-key', pollIntervalMs: 1, fetch: async () => ++count === 1 ? reply({ id: receipt.id, status: 'running' }, 202) : reply({ error: 'Credential revoked' }, 401) });
  await assert.rejects(client.execute(quote.id, input, 'ambiguous-poll-001'), (error: unknown) => error instanceof AmbiguousDecisionError && error.decisionId === receipt.id && error.cause instanceof ZokoApiError && error.cause.status === 401);
  assert.equal(count, 2);
});

test('lost dispatch followed by an application rejection remains recoverable', async () => {
  let count = 0;
  const client = new ZokoClient({ baseUrl: 'https://zoko.example', apiKey: 'private-key', fetch: async () => {
    if (++count === 1) throw new TypeError('Connection lost after dispatch');
    return reply({ error: 'Account unavailable' }, 403);
  } });
  await assert.rejects(client.execute(quote.id, input, 'ambiguous-dispatch-001'), (error: unknown) => error instanceof AmbiguousDecisionError && error.quoteId === quote.id);
  assert.equal(count, 2);
});

test('invalid terminal status and changed receipt identity never count as completion', async () => {
  for (const wrong of [{ id: receipt.id, status: 'unknown' }, { ...receipt, id: 'different-decision' }]) {
    let count = 0;
    const client = new ZokoClient({ baseUrl: 'https://zoko.example', apiKey: 'private-key', pollIntervalMs: 1, maxWaitMs: 30, fetch: async () => ++count === 1 ? reply({ id: receipt.id, status: 'running' }, 202) : reply(wrong) });
    await assert.rejects(client.execute(quote.id, input, 'invalid-receipt-001'), (error: unknown) => error instanceof AmbiguousDecisionError && error.decisionId === receipt.id);
  }
});

test('a quote outside the exact buyer ceiling never reaches paid execution', async () => {
  let count = 0;
  const client = new ZokoClient({ baseUrl: 'https://zoko.example', apiKey: 'private-key', fetch: async (url) => {
    assert.ok(String(url).endsWith('/v1/quotes')); count++;
    return reply({ ...quote, priceNanos: '100000001' });
  } });
  await assert.rejects(client.decide(input, { maxPriceNanos: '100000000' }), /outside the requested purchase policy/);
  assert.equal(count, 1);
});

test('CLI anonymous discovery works while account access fails before network', async (t) => {
  const service = await server(t, () => ({ body: { name: 'Zoko', payment: { method: 'custodial_prepaid_balance' } } }));
  const discovery = await cli(['discover'], service.url, { ZOKO_API_KEY: '' });
  assert.equal(discovery.code, 0, discovery.stderr);
  assert.equal(JSON.parse(discovery.stdout).name, 'Zoko');
  assert.equal(service.calls[0]?.headers.authorization, undefined);
  const account = await cli(['me'], service.url, { ZOKO_API_KEY: '' });
  assert.equal(account.code, 1);
  assert.match(account.stderr, /ZOKO_API_KEY/);
  assert.equal(service.calls.length, 1);
});

test('staged CLI quote journals before dispatch and recovery reuses the exact purchase', async (t) => {
  const files = await fixture(t);
  const service = await server(t, async (call) => {
    if (call.path === '/v1/me') return { body: { account: { id: account } } };
    if (call.path === '/v1/quotes') return { body: quote };
    assert.equal(call.path, '/v1/decisions');
    const saved = JSON.parse(await readFile(files.journal, 'utf8'));
    const attempt = JSON.parse(await readFile(`${files.journal}.attempt.json`, 'utf8'));
    assert.equal(saved.accountId, account);
    assert.equal(saved.idempotencyKey, call.headers['idempotency-key']);
    assert.equal(attempt.idempotencyKey, saved.idempotencyKey);
    assert.deepEqual(call.body, { quoteId: saved.quoteId, ...saved.input });
    assert.equal(saved.version, 2);
    assert.equal(saved.quote.priceNanos, '100000000');
    assert.equal(JSON.stringify(saved).includes('plugin-test-key'), false);
    return { body: receipt };
  });
  const prepare = await cli(['quote', '--input', files.inputFile, '--max-price', '0.1', '--journal', files.journal, '--key', 'staged-purchase-001'], service.url);
  assert.equal(prepare.code, 0, prepare.stderr);
  assert.equal(service.calls.filter((call) => call.path === '/v1/decisions').length, 0);
  await assert.rejects(readFile(`${files.journal}.attempt.json`), { code: 'ENOENT' });
  const original = await readFile(files.journal, 'utf8');
  for (const command of ['execute', 'recover']) {
    const result = await cli([command, '--journal', files.journal], service.url);
    assert.equal(result.code, 0, result.stderr);
    assert.deepEqual(JSON.parse(result.stdout), receipt);
  }
  assert.equal(service.calls.filter((call) => call.path === '/v1/quotes').length, 1);
  const purchases = service.calls.filter((call) => call.path === '/v1/decisions');
  assert.equal(purchases.length, 2);
  assert.deepEqual(purchases[0]?.body, purchases[1]?.body);
  assert.equal(purchases[0]?.headers['idempotency-key'], purchases[1]?.headers['idempotency-key']);
  assert.equal(await readFile(files.journal, 'utf8'), original);
});

test('automatic CLI journals are outside the plugin and repeated decide cannot requote', async (t) => {
  const files = await fixture(t);
  const journalDirectory = join(files.directory, 'private-purchases');
  const service = await server(t, async (call) => {
    if (call.path === '/v1/me') return { body: { account: { id: account } } };
    if (call.path === '/v1/quotes') return { body: quote };
    const journals = (await readdir(journalDirectory)).filter((name) => !name.endsWith('.attempt.json'));
    assert.equal(journals.length, 1);
    const saved = JSON.parse(await readFile(join(journalDirectory, journals[0]!), 'utf8'));
    assert.equal(saved.quoteId, quote.id);
    return { body: receipt };
  });
  const args = ['decide', '--input', files.inputFile, '--max-price', '0.1', '--key', 'automatic-purchase-001'];
  const result = await cli(args, service.url, { ZOKO_JOURNAL_DIR: journalDirectory });
  assert.equal(result.code, 0, result.stderr);
  const event = JSON.parse(result.stderr.trim());
  assert.equal(event.event, 'purchase_prepared');
  assert.equal(event.journal.startsWith(journalDirectory), true);
  const originalCount = service.calls.length;
  const duplicate = await cli(args, service.url, { ZOKO_JOURNAL_DIR: journalDirectory });
  assert.equal(duplicate.code, 1);
  assert.match(duplicate.stderr, /recover/);
  assert.equal(service.calls.length, originalCount);
});

test('CLI recovery refuses different service and different account without execution', async (t) => {
  const files = await fixture(t);
  const service = await server(t, () => ({ body: { account: { id: 'different-account' } } }));
  const journal = { version: 2, baseUrl: service.url, accountId: account, quoteId: quote.id, idempotencyKey: 'bound-purchase-001', input };
  await writeFile(files.journal, JSON.stringify(journal));
  const mismatch = await cli(['recover', '--journal', files.journal], service.url);
  assert.equal(mismatch.code, 1);
  assert.match(mismatch.stderr, /different Zoko account/);
  assert.deepEqual(service.calls.map((call) => call.path), ['/v1/me']);
  await writeFile(files.journal, JSON.stringify({ ...journal, baseUrl: 'https://different.example' }));
  const otherService = await cli(['recover', '--journal', files.journal], service.url);
  assert.equal(otherService.code, 1);
  assert.match(otherService.stderr, /journal URL differs/);
  assert.equal(service.calls.length, 1);
});

test('legacy version-1 recovery preserves original body and idempotency key', async (t) => {
  const files = await fixture(t);
  const service = await server(t, (call) => {
    assert.equal(call.path, '/v1/decisions');
    assert.equal(call.headers['idempotency-key'], 'legacy-purchase-001');
    assert.deepEqual(call.body, { quoteId: quote.id, ...input });
    return { body: { ...receipt, status: 'indeterminate' } };
  });
  await writeFile(files.journal, JSON.stringify({ version: 1, baseUrl: service.url, quoteId: quote.id, idempotencyKey: 'legacy-purchase-001', input }));
  const result = await cli(['recover', '--journal', files.journal], service.url);
  assert.equal(result.code, 0, result.stderr);
  assert.equal(JSON.parse(result.stdout).status, 'indeterminate');
  assert.equal(service.calls.length, 1);
});

test('ordinary seller CLI routes to owned offers and rejects approval escalation locally', async (t) => {
  const files = await fixture(t);
  const registration = { id: 'routing-agent', name: 'Routing agent', endpoint: 'https://agent.example/decide', apiKey: 'endpoint-secret', model: 'routing-agent-v1', priceNanos: '100000000' };
  const { apiKey: _credential, ...publicOffer } = registration;
  const service = await server(t, (call) => {
    assert.equal(call.headers.authorization, 'Bearer plugin-test-key');
    assert.ok(call.path.startsWith('/v1/seller/offers'));
    return { body: call.method === 'GET' ? { offers: [publicOffer], nextCursor: null } : publicOffer };
  });
  const offerFile = join(files.directory, 'offer.json');
  await writeFile(offerFile, JSON.stringify(registration));
  const register = await cli(['seller', 'register', '--input', offerFile], service.url);
  assert.equal(register.code, 0, register.stderr);
  assert.equal(register.stdout.includes('endpoint-secret'), false);
  assert.deepEqual(service.calls[0]?.body, registration);
  const list = await cli(['seller', 'list', '--limit', '10', '--after', 'prior-offer'], service.url);
  assert.equal(list.code, 0, list.stderr);
  assert.equal(service.calls[1]?.path, '/v1/seller/offers?limit=10&after=prior-offer');
  await writeFile(offerFile, JSON.stringify({ paused: true, priceNanos: '123' }));
  const update = await cli(['seller', 'update', '--id', registration.id, '--input', offerFile], service.url);
  assert.equal(update.code, 0, update.stderr);
  assert.equal(service.calls[2]?.method, 'PATCH');
  await writeFile(offerFile, JSON.stringify({ enabled: true }));
  const escalation = await cli(['seller', 'update', '--id', registration.id, '--input', offerFile], service.url);
  assert.equal(escalation.code, 1);
  assert.equal(service.calls.length, 3);
});

test('ambiguous CLI polling and restarted authentication failure retain exit 2 and the original identity', async (t) => {
  const files = await fixture(t);
  let revoked = false;
  const service = await server(t, (call) => {
    if (call.path === '/v1/me') return revoked ? { body: { error: 'Credential revoked' }, status: 401 } : { body: { account: { id: account } } };
    if (call.path === '/v1/quotes') return { body: quote };
    if (call.method === 'POST') return { body: { id: receipt.id, status: 'running' }, status: 202 };
    return { body: { error: 'Credential revoked after dispatch' }, status: 401 };
  });
  const result = await cli(['decide', '--input', files.inputFile, '--max-price', '0.1', '--journal', files.journal], service.url);
  assert.equal(result.code, 2, result.stderr);
  const error = JSON.parse(result.stderr.trim().split('\n').at(-1)!);
  assert.equal(error.error, 'AmbiguousDecisionError');
  assert.equal(error.decisionId, receipt.id);
  const saved = JSON.parse(await readFile(files.journal, 'utf8'));
  assert.equal(error.idempotencyKey, saved.idempotencyKey);
  assert.equal(service.calls.filter((call) => call.path === '/v1/quotes').length, 1);
  revoked = true;
  const restarted = await cli(['recover', '--journal', files.journal], service.url);
  assert.equal(restarted.code, 2, restarted.stderr);
  const recoveredError = JSON.parse(restarted.stderr.trim());
  assert.equal(recoveredError.error, 'AmbiguousDecisionError');
  assert.equal(recoveredError.idempotencyKey, saved.idempotencyKey);
  const rawReplay = await cli(['execute', '--input', files.inputFile, '--quote', saved.quoteId, '--key', saved.idempotencyKey, '--journal', files.journal], service.url);
  assert.equal(rawReplay.code, 2, rawReplay.stderr);
  assert.equal(JSON.parse(rawReplay.stderr.trim()).idempotencyKey, saved.idempotencyKey);
  assert.equal(service.calls.filter((call) => call.path === '/v1/decisions').length, 1);
  assert.equal(service.calls.filter((call) => call.path === '/v1/quotes').length, 1);
});

test('legacy recovery authentication failure is ambiguous across process restarts', async (t) => {
  const files = await fixture(t);
  const service = await server(t, () => ({ body: { error: 'Credential revoked' }, status: 401 }));
  await writeFile(files.journal, JSON.stringify({ version: 1, baseUrl: service.url, quoteId: quote.id, idempotencyKey: 'legacy-unknown-001', input }));
  const result = await cli(['recover', '--journal', files.journal], service.url);
  assert.equal(result.code, 2, result.stderr);
  assert.equal(service.calls.length, 1);
});

test('mismatching dispatch markers cannot be overwritten or send another purchase', async (t) => {
  const files = await fixture(t);
  const service = await server(t, () => ({ body: { account: { id: account } } }));
  await writeFile(files.journal, JSON.stringify({ version: 2, baseUrl: service.url, accountId: account, quoteId: quote.id, idempotencyKey: 'original-purchase-001', input }));
  const marker = JSON.stringify({ version: 1, baseUrl: service.url, accountId: account, quoteId: quote.id, idempotencyKey: 'different-purchase-001', attemptedAt: '2026-09-29T00:00:00.000Z' });
  await writeFile(`${files.journal}.attempt.json`, marker);
  const result = await cli(['recover', '--journal', files.journal], service.url);
  assert.equal(result.code, 1, result.stderr);
  assert.match(result.stderr, /Dispatch marker differs/);
  assert.deepEqual(service.calls.map((call) => call.path), ['/v1/me']);
  assert.equal(await readFile(`${files.journal}.attempt.json`, 'utf8'), marker);
});

test('oversized files and unexpected positional arguments fail before API calls', async (t) => {
  const files = await fixture(t);
  const service = await server(t, () => { assert.fail('Invalid input reached the API'); });
  await writeFile(files.inputFile, ' '.repeat(32769));
  const tooLarge = await cli(['quote', '--input', files.inputFile, '--max-price', '0.1'], service.url);
  assert.equal(tooLarge.code, 1);
  assert.match(tooLarge.stderr, /exceeds 32768/);
  const extra = await cli(['doctor', 'unexpected'], service.url);
  assert.equal(extra.code, 1);
  assert.equal(service.calls.length, 0);
});
