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
  const providerRequests: { endpoint: string; apiKey: string; model: string }[] = [];
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
      ZOKO_PAYMENTS_ENABLED: 'false', ZOKO_PLATFORM_FEE_BPS: '1000',
    });
    await migrate(db);
    const payments = new Payments(db, config.payments);
    await payments.preflight();
    app = await buildServer(config, db, payments, async provider => {
      calls++;
      providerRequests.push({ ...provider });
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

  test('public enrollment is opt-in, replayable without policy escalation and bounded under concurrency',async()=>{
    const input={name:'Independent agent',dailyLimitNanos:'0',maxPriceNanos:'0'};
    const key=`zoko_${randomBytes(32).toString('base64url')}`;
    assert.equal((await request('POST','/v1/enroll',input,key)).statusCode,403);
    config.publicEnrollment=true;
    const count=(await db.query('SELECT count(*)::integer AS n FROM accounts')).rows[0].n;
    config.enrollmentAccountCap=count+1;
    try{
      const result=await Promise.all([1,2,3].map(()=>request('POST','/v1/enroll',input,key)));
      assert.ok(result.every(r=>r.statusCode===200));
      const ids=result.map(r=>r.json().account.id);assert.equal(new Set(ids).size,1);
      assert.ok(result.every(r=>!r.body.includes(key)&&r.json().sellerApprovalRequired));
      assert.equal((await request('POST','/v1/enroll',{...input,maxPriceNanos:'1'},key)).statusCode,409);
      const me=await request('GET','/v1/me',undefined,key);
      assert.equal(me.json().balanceNanos,'0');assert.equal(me.json().account.maxPriceNanos,'0');
      assert.equal((await request('POST','/v1/enroll',input,`zoko_${randomBytes(32).toString('base64url')}`)).statusCode,503);
      assert.equal((await request('POST','/v1/enroll',input,'weak')).statusCode,400);
      await db.query('UPDATE accounts SET disabled=true WHERE id=$1',[ids[0]]);
      assert.equal((await request('POST','/v1/enroll',input,key)).statusCode,403);
    }finally{config.publicEnrollment=false;config.enrollmentAccountCap=1000;}
  });

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

  async function registerOffer(owner?: Awaited<ReturnType<typeof account>>, priceNanos = '250') {
    const publisher = owner ?? await account('Seller agent', []);
    const id = `agent-${randomUUID()}`, apiKey = randomBytes(24).toString('hex');
    const payload = { id, name: 'Agent-owned decision service', endpoint: 'https://api.typesafe.ai/v1/systemone',
      apiKey, model: providerResult.model, priceNanos };
    const response = await request('POST', '/v1/seller/offers', payload, publisher.apiKey);
    assert.equal(response.statusCode, 201, response.body);
    assert.equal(response.json().id, id);
    return { publisher, id, apiKey, payload, response };
  }

  async function approveOffer(id: string) {
    const response = await request('PATCH', `/v1/admin/sellers/${id}`, { enabled: true }, config.adminToken);
    assert.equal(response.statusCode, 200, response.body);
  }

  async function walletBalance(id: string): Promise<bigint> {
    const response = await db.query('SELECT balance::text FROM wallets WHERE id=$1', [id]);
    assert.equal(response.rowCount, 1);
    return BigInt(response.rows[0].balance);
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
    assert.equal(live.json().version, '1.4.2');
    const metadata = await request('GET', '/.well-known/zoko.json');
    assert.equal(metadata.statusCode, 200);
    assert.equal(metadata.json().version, '1.4.2');
    const empty = await request('GET', '/health/ready');
    assert.equal(empty.statusCode, 200, empty.body);
    assert.equal(empty.json().ok, true);
    assert.equal(empty.json().tradingReady, false);
    assert.equal(empty.json().enabledSellers, 0);
    const eligible = await fixture(0n);
    const ready = await request('GET', '/health/ready');
    assert.equal(ready.statusCode, 200, ready.body);
    assert.equal(ready.json().payments.enabled, false);
    assert.equal(ready.json().tradingReady, true);
    assert.equal(ready.headers['x-content-type-options'], 'nosniff');
    assert.equal(ready.headers['cache-control'], 'no-store');
    assert.equal(ready.headers['x-frame-options'], 'DENY');
    assert.match(String(ready.headers['content-security-policy']), /frame-ancestors 'none'/);
    assert.equal(ready.headers['access-control-allow-origin'], undefined);
    await db.query("UPDATE sellers SET circuit_until=now()+interval '1 minute' WHERE id=$1", [eligible.sellerId]);
    const unavailable = await request('GET', '/health/ready');
    assert.equal(unavailable.statusCode, 200, 'A provider circuit must not make the control plane unhealthy');
    assert.equal(unavailable.json().tradingReady, false);
    assert.equal(unavailable.json().enabledSellers, 0);
    await db.query('UPDATE sellers SET circuit_until=NULL WHERE id=$1', [eligible.sellerId]);
  });

  test('enabled but unverified payments keep deployment readiness unavailable', async () => {
    const paymentConfig = { ...config.payments, enabled: true };
    const guarded = await buildServer({ ...config, payments: paymentConfig }, db, new Payments(db, paymentConfig));
    try {
      await guarded.ready();
      const response = await guarded.inject({ method: 'GET', url: '/health/ready' });
      assert.equal(response.statusCode, 503, response.body);
      assert.equal(response.json().ok, false);
      assert.equal(response.json().tradingReady, false);
      assert.equal(response.json().payments.ready, false);
    } finally { await guarded.close(); }
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
    const publisher = await account('Endpoint validation owner', []);
    for (const endpoint of [
      'http://api.typesafe.ai/v1/systemone',
      'https://127.0.0.1/v1/systemone',
      'https://api.typesafe.ai.attacker.invalid/v1/systemone',
      'https://secret@api.typesafe.ai/v1/systemone',
      'https://api.typesafe.ai/v1/systemone?target=http://127.0.0.1',
    ]) {
      const id = `reject-${randomUUID()}`;
      const rejected = await request('POST', '/v1/admin/sellers', {
        id, name: 'Forbidden endpoint', endpoint, apiKey: 'integration-only-secret', model: providerResult.model, priceNanos: '250', payoutAccountId: publisher.id,
      }, config.adminToken);
      assert.equal(rejected.statusCode, 400, rejected.body);
      assert.equal(rejected.json().error.code, 'endpoint_not_allowed');
      const rows = await db.query('SELECT id FROM sellers WHERE id=$1', [id]);
      assert.equal(rows.rowCount, 0);
    }
  });

  test('agent registrations derive ownership from authentication and stay private and pending until approved', async () => {
    const first = await registerOffer(), second = await registerOffer();
    for (const offer of [first, second]) {
      const created = offer.response.json();
      assert.equal(created.payoutAccountId, offer.publisher.id);
      assert.equal(created.enabled, false);
      assert.equal(created.paused, false);
      assert.equal(created.commissionBps, 1000);
      const stored = (await db.query('SELECT payout_account_id,enabled,paused,api_key_encrypted FROM sellers WHERE id=$1', [offer.id])).rows[0];
      assert.equal(stored.payout_account_id, offer.publisher.id);
      assert.equal(stored.enabled, false);
      assert.match(stored.api_key_encrypted, /^v1:/);
      assert.equal(stored.api_key_encrypted.includes(offer.apiKey), false);
      const owned = await request('GET', '/v1/seller/offers', undefined, offer.publisher.apiKey);
      assert.equal(owned.statusCode, 200, owned.body);
      assert.deepEqual(owned.json().offers.map((row: { id: string }) => row.id), [offer.id]);
      for (const response of [offer.response, owned, await request('GET', '/v1/catalog'), await request('GET', '/v1/admin/overview', undefined, config.adminToken)]) {
        assert.equal(response.statusCode < 300, true, response.body);
        assert.equal(response.body.includes(offer.apiKey), false);
        assert.equal(response.body.includes(offer.publisher.apiKey), false);
        assert.equal(response.body.includes(stored.api_key_encrypted), false);
        assert.doesNotMatch(response.body, /"apiKey"|api_key_encrypted|api_key_hash/);
      }
    }
    const catalog = (await request('GET', '/v1/catalog')).json().sellers as { id: string }[];
    assert.equal(catalog.some(offer => [first.id, second.id].includes(offer.id)), false);
    const overview = (await request('GET', '/v1/admin/overview', undefined, config.adminToken)).json();
    assert.ok(overview.sellers.some((offer: { id: string; enabled: boolean }) => offer.id === first.id && offer.enabled === false));
    assert.equal((await request('GET', '/v1/seller/offers')).statusCode, 401);
    assert.equal((await request('GET', '/v1/seller/offers', undefined, config.adminToken)).statusCode, 401);
    const foreign = await request('PATCH', `/v1/seller/offers/${first.id}`, { priceNanos: '1' }, second.publisher.apiKey);
    assert.equal(foreign.statusCode, 404, foreign.body);
    const duplicate = await request('POST', '/v1/seller/offers', { ...second.payload, id: first.id }, second.publisher.apiKey);
    assert.equal(duplicate.statusCode, 409, duplicate.body);
    const original = (await db.query('SELECT price_nanos,payout_account_id FROM sellers WHERE id=$1', [first.id])).rows[0];
    assert.deepEqual(original, { price_nanos: '250', payout_account_id: first.publisher.id });
  });

  test('seller offer pagination stays bounded and returns only the authenticated owner across pages', async () => {
    const owner = await account('Paginated publisher', []), unrelated = await registerOffer();
    const offers = [await registerOffer(owner), await registerOffer(owner), await registerOffer(owner)];
    const expected = offers.map(offer => offer.id).sort();
    const first = await request('GET', '/v1/seller/offers?limit=2', undefined, owner.apiKey);
    assert.equal(first.statusCode, 200, first.body);
    assert.deepEqual(first.json().offers.map((offer: { id: string }) => offer.id), expected.slice(0, 2));
    assert.equal(first.json().nextCursor, expected[1]);
    const second = await request('GET', `/v1/seller/offers?limit=2&after=${first.json().nextCursor}`, undefined, owner.apiKey);
    assert.equal(second.statusCode, 200, second.body);
    assert.deepEqual(second.json().offers.map((offer: { id: string }) => offer.id), expected.slice(2));
    assert.equal(second.json().nextCursor, null);
    assert.equal(first.body.includes(unrelated.id) || second.body.includes(unrelated.id), false);
    const oversized = await request('GET', '/v1/seller/offers?limit=101', undefined, owner.apiKey);
    assert.equal(oversized.statusCode, 400, oversized.body);
    const forgedOwner = await request('GET', `/v1/seller/offers?accountId=${unrelated.publisher.id}`, undefined, owner.apiKey);
    assert.equal(forgedOwner.statusCode, 400, forgedOwner.body);
  });

  test('seller credentials cannot set approval, payout ownership, or unsupported mutable fields', async () => {
    const offer = await registerOffer(), other = await account('Forbidden payout target', []);
    for (const injection of [
      { payoutAccountId: other.id }, { payoutAccountId: null }, { enabled: true }, { enabled: false }, { paused: true }, { ownerId: other.id },
    ]) {
      const id = `blocked-${randomUUID()}`;
      const created = await request('POST', '/v1/seller/offers', { ...offer.payload, id, ...injection }, offer.publisher.apiKey);
      assert.equal(created.statusCode, 400, created.body);
      assert.equal((await db.query('SELECT id FROM sellers WHERE id=$1', [id])).rowCount, 0);
    }
    for (const patch of [
      { payoutAccountId: other.id }, { enabled: true }, { ownerId: other.id },
      { endpoint: 'https://api.typesafe.ai/v1/another-endpoint' }, { model: 'substituted-model' }, {},
    ]) {
      const updated = await request('PATCH', `/v1/seller/offers/${offer.id}`, patch, offer.publisher.apiKey);
      assert.equal(updated.statusCode, 400, updated.body);
    }
    const stored = (await db.query('SELECT payout_account_id,enabled,paused,price_nanos,model FROM sellers WHERE id=$1', [offer.id])).rows[0];
    assert.deepEqual(stored, { payout_account_id: offer.publisher.id, enabled: false, paused: false, price_nanos: '250', model: providerResult.model });
  });

  test('publisher registration preserves endpoint restrictions and disabled actors cannot manage offers', async () => {
    const offer = await registerOffer();
    for (const endpoint of [
      'http://api.typesafe.ai/v1/systemone', 'https://127.0.0.1/v1/systemone',
      'https://api.typesafe.ai.attacker.invalid/v1/systemone', 'https://secret@api.typesafe.ai/v1/systemone',
      'https://api.typesafe.ai/v1/systemone?target=http://127.0.0.1',
    ]) {
      const id = `blocked-${randomUUID()}`;
      const created = await request('POST', '/v1/seller/offers', { ...offer.payload, id, endpoint }, offer.publisher.apiKey);
      assert.equal(created.statusCode, 400, created.body);
      assert.equal(created.json().error.code, 'endpoint_not_allowed');
      assert.equal((await db.query('SELECT id FROM sellers WHERE id=$1', [id])).rowCount, 0);
    }
    assert.equal((await request('PATCH', `/v1/admin/accounts/${offer.publisher.id}`, { disabled: true }, config.adminToken)).statusCode, 200);
    const id = `disabled-${randomUUID()}`;
    assert.equal((await request('GET', '/v1/seller/offers', undefined, offer.publisher.apiKey)).statusCode, 401);
    assert.equal((await request('POST', '/v1/seller/offers', { ...offer.payload, id }, offer.publisher.apiKey)).statusCode, 401);
    assert.equal((await request('PATCH', `/v1/seller/offers/${offer.id}`, { priceNanos: '1', paused: true }, offer.publisher.apiKey)).statusCode, 401);
    assert.equal((await db.query('SELECT id FROM sellers WHERE id=$1', [id])).rowCount, 0);
    assert.equal((await db.query('SELECT price_nanos FROM sellers WHERE id=$1', [offer.id])).rows[0].price_nanos, '250');
  });

  test('approval, publisher pause, and owner suspension gate both quoting and execution of earlier quotes', async () => {
    const offer = await registerOffer(), buyer = await account('Approval gate buyer', [offer.id]);
    await transaction(db, tx => transfer(tx, `http-funding:${buyer.id}`, 'external', `available:${buyer.id}`, 1000n));
    const priorCalls = calls;
    const unavailableQuote = async () => {
      const response = await request('POST', '/v1/quotes', { ...input, policy: { allowedSellers: [offer.id], maxPriceNanos: '250' } }, buyer.apiKey);
      assert.equal(response.statusCode, 503, response.body);
      assert.equal(response.json().error.code, 'no_seller');
      const catalog = (await request('GET', '/v1/catalog')).json().sellers as { id: string }[];
      assert.equal(catalog.some(row => row.id === offer.id), false);
    };
    const unavailablePurchase = async (quoteId: string) => {
      const response = await request('POST', '/v1/decisions', { quoteId, ...input }, buyer.apiKey, randomUUID());
      assert.equal(response.statusCode, 503, response.body);
      assert.equal(response.json().error.code, 'seller_unavailable');
    };
    await unavailableQuote();
    await approveOffer(offer.id);
    const beforePause = await quote(buyer.apiKey);
    const paused = await request('PATCH', `/v1/seller/offers/${offer.id}`, { paused: true }, offer.publisher.apiKey);
    assert.equal(paused.statusCode, 200, paused.body); assert.equal(paused.json().enabled, true);
    await unavailableQuote(); await unavailablePurchase(beforePause.id);
    assert.equal((await request('PATCH', `/v1/seller/offers/${offer.id}`, { paused: false }, offer.publisher.apiKey)).statusCode, 200);
    const beforeSuspension = await quote(buyer.apiKey);
    assert.equal((await request('PATCH', `/v1/admin/accounts/${offer.publisher.id}`, { disabled: true }, config.adminToken)).statusCode, 200);
    await unavailableQuote(); await unavailablePurchase(beforeSuspension.id);
    assert.equal((await request('PATCH', `/v1/admin/accounts/${offer.publisher.id}`, { disabled: false }, config.adminToken)).statusCode, 200);
    assert.equal((await request('PATCH', `/v1/admin/sellers/${offer.id}`, { enabled: false }, config.adminToken)).statusCode, 200);
    const unpaused = await request('PATCH', `/v1/seller/offers/${offer.id}`, { paused: false }, offer.publisher.apiKey);
    assert.equal(unpaused.statusCode, 200, unpaused.body); assert.equal(unpaused.json().enabled, false);
    await unavailableQuote(); await unavailablePurchase(beforeSuspension.id);
    assert.equal(calls, priorCalls);
    assert.equal(await walletBalance(`available:${buyer.id}`), 1000n);
    assert.equal(await walletBalance(`reserved:${buyer.id}`), 0n);
    assert.equal((await db.query('SELECT id FROM decisions WHERE account_id=$1', [buyer.id])).rowCount, 0);
  });

  test('seller price and credential rotation update new offers while issued quotes preserve their agreed terms', async () => {
    const offer = await registerOffer(), buyer = await account('Credential rotation buyer', [offer.id]);
    await approveOffer(offer.id);
    await transaction(db, tx => transfer(tx, `http-funding:${buyer.id}`, 'external', `available:${buyer.id}`, 1000n));
    const original = await quote(buyer.apiKey), rotatedKey = randomBytes(24).toString('hex');
    const originalCiphertext = (await db.query('SELECT api_key_encrypted FROM sellers WHERE id=$1', [offer.id])).rows[0].api_key_encrypted;
    const updated = await request('PATCH', `/v1/seller/offers/${offer.id}`, { priceNanos: '400', apiKey: rotatedKey }, offer.publisher.apiKey);
    assert.equal(updated.statusCode, 200, updated.body);
    assert.equal(updated.json().priceNanos, '400'); assert.equal(updated.json().enabled, true);
    const newQuote = await request('POST', '/v1/quotes', { ...input, policy: { maxPriceNanos: '400', allowedSellers: [offer.id] } }, buyer.apiKey);
    assert.equal(newQuote.statusCode, 200, newQuote.body); assert.equal(newQuote.json().priceNanos, '400');
    const position = providerRequests.length;
    const boughtOriginal = await request('POST', '/v1/decisions', { quoteId: original.id, ...input }, buyer.apiKey, randomUUID());
    const boughtUpdated = await request('POST', '/v1/decisions', { quoteId: newQuote.json().id, ...input }, buyer.apiKey, randomUUID());
    assert.equal(boughtOriginal.statusCode, 200, boughtOriginal.body); assert.equal(boughtOriginal.json().priceNanos, '250');
    assert.equal(boughtUpdated.statusCode, 200, boughtUpdated.body); assert.equal(boughtUpdated.json().priceNanos, '400');
    assert.deepEqual(providerRequests.slice(position), [
      { endpoint: offer.payload.endpoint, model: offer.payload.model, apiKey: offer.apiKey },
      { endpoint: offer.payload.endpoint, model: offer.payload.model, apiKey: rotatedKey },
    ]);
    const ciphertext = (await db.query('SELECT api_key_encrypted FROM sellers WHERE id=$1', [offer.id])).rows[0].api_key_encrypted;
    assert.notEqual(ciphertext, originalCiphertext); assert.match(ciphertext, /^v1:/);
    for (const response of [updated, await request('GET', '/v1/seller/offers', undefined, offer.publisher.apiKey), await request('GET', '/v1/catalog'), await request('GET', '/v1/admin/overview', undefined, config.adminToken)]) {
      assert.equal(response.body.includes(offer.apiKey), false); assert.equal(response.body.includes(rotatedKey), false);
      assert.equal(response.body.includes(ciphertext), false); assert.doesNotMatch(response.body, /"apiKey"|api_key_encrypted/);
    }
    const audit = await db.query('SELECT metadata::text FROM audit_events WHERE subject=$1', [offer.id]);
    for (const row of audit.rows) {
      assert.equal(row.metadata.includes(offer.apiKey), false); assert.equal(row.metadata.includes(rotatedKey), false);
    }
  });

  test('an agent-owned offer executes once and distributes 90 percent to its seller and 10 percent to Zoko', async () => {
    const offer = await registerOffer(), buyer = await account('Marketplace purchase buyer', [offer.id]);
    await approveOffer(offer.id);
    await transaction(db, tx => transfer(tx, `http-funding:${buyer.id}`, 'external', `available:${buyer.id}`, 1000n));
    const platformBefore = await walletBalance('platform'), callsBefore = calls;
    const agreed = await quote(buyer.apiKey), key = randomUUID(), body = { quoteId: agreed.id, ...input };
    const purchased = await request('POST', '/v1/decisions', body, buyer.apiKey, key);
    assert.equal(purchased.statusCode, 200, purchased.body);
    const receipt = purchased.json();
    assert.equal(receipt.status, 'succeeded'); assert.equal(receipt.sellerId, offer.id); assert.equal(receipt.priceNanos, '250');
    const replayed = await request('POST', '/v1/decisions', body, buyer.apiKey, key);
    assert.equal(replayed.statusCode, 200, replayed.body); assert.deepEqual(replayed.json(), receipt);
    assert.equal(calls, callsBefore + 1);
    assert.equal(await walletBalance(`available:${buyer.id}`), 750n);
    assert.equal(await walletBalance(`reserved:${buyer.id}`), 0n);
    assert.equal(await walletBalance(`available:${offer.publisher.id}`), 225n);
    assert.equal(await walletBalance('platform') - platformBefore, 25n);
    const journal = await db.query('SELECT reference,from_wallet,to_wallet,amount::text FROM transfers WHERE reference=ANY($1::text[]) ORDER BY reference', [[
      `decision:${receipt.id}:reserve`, `decision:${receipt.id}:fee`, `decision:${receipt.id}:seller`,
    ]]);
    assert.deepEqual(journal.rows, [
      { reference: `decision:${receipt.id}:fee`, from_wallet: `reserved:${buyer.id}`, to_wallet: 'platform', amount: '25' },
      { reference: `decision:${receipt.id}:reserve`, from_wallet: `available:${buyer.id}`, to_wallet: `reserved:${buyer.id}`, amount: '250' },
      { reference: `decision:${receipt.id}:seller`, from_wallet: `reserved:${buyer.id}`, to_wallet: `available:${offer.publisher.id}`, amount: '225' },
    ]);
  });

  test('admin registration requires an owner and neither admin nor seller patches can redirect payout identity', async () => {
    const owner = await account('Admin offer owner', []), other = await account('Other payout owner', []);
    const payload = { id: `admin-${randomUUID()}`, name: 'Explicit owner offer', endpoint: 'https://api.typesafe.ai/v1/systemone',
      apiKey: randomBytes(24).toString('hex'), model: providerResult.model, priceNanos: '250' };
    for (const ownership of [{}, { payoutAccountId: null }, { payoutAccountId: randomUUID() }]) {
      const id = `invalid-${randomUUID()}`;
      const response = await request('POST', '/v1/admin/sellers', { ...payload, id, ...ownership }, config.adminToken);
      assert.equal(response.statusCode, 400, response.body);
      assert.equal((await db.query('SELECT id FROM sellers WHERE id=$1', [id])).rowCount, 0);
    }
    const created = await request('POST', '/v1/admin/sellers', { ...payload, payoutAccountId: owner.id }, config.adminToken);
    assert.equal(created.statusCode, 201, created.body);
    for (const payoutAccountId of [other.id, owner.id, null]) {
      const response = await request('PATCH', `/v1/admin/sellers/${payload.id}`, { payoutAccountId }, config.adminToken);
      assert.equal(response.statusCode, 400, response.body);
    }
    const compatibility = await request('PATCH', `/v1/admin/sellers/${payload.id}`, { priceNanos: '300', apiKey: randomBytes(24).toString('hex') }, config.adminToken);
    assert.equal(compatibility.statusCode, 200, compatibility.body);
    const row = (await db.query('SELECT payout_account_id,price_nanos FROM sellers WHERE id=$1', [payload.id])).rows[0];
    assert.deepEqual(row, { payout_account_id: owner.id, price_nanos: '300' });
    const legacyId = `legacy-${randomUUID()}`;
    await db.query(`INSERT INTO sellers(id,name,endpoint,api_key_encrypted,model,price_nanos,payout_account_id,enabled)
      SELECT $1,name,endpoint,api_key_encrypted,model,price_nanos,NULL,false FROM sellers WHERE id=$2`, [legacyId, payload.id]);
    const attach = await request('PATCH', `/v1/admin/sellers/${legacyId}`, { payoutAccountId: owner.id }, config.adminToken);
    assert.equal(attach.statusCode, 400, attach.body);
    const approve = await request('PATCH', `/v1/admin/sellers/${legacyId}`, { enabled: true }, config.adminToken);
    assert.equal(approve.statusCode, 400, approve.body);
    assert.deepEqual((await db.query('SELECT payout_account_id,enabled FROM sellers WHERE id=$1', [legacyId])).rows[0], { payout_account_id: null, enabled: false });
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
