import assert from 'node:assert/strict';
import { randomBytes, randomUUID } from 'node:crypto';
import { after, afterEach, before, describe, test } from 'node:test';
import type { FastifyInstance } from 'fastify';
import pg from 'pg';
import { readConfig, type Config } from '../src/config.js';
import { auditLedger, transaction, transfer, type Db } from '../src/db.js';
import { migrate } from '../src/migration.js';
import { Payments } from '../src/payments/index.js';
import type { ProviderResult } from '../src/provider.js';
import { buildServer } from '../src/server.js';

const databaseUrl = process.env.TEST_DATABASE_URL;
const input = {
  state: { message: 'The site is down.' },
  questions: { urgent: { type: 'noul', instructions: 'Is this an outage?' } },
};
const providerResult: ProviderResult = {
  model: 'jev-1.13.0', answers: { urgent: { type: 'noul', noul: 0.95 } },
  usage: { input_tokens: 100, output_tokens: 10 },
};

describe('Fastify API boundaries with real PostgreSQL', {
  skip: databaseUrl ? false : 'Set TEST_DATABASE_URL to run authenticated HTTP and ownership integration tests.',
  concurrency: false,
  timeout: 120_000,
}, () => {
  const schema = `zoko_http_${randomUUID().replaceAll('-', '')}`;
  let control: pg.Pool;
  let db: Db;
  let config: Config;
  let app: FastifyInstance;
  let calls = 0;
  let providerOverride: (() => Promise<ProviderResult>) | undefined;

  before(async () => {
    assert.ok(databaseUrl);
    control = new pg.Pool({ connectionString: databaseUrl, max: 1, connectionTimeoutMillis: 5000 });
    await control.query(`CREATE SCHEMA ${schema}`);
    db = new pg.Pool({ connectionString: databaseUrl, options: `-c search_path=${schema} -c timezone=UTC`, max: 10, connectionTimeoutMillis: 5000 });
    config = readConfig({
      NODE_ENV: 'test', DATABASE_URL: databaseUrl,
      ZOKO_ADMIN_TOKEN: randomBytes(32).toString('hex'),
      ZOKO_ENCRYPTION_KEY: randomBytes(32).toString('base64'),
      ZOKO_PROVIDER_HOSTS: 'api.typesafe.ai',
      ZOKO_PAYMENTS_ENABLED: 'false',
    });
    await migrate(db);
    const payments = new Payments(db, config.payments);
    await payments.preflight();
    app = await buildServer(config, db, payments, async () => {
      calls++;
      return providerOverride ? providerOverride() : structuredClone(providerResult);
    });
    await app.ready();
  });

  afterEach(async () => {
    providerOverride = undefined;
    if (!db) return;
    const audit = await auditLedger(db) as { ok: boolean; totalNanos: string };
    assert.equal(audit.ok, true, JSON.stringify(audit));
    assert.equal(audit.totalNanos, '0');
  });

  after(async () => {
    if (app) await app.close();
    if (db) await db.end();
    if (control) {
      try { await control.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`); }
      finally { await control.end(); }
    }
  });

  function request(method: 'GET' | 'POST' | 'PATCH', url: string, payload?: unknown, token?: string, idempotencyKey?: string) {
    return app.inject({
      method, url,
      headers: {
        ...(token ? { authorization: `Bearer ${token}` } : {}),
        ...(payload === undefined ? {} : { 'content-type': 'application/json' }),
        ...(idempotencyKey ? { 'idempotency-key': idempotencyKey } : {}),
      },
      payload: payload === undefined ? undefined : JSON.stringify(payload),
    });
  }

  async function account(name = 'HTTP integration buyer', allowedSellers?: string[]) {
    const response = await request('POST', '/v1/admin/accounts', {
      name, dailyLimitNanos: '100000', maxPriceNanos: '10000', ...(allowedSellers ? { allowedSellers } : {}),
    }, config.adminToken);
    assert.equal(response.statusCode, 201, response.body);
    const created = response.json<{ id: string; apiKey: string; name: string }>();
    assert.match(created.id, /^[a-f0-9-]{36}$/);
    assert.match(created.apiKey, /^zoko_/);
    return created;
  }

  async function fixture(balance = 1000n) {
    const sellerId = `http-${randomUUID()}`;
    const buyer = await account('HTTP buyer', [sellerId]);
    const seller = await account('HTTP seller', []);
    const providerKey = randomBytes(24).toString('hex');
    const createdSeller = await request('POST', '/v1/admin/sellers', {
      id: sellerId, name: 'HTTP provider', endpoint: 'https://api.typesafe.ai/v1/systemone',
      apiKey: providerKey, model: providerResult.model, priceNanos: '250', payoutAccountId: seller.id,
    }, config.adminToken);
    assert.equal(createdSeller.statusCode, 201, createdSeller.body);
    if (balance > 0n) await transaction(db, tx => transfer(tx, `http-funding:${buyer.id}`, 'external', `available:${buyer.id}`, balance));
    return { buyer, seller, sellerId, providerKey };
  }

  async function quote(apiKey: string) {
    const response = await request('POST', '/v1/quotes', { ...input, policy: { maxPriceNanos: '250' } }, apiKey);
    assert.equal(response.statusCode, 200, response.body);
    return response.json<{ id: string; priceNanos: string; schemaHash: string }>();
  }

  test('liveness is separate from readiness and protected responses carry browser security headers', async () => {
    const live = await request('GET', '/health/live');
    assert.equal(live.statusCode, 200);
    assert.equal(live.json().ok, true);
    const notReady = await request('GET', '/health/ready');
    assert.equal(notReady.statusCode, 503);
    assert.equal(notReady.json().enabledSellers, 0);
    await fixture(0n);
    const ready = await request('GET', '/health/ready');
    assert.equal(ready.statusCode, 200, ready.body);
    assert.equal(ready.json().payments.enabled, false);
    assert.equal(ready.headers['x-content-type-options'], 'nosniff');
    assert.equal(ready.headers['cache-control'], 'no-store');
    assert.equal(ready.headers['x-frame-options'], 'DENY');
    assert.match(String(ready.headers['content-security-policy']), /frame-ancestors 'none'/);
    assert.equal(ready.headers['access-control-allow-origin'], undefined);
  });

  test('operator and buyer credentials have distinct authority', async () => {
    const buyer = await account();
    assert.equal((await request('GET', '/v1/me')).statusCode, 401);
    assert.equal((await request('GET', '/v1/admin/overview')).statusCode, 401);
    assert.equal((await request('GET', '/v1/admin/overview', undefined, buyer.apiKey)).statusCode, 401);
    assert.equal((await request('GET', '/v1/me', undefined, config.adminToken)).statusCode, 401);
    assert.equal((await request('GET', '/v1/me', undefined, buyer.apiKey)).statusCode, 200);
    const attemptedAdmin = await request('POST', '/v1/admin/accounts', { name: 'Unauthorized account', dailyLimitNanos: '1000', maxPriceNanos: '250' }, buyer.apiKey);
    assert.equal(attemptedAdmin.statusCode, 401);
    const count = await db.query('SELECT count(*)::integer AS n FROM accounts WHERE name=$1', ['Unauthorized account']);
    assert.equal(count.rows[0].n, 0);
  });

  test('buyer and provider secrets are not exposed in stored hashes, catalog, account views, or overview', async () => {
    const context = await fixture();
    const stored = await db.query('SELECT api_key_hash FROM accounts WHERE id=$1', [context.buyer.id]);
    assert.match(stored.rows[0].api_key_hash, /^[a-f0-9]{64}$/);
    assert.notEqual(stored.rows[0].api_key_hash, context.buyer.apiKey);
    const encrypted = await db.query('SELECT api_key_encrypted FROM sellers WHERE id=$1', [context.sellerId]);
    assert.match(encrypted.rows[0].api_key_encrypted, /^v1:/);
    assert.equal(encrypted.rows[0].api_key_encrypted.includes(context.providerKey), false);
    const responses = await Promise.all([
      request('GET', '/v1/catalog'),
      request('GET', '/v1/me', undefined, context.buyer.apiKey),
      request('GET', '/v1/admin/overview', undefined, config.adminToken),
    ]);
    for (const response of responses) {
      assert.equal(response.statusCode, 200, response.body);
      assert.equal(response.body.includes(context.providerKey), false);
      assert.equal(response.body.includes(context.buyer.apiKey), false);
      assert.equal(response.body.includes(config.adminToken), false);
      assert.doesNotMatch(response.body, /api_key_hash|api_key_encrypted|"apiKey"/);
    }
  });

  test('key rotation immediately revokes the old key and disabling an account revokes the replacement', async () => {
    const buyer = await account();
    const rotated = await request('POST', `/v1/admin/accounts/${buyer.id}/rotate-key`, undefined, config.adminToken);
    assert.equal(rotated.statusCode, 200, rotated.body);
    const key = rotated.json<{ apiKey: string }>().apiKey;
    assert.notEqual(key, buyer.apiKey);
    assert.equal((await request('GET', '/v1/me', undefined, buyer.apiKey)).statusCode, 401);
    assert.equal((await request('GET', '/v1/me', undefined, key)).statusCode, 200);
    const disabled = await request('PATCH', `/v1/admin/accounts/${buyer.id}`, { disabled: true }, config.adminToken);
    assert.equal(disabled.statusCode, 200, disabled.body);
    assert.equal((await request('GET', '/v1/me', undefined, key)).statusCode, 401);
  });

  test('quotes, purchase receipts, and history remain scoped to their buyer', async () => {
    const first = await fixture();
    const second = await fixture();
    const offer = await quote(first.buyer.apiKey);
    const priorCalls = calls;
    const stolen = await request('POST', '/v1/decisions', { quoteId: offer.id, ...input }, second.buyer.apiKey, randomUUID());
    assert.equal(stolen.statusCode, 404, stolen.body);
    assert.equal(calls, priorCalls);
    const purchased = await request('POST', '/v1/decisions', { quoteId: offer.id, ...input }, first.buyer.apiKey, randomUUID());
    assert.equal(purchased.statusCode, 200, purchased.body);
    const receipt = purchased.json<{ id: string; status: string; priceNanos: string }>();
    assert.equal(receipt.status, 'succeeded');
    assert.equal(receipt.priceNanos, '250');
    assert.equal((await request('GET', `/v1/decisions/${receipt.id}`, undefined, second.buyer.apiKey)).statusCode, 404);
    const own = await request('GET', `/v1/decisions/${receipt.id}`, undefined, first.buyer.apiKey);
    assert.deepEqual(own.json(), purchased.json());
    const others = await request('GET', '/v1/decisions', undefined, second.buyer.apiKey);
    assert.deepEqual(others.json().decisions, []);
    const me = await request('GET', '/v1/me', undefined, first.buyer.apiKey);
    assert.equal(me.json().balanceNanos, '750');
    assert.equal(me.json().reservedNanos, '0');
    assert.equal(me.json().spending.spentNanos, '250');
  });

  test('unfunded buyers receive a payment-required response without provider work or fabricated credit', async () => {
    const context = await fixture(0n);
    const offer = await quote(context.buyer.apiKey);
    const priorCalls = calls;
    const purchase = await request('POST', '/v1/decisions', { quoteId: offer.id, ...input }, context.buyer.apiKey, randomUUID());
    assert.equal(purchase.statusCode, 402, purchase.body);
    assert.equal(purchase.json().error.code, 'payment_required');
    assert.equal(purchase.json().error.details.requiredNanos, '250');
    assert.equal(calls, priorCalls);
    const me = await request('GET', '/v1/me', undefined, context.buyer.apiKey);
    assert.equal(me.json().balanceNanos, '0');
    assert.equal(me.json().reservedNanos, '0');
  });

  test('disabled payments return their explicit service error without allocating an address or balance', async () => {
    const buyer = await account();
    const response = await request('POST', '/v1/deposit-address', undefined, buyer.apiKey);
    assert.equal(response.statusCode, 503, response.body);
    assert.equal(response.json().error.code, 'payments_disabled');
    const stored = await db.query('SELECT deposit_address FROM accounts WHERE id=$1', [buyer.id]);
    assert.equal(stored.rows[0].deposit_address, null);
    const me = await request('GET', '/v1/me', undefined, buyer.apiKey);
    assert.equal(me.json().balanceNanos, '0');
    assert.equal(me.json().reservedNanos, '0');
  });

  test('deposit history attributes outputs to the authenticated buyer without minting credit', async () => {
    const first=await account('Funding history buyer');
    const second=await account('Unrelated funding buyer');
    const ownTx=randomBytes(32).toString('hex'),otherTx=randomBytes(32).toString('hex');
    for(const [owner,txid] of [[first.id,ownTx],[second.id,otherTx]]) {
      await db.query(`INSERT INTO payments_deposits(network,txid,vout,account_id,amount_nanos,address,status)
        VALUES('mainnet',$1,0,$2,'100000000000','ecash:pending-test-fixture','pending')`,[txid,owner]);
    }
    assert.equal((await request('GET','/v1/deposits')).statusCode,401);
    const history=await request('GET','/v1/deposits',undefined,first.apiKey);
    assert.equal(history.statusCode,200,history.body);
    const deposits=history.json().deposits;
    assert.equal(deposits.length,1);
    assert.equal(deposits[0].txid,ownTx);
    assert.equal(deposits[0].amountNanos,'100000000000');
    assert.equal(deposits[0].status,'pending');
    assert.equal(deposits[0].creditedAt,null);
    assert.equal(deposits[0].avalancheFinalized,false);
    const filtered=await request('GET',`/v1/deposits?txid=${ownTx.toUpperCase()}&limit=1`,undefined,first.apiKey);
    assert.deepEqual(filtered.json().deposits,deposits);
    const foreign=await request('GET',`/v1/deposits?txid=${otherTx}`,undefined,first.apiKey);
    assert.deepEqual(foreign.json().deposits,[]);
    for(const query of ['limit=101','limit=1.5','txid=not-a-transaction','accountId='+second.id]) {
      assert.equal((await request('GET','/v1/deposits?'+query,undefined,first.apiKey)).statusCode,400);
    }
    const me=await request('GET','/v1/me',undefined,first.apiKey);
    assert.equal(me.json().balanceNanos,'0');
  });

  test('pending HTTP purchases expose 202 and Retry-After, then replay the same committed receipt', async () => {
    const context = await fixture();
    const offer = await quote(context.buyer.apiKey);
    let entered!: () => void, release!: (result: ProviderResult) => void;
    const started = new Promise<void>(resolve => { entered = resolve; });
    const response = new Promise<ProviderResult>(resolve => { release = resolve; });
    providerOverride = async () => { entered(); return response; };
    const key = randomUUID(), body = { quoteId: offer.id, ...input };
    const original = request('POST', '/v1/decisions', body, context.buyer.apiKey, key).then(value => value);
    try {
      await started;
      const pending = await request('POST', '/v1/decisions', body, context.buyer.apiKey, key);
      assert.equal(pending.statusCode, 202, pending.body);
      assert.equal(pending.headers['retry-after'], '1');
      assert.equal(pending.json().status, 'running');
      const polled = await request('GET', `/v1/decisions/${pending.json().id}`, undefined, context.buyer.apiKey);
      assert.equal(polled.statusCode, 202, polled.body);
      assert.equal(polled.headers['retry-after'], '1');
    } finally {
      release(structuredClone(providerResult));
    }
    const completed = await original;
    assert.equal(completed.statusCode, 200, completed.body);
    const replayed = await request('POST', '/v1/decisions', body, context.buyer.apiKey, key);
    assert.equal(replayed.statusCode, 200, replayed.body);
    assert.deepEqual(replayed.json(), completed.json());
  });

  test('invalid and excessive input is rejected before provider execution', async () => {
    const context = await fixture();
    const priorCalls = calls;
    const extraField = await request('POST', '/v1/quotes', { ...input, endpoint: 'http://127.0.0.1' }, context.buyer.apiKey);
    assert.equal(extraField.statusCode, 400, extraField.body);
    const overProtocolLimit = await request('POST', '/v1/quotes', { ...input, state: 'x'.repeat(40_000) }, context.buyer.apiKey);
    assert.equal(overProtocolLimit.statusCode, 400, overProtocolLimit.body);
    const overTransportLimit = await request('POST', '/v1/quotes', { ...input, state: 'x'.repeat(70_000) }, context.buyer.apiKey);
    assert.equal(overTransportLimit.statusCode, 413, overTransportLimit.body);
    const malformed = await app.inject({
      method: 'POST', url: '/v1/quotes', headers: { authorization: `Bearer ${context.buyer.apiKey}`, 'content-type': 'application/json' }, payload: '{',
    });
    assert.equal(malformed.statusCode, 400, malformed.body);
    const offer = await quote(context.buyer.apiKey);
    const missingKey = await request('POST', '/v1/decisions', { quoteId: offer.id, ...input }, context.buyer.apiKey);
    assert.equal(missingKey.statusCode, 400, missingKey.body);
    assert.equal(calls, priorCalls);
  });

  test('provider registration rejects unapproved hosts, embedded credentials, redirects-by-URL, and cleartext transport', async () => {
    for (const endpoint of [
      'http://api.typesafe.ai/v1/systemone',
      'https://127.0.0.1/v1/systemone',
      'https://api.typesafe.ai.attacker.invalid/v1/systemone',
      'https://secret@api.typesafe.ai/v1/systemone',
      'https://api.typesafe.ai/v1/systemone?target=http://127.0.0.1',
    ]) {
      const id = `reject-${randomUUID()}`;
      const rejected = await request('POST', '/v1/admin/sellers', {
        id, name: 'Forbidden endpoint', endpoint, apiKey: 'integration-only-secret', model: providerResult.model, priceNanos: '250',
      }, config.adminToken);
      assert.equal(rejected.statusCode, 400, rejected.body);
      const rows = await db.query('SELECT id FROM sellers WHERE id=$1', [id]);
      assert.equal(rows.rowCount, 0);
    }
  });

  test('static serving cannot expose configuration or source files', async () => {
    for (const url of ['/.env', '/package.json', '/src/config.ts', '/%2e%2e/%2e%2e/.env']) {
      const response = await request('GET', url);
      assert.ok([400, 403, 404].includes(response.statusCode), `${url} returned ${response.statusCode}`);
      assert.equal(response.body.includes(config.adminToken), false);
      assert.equal(response.body.includes(config.encryptionKey), false);
      assert.doesNotMatch(response.body, /DATABASE_URL=|ZOKO_ADMIN_TOKEN=/);
    }
  });
});
