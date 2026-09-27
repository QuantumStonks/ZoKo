import assert from 'node:assert/strict';
import { randomBytes, randomUUID } from 'node:crypto';
import { after, afterEach, before, describe, test } from 'node:test';
import pg from 'pg';
import { readConfig, type Config } from '../src/config.js';
import { auditLedger, createAccount, transaction, transfer, type Db } from '../src/db.js';
import { Market } from '../src/market.js';
import { migrate } from '../src/migration.js';
import type { DecisionInput } from '../src/protocol.js';
import { ProviderError, type Provider, type ProviderResult } from '../src/provider.js';
import { AppError, encrypt } from '../src/security.js';

/**
 * These tests require a real PostgreSQL server: multiple independent connections
 * deliberately contend for the same money and idempotency records. A unique
 * schema isolates each run; no existing application tables are truncated.
 */
const databaseUrl = process.env.TEST_DATABASE_URL;
const price = 250n;
const decisionInput: DecisionInput = {
  state: { message: 'The site is down.', customer: 'integration-test' },
  questions: { urgent: { type: 'noul', instructions: 'Is this an outage?' } },
};
const successfulResult: ProviderResult = {
  model: 'jev-1.13.0',
  answers: { urgent: { type: 'noul', noul: 0.95 } },
  usage: { input_tokens: 100, output_tokens: 10 },
};

type ProviderFunction = (provider: Provider, input: DecisionInput, timeoutMs: number) => Promise<ProviderResult>;

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

function heldProvider() {
  const entered = deferred<void>();
  const response = deferred<ProviderResult>();
  let calls = 0;
  const invoke: ProviderFunction = async () => {
    calls++;
    entered.resolve();
    return response.promise;
  };
  return { invoke, entered: entered.promise, response, get calls() { return calls; } };
}

function statusIs(...allowed: number[]) {
  return (error: unknown): boolean => {
    assert.ok(error instanceof AppError, `Expected an application rejection, received ${String(error)}`);
    assert.ok(allowed.includes(error.statusCode), `Expected HTTP ${allowed.join('/')}, received ${error.statusCode} (${error.code})`);
    return true;
  };
}

describe('Market invariants with real PostgreSQL', {
  skip: databaseUrl ? false : 'Set TEST_DATABASE_URL to run database locking, accounting, and recovery integration tests.',
  concurrency: false,
  timeout: 120_000,
}, () => {
  const schema = `zoko_integration_${randomUUID().replaceAll('-', '')}`;
  let control: pg.Pool;
  let db: Db;
  let config: Config;

  before(async () => {
    assert.ok(databaseUrl);
    control = new pg.Pool({ connectionString: databaseUrl, max: 1, connectionTimeoutMillis: 5000 });
    await control.query(`CREATE SCHEMA ${schema}`);
    db = new pg.Pool({
      connectionString: databaseUrl,
      options: `-c search_path=${schema} -c timezone=UTC`,
      max: 20,
      connectionTimeoutMillis: 5000,
      statement_timeout: 15000,
      application_name: schema,
    });
    config = readConfig({
      NODE_ENV: 'test',
      DATABASE_URL: databaseUrl,
      ZOKO_ADMIN_TOKEN: randomBytes(32).toString('hex'),
      ZOKO_ENCRYPTION_KEY: randomBytes(32).toString('base64'),
      ZOKO_PROVIDER_HOSTS: 'api.typesafe.ai',
      ZOKO_PLATFORM_FEE_BPS: '1000',
      ZOKO_PAYMENTS_ENABLED: 'false',
    });
    await migrate(db);
  });

  after(async () => {
    if (db) await db.end();
    if (control) {
      try { await control.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`); }
      finally { await control.end(); }
    }
  });

  afterEach(async () => {
    if (!db) return;
    const audit = await auditLedger(db) as { ok: boolean; totalNanos: string };
    assert.equal(audit.ok, true, JSON.stringify(audit));
    assert.equal(audit.totalNanos, '0');
    // Reconcile reserved wallets independently of the application's audit query.
    // This suite creates no withdrawals, so every reservation must be a decision.
    const mismatches = await db.query(`
      SELECT a.id, w.balance::text AS actual,
             COALESCE(sum(d.price_nanos) FILTER (WHERE d.status='running'), 0)::text AS expected
      FROM accounts a JOIN wallets w ON w.id='reserved:' || a.id::text
      LEFT JOIN decisions d ON d.account_id=a.id
      GROUP BY a.id,w.balance
      HAVING w.balance <> COALESCE(sum(d.price_nanos) FILTER (WHERE d.status='running'), 0)
    `);
    assert.deepEqual(mismatches.rows, []);
  });

  async function walletBalances(accountId: string) {
    const result = await db.query('SELECT id,balance::text FROM wallets WHERE id=ANY($1::text[])', [
      [`available:${accountId}`, `reserved:${accountId}`],
    ]);
    assert.equal(result.rowCount, 2);
    const balances = new Map<string, bigint>(result.rows.map(row => [row.id, BigInt(row.balance)]));
    return { available: balances.get(`available:${accountId}`)!, reserved: balances.get(`reserved:${accountId}`)! };
  }

  async function fixture(options: {
    balance?: bigint; dailyLimit?: bigint; maxPrice?: bigint; provider?: ProviderFunction;
    feeBps?: number; selfSeller?: boolean;
  } = {}) {
    const sellerId = `seller-${randomUUID()}`;
    const buyer = await createAccount(db, {
      name: 'Integration buyer',
      dailyLimitNanos: (options.dailyLimit ?? 100_000n).toString(),
      maxPriceNanos: (options.maxPrice ?? 10_000n).toString(),
      allowedSellers: [sellerId],
    });
    const seller = options.selfSeller ? buyer : await createAccount(db, { name: 'Integration seller', dailyLimitNanos: '0', maxPriceNanos: '0' });
    const providerApiKey = randomBytes(24).toString('hex');
    await db.query(`
      INSERT INTO sellers(id,name,endpoint,api_key_encrypted,model,price_nanos,payout_account_id)
      VALUES($1,$2,$3,$4,$5,$6,$7)
    `, [sellerId, 'Integration provider', 'https://api.typesafe.ai/v1/systemone',
      encrypt(providerApiKey, config.encryptionKey), successfulResult.model, price.toString(), seller.id]);
    const balance = options.balance ?? 10_000n;
    if (balance > 0n) {
      await transaction(db, tx => transfer(tx, `test-funding:${buyer.id}`, 'external', `available:${buyer.id}`, balance));
    }
    let calls = 0;
    const invoked = options.provider ?? (async () => { calls++; return structuredClone(successfulResult); });
    const market = new Market(db, { ...config, platformFeeBps: options.feeBps ?? config.platformFeeBps }, invoked);
    const quote = await market.quote(buyer.id, decisionInput);
    return { buyer, seller, sellerId, market, quote, balance, providerApiKey, get calls() { return calls; } };
  }

  async function platformBalance():Promise<bigint> {
    return BigInt((await db.query("SELECT balance::text FROM wallets WHERE id='platform'")).rows[0].balance);
  }

  test('migrations are repeatable and journal references cannot duplicate or change a transfer', async () => {
    await Promise.all([migrate(db), migrate(db)]);
    const buyer = await createAccount(db, { name: 'Journal test', dailyLimitNanos: '0', maxPriceNanos: '0' });
    const reference = `journal:${buyer.id}`;
    await Promise.all(Array.from({ length: 20 }, () => transaction(db, tx =>
      transfer(tx, reference, 'external', `available:${buyer.id}`, 101n))));
    assert.deepEqual(await walletBalances(buyer.id), { available: 101n, reserved: 0n });
    await assert.rejects(transaction(db, tx => transfer(tx, reference, 'external', `available:${buyer.id}`, 102n)), /Conflicting transfer reference/);
    await assert.rejects(db.query('UPDATE transfers SET amount=102 WHERE reference=$1', [reference]), /append-only/);
    await assert.rejects(db.query('DELETE FROM transfers WHERE reference=$1', [reference]), /append-only/);
    assert.deepEqual(await walletBalances(buyer.id), { available: 101n, reserved: 0n });
  });

  test('concurrent purchases cannot spend more than the available balance', async () => {
    const context = await fixture({ balance: price * 3n });
    const quotes = await Promise.all(Array.from({ length: 32 }, () => context.market.quote(context.buyer.id, decisionInput)));
    const outcomes = await Promise.allSettled(quotes.map(quote => context.market.decide(context.buyer.id, randomUUID(), { quoteId: quote.id, ...decisionInput })));
    const successful = outcomes.filter(outcome => outcome.status === 'fulfilled');
    assert.equal(successful.length, 3);
    for (const outcome of outcomes) if (outcome.status === 'rejected') statusIs(402)(outcome.reason);
    assert.equal(context.calls, 3);
    assert.deepEqual(await walletBalances(context.buyer.id), { available: 0n, reserved: 0n });
    assert.deepEqual(await walletBalances(context.seller.id), { available: 675n, reserved: 0n });
  });

  test('concurrent purchases cannot exceed a daily budget even when the buyer has more funds', async () => {
    const context = await fixture({ balance: 100_000n, dailyLimit: price * 5n });
    const quotes = await Promise.all(Array.from({ length: 24 }, () => context.market.quote(context.buyer.id, decisionInput)));
    const outcomes = await Promise.allSettled(quotes.map(quote => context.market.decide(context.buyer.id, randomUUID(), { quoteId: quote.id, ...decisionInput })));
    assert.equal(outcomes.filter(outcome => outcome.status === 'fulfilled').length, 5);
    for (const outcome of outcomes) if (outcome.status === 'rejected') statusIs(402, 403)(outcome.reason);
    assert.equal(context.calls, 5);
    assert.deepEqual(await walletBalances(context.buyer.id), { available: 98_750n, reserved: 0n });
    const budget = await db.query('SELECT spent::text,reserved::text FROM budgets WHERE account_id=$1', [context.buyer.id]);
    assert.deepEqual(budget.rows, [{ spent: '1250', reserved: '0' }]);
  });

  test('pending reservations count against the daily budget before provider completion', async () => {
    const provider = heldProvider();
    const context = await fixture({ dailyLimit: price, provider: provider.invoke });
    const secondQuote = await context.market.quote(context.buyer.id, decisionInput);
    const first = context.market.decide(context.buyer.id, randomUUID(), { quoteId: context.quote.id, ...decisionInput });
    try {
      await provider.entered;
      assert.deepEqual(await walletBalances(context.buyer.id), { available: context.balance - price, reserved: price });
      await assert.rejects(context.market.decide(context.buyer.id, randomUUID(), { quoteId: secondQuote.id, ...decisionInput }), statusIs(402, 403));
      assert.equal(provider.calls, 1);
    } finally {
      provider.response.resolve(structuredClone(successfulResult));
      await first;
    }
  });

  test('concurrent identical keys invoke the provider once and replay the durable receipt after quote expiry', async () => {
    const provider = heldProvider();
    const context = await fixture({ provider: provider.invoke });
    const key = randomUUID();
    const body = { quoteId: context.quote.id, ...decisionInput };
    const first = context.market.decide(context.buyer.id, key, body);
    let firstId: string | undefined;
    try {
      await provider.entered;
      const replays = await Promise.all(Array.from({ length: 24 }, () => context.market.decide(context.buyer.id, key, body)));
      assert.equal(provider.calls, 1);
      firstId = replays[0].id;
      assert.ok(firstId);
      for (const replay of replays) {
        assert.equal(replay.id, firstId);
        assert.equal(replay.status, 'running');
      }
      assert.deepEqual(await walletBalances(context.buyer.id), { available: context.balance - price, reserved: price });
    } finally {
      provider.response.resolve(structuredClone(successfulResult));
    }
    const receipt = await first;
    assert.equal(receipt.id, firstId);
    assert.equal(receipt.status, 'succeeded');
    await db.query("UPDATE quotes SET expires_at=now()-interval '1 second' WHERE id=$1", [context.quote.id]);
    await db.query('UPDATE sellers SET enabled=false WHERE id=$1', [context.sellerId]);
    const replay = await context.market.decide(context.buyer.id, key, body);
    assert.deepEqual(replay, receipt);
    assert.equal(provider.calls, 1);
    const count = await db.query('SELECT count(*)::integer AS count FROM decisions WHERE account_id=$1', [context.buyer.id]);
    assert.equal(count.rows[0].count, 1);
    assert.deepEqual(await walletBalances(context.buyer.id), { available: context.balance - price, reserved: 0n });
  });

  test('idempotency keys bind both the input and original quote', async () => {
    const context = await fixture();
    const key = randomUUID();
    await context.market.decide(context.buyer.id, key, { quoteId: context.quote.id, ...decisionInput });
    await assert.rejects(context.market.decide(context.buyer.id, key, {
      quoteId: context.quote.id, ...decisionInput, state: 'A different input',
    }), statusIs(409));
    const otherQuote = await context.market.quote(context.buyer.id, decisionInput);
    await assert.rejects(context.market.decide(context.buyer.id, key, { quoteId: otherQuote.id, ...decisionInput }), statusIs(409));
    assert.equal(context.calls, 1);
  });

  test('a purchased quote cannot be executed again using a fresh idempotency key', async () => {
    const context = await fixture();
    await context.market.decide(context.buyer.id, randomUUID(), { quoteId: context.quote.id, ...decisionInput });
    await assert.rejects(context.market.decide(context.buyer.id, randomUUID(), { quoteId: context.quote.id, ...decisionInput }), statusIs(409));
    assert.equal(context.calls, 1);
  });

  test('quote payload and schema mutations are rejected before reserving funds', async () => {
    const context = await fixture();
    await assert.rejects(context.market.decide(context.buyer.id, randomUUID(), {
      quoteId: context.quote.id, ...decisionInput, state: { message: 'Changed after quoting' },
    }), statusIs(409));
    await assert.rejects(context.market.decide(context.buyer.id, randomUUID(), {
      quoteId: context.quote.id, ...decisionInput,
      questions: { urgent: { type: 'choice', instructions: 'Changed schema', criteria: { outage: null, other: null } } },
    }), statusIs(409));
    assert.equal(context.calls, 0);
    assert.deepEqual(await walletBalances(context.buyer.id), { available: context.balance, reserved: 0n });
  });

  test('expired quotes cannot reserve money or invoke the provider', async () => {
    const context = await fixture();
    await db.query("UPDATE quotes SET expires_at=now()-interval '1 second' WHERE id=$1", [context.quote.id]);
    await assert.rejects(context.market.decide(context.buyer.id, randomUUID(), { quoteId: context.quote.id, ...decisionInput }), statusIs(409, 410));
    assert.equal(context.calls, 0);
    assert.deepEqual(await walletBalances(context.buyer.id), { available: context.balance, reserved: 0n });
  });

  test('quote expiry is checked after waiting for an account lock, using current time', async () => {
    const context = await fixture();
    const blocker = await db.connect();
    await blocker.query('BEGIN');
    await blocker.query('SELECT id FROM accounts WHERE id=$1 FOR UPDATE', [context.buyer.id]);
    const purchase = context.market.decide(context.buyer.id, randomUUID(), { quoteId: context.quote.id, ...decisionInput })
      .then(value => ({ ok: true as const, value }), error => ({ ok: false as const, error }));
    try {
      const deadline = Date.now() + 3000;
      let waiting = false;
      do {
        const active = await db.query(`SELECT EXISTS(
          SELECT 1 FROM pg_stat_activity WHERE application_name=$1 AND wait_event_type='Lock'
          AND query LIKE 'SELECT * FROM accounts WHERE id=ANY%'
        ) AS waiting`, [schema]);
        waiting = active.rows[0].waiting;
        if (!waiting) await new Promise(resolve => setTimeout(resolve, 10));
      } while (!waiting && Date.now() < deadline);
      assert.equal(waiting, true, 'Purchase must be demonstrably waiting on the account row before expiry');
      // Expire it strictly after the purchase transaction began. PostgreSQL
      // now() remains frozen at that earlier transaction start and is unsafe here.
      await db.query('UPDATE quotes SET expires_at=clock_timestamp() WHERE id=$1', [context.quote.id]);
    } finally {
      await blocker.query('COMMIT');
      blocker.release();
    }
    const outcome = await purchase;
    assert.equal(outcome.ok, false, 'A quote that expired during a lock wait must not be purchased');
    if (!outcome.ok) statusIs(409)(outcome.error);
    assert.equal(context.calls, 0);
    assert.deepEqual(await walletBalances(context.buyer.id), { available: context.balance, reserved: 0n });
  });

  test('disabled accounts cannot purchase already-issued quotes or obtain new ones', async () => {
    const context = await fixture();
    await db.query('UPDATE accounts SET disabled=true WHERE id=$1', [context.buyer.id]);
    await assert.rejects(context.market.quote(context.buyer.id, decisionInput), statusIs(403));
    await assert.rejects(context.market.decide(context.buyer.id, randomUUID(), { quoteId: context.quote.id, ...decisionInput }), statusIs(403));
    assert.equal(context.calls, 0);
    assert.deepEqual(await walletBalances(context.buyer.id), { available: context.balance, reserved: 0n });
  });

  test('legacy ownerless offers cannot be routed and ownerless quotes cannot reserve or capture funds', async () => {
    const context = await fixture();
    const platformBefore=await platformBalance();
    // A legacy quote can be ownerless even if its current offer has an owner.
    await db.query('UPDATE quotes SET payout_account_id=NULL WHERE id=$1', [context.quote.id]);
    await assert.rejects(context.market.decide(context.buyer.id, randomUUID(), { quoteId: context.quote.id, ...decisionInput }),
      (error:unknown)=>error instanceof AppError&&error.statusCode===503&&error.code==='seller_unavailable');
    await db.query('UPDATE sellers SET enabled=false,payout_account_id=NULL WHERE id=$1', [context.sellerId]);
    await assert.rejects(context.market.quote(context.buyer.id, decisionInput),
      (error:unknown)=>error instanceof AppError&&error.statusCode===503&&error.code==='no_seller');
    assert.equal((await context.market.catalog() as {id:string}[]).some(offer=>offer.id===context.sellerId),false);
    assert.equal(context.calls, 0);
    assert.deepEqual(await walletBalances(context.buyer.id), { available: context.balance, reserved: 0n });
    assert.equal(await platformBalance(),platformBefore);
    assert.equal((await db.query('SELECT id FROM decisions WHERE account_id=$1',[context.buyer.id])).rowCount,0);
  });

  test('disabled or paused offers and disabled owners stop new quotes and unstarted purchases', async () => {
    for (const unavailable of ['offer_disabled','offer_paused','owner_disabled']) {
      const context = await fixture();
      if (unavailable==='owner_disabled') await db.query('UPDATE accounts SET disabled=true WHERE id=$1',[context.seller.id]);
      else if (unavailable==='offer_paused') await db.query('UPDATE sellers SET paused=true WHERE id=$1',[context.sellerId]);
      else await db.query('UPDATE sellers SET enabled=false WHERE id=$1',[context.sellerId]);
      await assert.rejects(context.market.quote(context.buyer.id, decisionInput),
        (error:unknown)=>error instanceof AppError&&error.statusCode===503&&error.code==='no_seller',unavailable);
      await assert.rejects(context.market.decide(context.buyer.id, randomUUID(), { quoteId: context.quote.id, ...decisionInput }),
        (error:unknown)=>error instanceof AppError&&error.statusCode===503&&error.code==='seller_unavailable',unavailable);
      assert.equal((await context.market.catalog() as {id:string}[]).some(offer=>offer.id===context.sellerId),false,unavailable);
      assert.equal(context.calls,0);
      assert.deepEqual(await walletBalances(context.buyer.id),{available:context.balance,reserved:0n});
    }
  });

  test('a frozen settlement owner must still be active at admission after a direct database reassignment', async () => {
    const context=await fixture();
    const replacement=await createAccount(db,{name:'Active replacement agent',dailyLimitNanos:'0',maxPriceNanos:'0'});
    await db.query('UPDATE sellers SET payout_account_id=$2 WHERE id=$1',[context.sellerId,replacement.id]);
    await db.query('UPDATE accounts SET disabled=true WHERE id=$1',[context.seller.id]);
    assert.ok((await context.market.quote(context.buyer.id,decisionInput)).id);
    await assert.rejects(context.market.decide(context.buyer.id,randomUUID(),{quoteId:context.quote.id,...decisionInput}),
      (error:unknown)=>error instanceof AppError&&error.statusCode===503&&error.code==='seller_unavailable');
    assert.equal(context.calls,0);
    assert.deepEqual(await walletBalances(context.buyer.id),{available:context.balance,reserved:0n});
  });

  test('admitted work pays its original agent after the offer is paused and both agents are disabled', async () => {
    const provider=heldProvider();
    const context=await fixture({provider:provider.invoke});
    const platformBefore=await platformBalance();
    const purchase=context.market.decide(context.buyer.id,randomUUID(),{quoteId:context.quote.id,...decisionInput});
    void purchase.catch(()=>undefined);
    try {
      await provider.entered;
      await db.query('UPDATE sellers SET enabled=false,paused=true WHERE id=$1',[context.sellerId]);
      await db.query('UPDATE accounts SET disabled=true WHERE id=ANY($1::uuid[])',[[context.buyer.id,context.seller.id]]);
    } finally { provider.response.resolve(structuredClone(successfulResult)); }
    assert.equal((await purchase).status,'succeeded');
    assert.deepEqual(await walletBalances(context.buyer.id),{available:context.balance-price,reserved:0n});
    assert.deepEqual(await walletBalances(context.seller.id),{available:225n,reserved:0n});
    assert.equal(await platformBalance()-platformBefore,25n);
  });

  test('current principal seller policy is enforced when an old quote is purchased', async () => {
    const context = await fixture();
    await db.query('UPDATE accounts SET allowed_sellers=ARRAY[]::text[] WHERE id=$1', [context.buyer.id]);
    await assert.rejects(context.market.decide(context.buyer.id, randomUUID(), { quoteId: context.quote.id, ...decisionInput }), statusIs(403));
    assert.equal(context.calls, 0);
    assert.deepEqual(await walletBalances(context.buyer.id), { available: context.balance, reserved: 0n });
  });

  test('current principal maximum price is enforced when an old quote is purchased', async () => {
    const context = await fixture();
    await db.query('UPDATE accounts SET max_price_nanos=$2 WHERE id=$1', [context.buyer.id, (price - 1n).toString()]);
    await assert.rejects(context.market.decide(context.buyer.id, randomUUID(), { quoteId: context.quote.id, ...decisionInput }), statusIs(402, 403));
    assert.equal(context.calls, 0);
    assert.deepEqual(await walletBalances(context.buyer.id), { available: context.balance, reserved: 0n });
  });

  test('quotes freeze price, provider credentials, endpoint, and seller settlement recipient', async () => {
    const received: Provider[] = [];
    const context = await fixture({ provider: async provider => {
      received.push(provider);
      return structuredClone(successfulResult);
    } });
    const replacementSeller = await createAccount(db, { name: 'Replacement seller', dailyLimitNanos: '0', maxPriceNanos: '0' });
    await db.query(`UPDATE sellers SET price_nanos=900,endpoint=$2,api_key_encrypted=$3,model=$4,payout_account_id=$5 WHERE id=$1`, [
      context.sellerId, 'https://api.typesafe.ai/v1/changed', encrypt('changed-provider-secret', config.encryptionKey),
      'jev-99.0.0', replacementSeller.id,
    ]);
    const receipt = await context.market.decide(context.buyer.id, randomUUID(), { quoteId: context.quote.id, ...decisionInput });
    assert.equal(receipt.status, 'succeeded');
    assert.ok('priceNanos' in receipt);
    assert.equal(receipt.priceNanos, price.toString());
    assert.deepEqual(received, [{ endpoint: 'https://api.typesafe.ai/v1/systemone', apiKey: context.providerApiKey, model: successfulResult.model }]);
    assert.deepEqual(await walletBalances(context.buyer.id), { available: context.balance - price, reserved: 0n });
    assert.deepEqual(await walletBalances(context.seller.id), { available: 225n, reserved: 0n });
    assert.deepEqual(await walletBalances(replacementSeller.id), { available: 0n, reserved: 0n });
  });

  test('commission settlement conserves the price with both zero and ordinary marketplace fees', async () => {
    for (const feeBps of [0,1000]) {
      const context=await fixture({feeBps});
      const platformBefore=await platformBalance();
      const receipt=await context.market.decide(context.buyer.id,randomUUID(),{quoteId:context.quote.id,...decisionInput});
      const fee=price*BigInt(feeBps)/10000n;
      assert.equal(receipt.status,'succeeded');
      assert.deepEqual(await walletBalances(context.buyer.id),{available:context.balance-price,reserved:0n});
      assert.deepEqual(await walletBalances(context.seller.id),{available:price-fee,reserved:0n});
      assert.equal(await platformBalance()-platformBefore,fee);
      const captures=await db.query('SELECT to_wallet,amount::text FROM transfers WHERE reference=ANY($1::text[]) ORDER BY to_wallet',
        [[`decision:${receipt.id}:fee`,`decision:${receipt.id}:seller`]]);
      assert.equal(captures.rows.reduce((sum,row)=>sum+BigInt(row.amount),0n),price);
      assert.equal(captures.rows.filter(row=>row.to_wallet==='platform').length,fee>0n?1:0);
    }
  });

  test('agents can buy from themselves and each other concurrently using the same settlement accounts', async () => {
    const agents=await Promise.all([fixture({selfSeller:true}),fixture({selfSeller:true})]);
    const sellerIds=agents.map(agent=>agent.sellerId);
    await db.query('UPDATE accounts SET allowed_sellers=$1 WHERE id=ANY($2::uuid[])',[sellerIds,agents.map(agent=>agent.buyer.id)]);
    const platformBefore=await platformBalance();
    const purchases=await Promise.all(Array.from({length:16},async(_,index)=>{
      const buyer=agents[index%2],seller=agents[Math.floor(index/2)%2];
      const quote=await buyer.market.quote(buyer.buyer.id,decisionInput,{allowedSellers:[seller.sellerId]});
      return {buyer,quote};
    }));
    const receipts=await Promise.all(purchases.map(({buyer,quote})=>buyer.market.decide(buyer.buyer.id,randomUUID(),{quoteId:quote.id,...decisionInput})));
    assert.equal(receipts.filter(receipt=>receipt.status==='succeeded').length,16);
    assert.equal(agents.reduce((sum,agent)=>sum+agent.calls,0),16);
    for (const agent of agents) {
      // Eight gross purchases and eight sales per agent; the daily spending
      // limit still accounts for every purchase even when proceeds return here.
      assert.deepEqual(await walletBalances(agent.buyer.id),{available:agent.balance-200n,reserved:0n});
      assert.deepEqual((await db.query('SELECT spent::text,reserved::text FROM budgets WHERE account_id=$1',[agent.buyer.id])).rows,[{spent:'2000',reserved:'0'}]);
    }
    assert.equal(await platformBalance()-platformBefore,400n);
  });

  test('decision settlement and revenue transfers serialize account and wallet locks without a cycle', async () => {
    const provider=heldProvider();
    const context = await fixture({provider:provider.invoke});
    await transaction(db, tx => transfer(tx, `platform-funding:${randomUUID()}`, 'external', 'platform', 100n));
    const purchase = context.market.decide(context.buyer.id, randomUUID(), { quoteId: context.quote.id, ...decisionInput })
      .then(value => ({ ok: true as const, value }), error => ({ ok: false as const, error }));
    await provider.entered;
    const revenueTransaction = await db.connect();
    await revenueTransaction.query('BEGIN');
    await revenueTransaction.query('SELECT id FROM accounts WHERE id=$1 FOR UPDATE', [context.seller.id]);
    await revenueTransaction.query('SELECT id FROM wallets WHERE id=$1 FOR UPDATE', [`available:${context.seller.id}`]);
    provider.response.resolve(structuredClone(successfulResult));
    let revenueError: unknown;
    try {
      const deadline = Date.now() + 3000;
      let waiting = false;
      do {
        const active = await db.query(`SELECT EXISTS(
          SELECT 1 FROM pg_stat_activity WHERE application_name=$1 AND wait_event_type='Lock'
          AND query LIKE 'SELECT * FROM accounts WHERE id=ANY%'
        ) AS waiting`, [schema]);
        waiting = active.rows[0].waiting;
        if (!waiting) await new Promise(resolve => setTimeout(resolve, 10));
      } while (!waiting && Date.now() < deadline);
      assert.equal(waiting, true, 'Settlement must wait for the seller account before taking financial locks');
      // Model /v1/admin/revenue-transfer, which locks the recipient account
      // before its wallet. Capture must not already hold the platform wallet.
      await transfer(revenueTransaction, `revenue-concurrency:${randomUUID()}`, 'platform', `available:${context.seller.id}`, 1n);
      await revenueTransaction.query('COMMIT');
    } catch (error) {
      await revenueTransaction.query('ROLLBACK');
      revenueError = error;
    } finally {
      revenueTransaction.release();
    }
    const outcome = await purchase;
    if (revenueError !== undefined) throw revenueError;
    assert.equal(outcome.ok, true, !outcome.ok ? String(outcome.error) : undefined);
    if (outcome.ok) assert.equal(outcome.value.status, 'succeeded');
    assert.deepEqual(await walletBalances(context.seller.id), { available: 226n, reserved: 0n });
    assert.deepEqual(await walletBalances(context.buyer.id), { available: context.balance - price, reserved: 0n });
  });

  test('legacy ownerless in-flight work refunds immediately on completion or recovery without platform capture', async () => {
    for (const mode of ['completion','recovery']) {
      const provider=heldProvider();
      const context=await fixture({provider:provider.invoke});
      const platformBefore=await platformBalance();
      const key=randomUUID(),body={quoteId:context.quote.id,...decisionInput};
      const purchase=context.market.decide(context.buyer.id,key,body);
      void purchase.catch(()=>undefined);
      try {
        await provider.entered;
        // Reconstruct a running quote from before ownership became mandatory.
        // Its deadline is deliberately far ahead: recovery must not wait for it.
        await db.query('UPDATE quotes SET payout_account_id=NULL WHERE id=$1',[context.quote.id]);
        await db.query("UPDATE decisions SET expires_at=clock_timestamp()+interval '1 day' WHERE quote_id=$1",[context.quote.id]);
        if (mode==='recovery') {
          const otherProcess=new Market(db,config,provider.invoke);
          const recovered=await Promise.all([context.market.recoverStale(),otherProcess.recoverStale()]);
          assert.equal(recovered.reduce((sum,count)=>sum+count,0),1);
          assert.equal(await otherProcess.recoverStale(),0);
        }
      } finally { provider.response.resolve(structuredClone(successfulResult)); }
      const receipt=await purchase;
      assert.equal(receipt.status,'indeterminate',mode);
      assert.equal(receipt.error.code,'seller_owner_missing',mode);
      assert.equal((await context.market.decide(context.buyer.id,key,body)).error.code,'seller_owner_missing');
      assert.deepEqual(await walletBalances(context.buyer.id),{available:context.balance,reserved:0n});
      assert.deepEqual(await walletBalances(context.seller.id),{available:0n,reserved:0n});
      assert.equal(await platformBalance(),platformBefore);
      assert.equal(provider.calls,1);
      assert.deepEqual((await db.query('SELECT spent::text,reserved::text FROM budgets WHERE account_id=$1',[context.buyer.id])).rows,[{spent:'0',reserved:'0'}]);
      assert.equal((await db.query('SELECT id FROM transfers WHERE reference=ANY($1::text[])',[[`decision:${receipt.id}:fee`,`decision:${receipt.id}:seller`]])).rowCount,0);
    }
  });

  test('provider failures refund the reservation and remain terminal on identical retries', async () => {
    let calls = 0;
    const context = await fixture({ provider: async () => {
      calls++;
      throw new ProviderError('provider_invalid_result', 'Controlled invalid provider result');
    } });
    const key = randomUUID(), body = { quoteId: context.quote.id, ...decisionInput };
    await assert.rejects(context.market.decide(context.buyer.id, key, body), statusIs(502));
    const replay = await context.market.decide(context.buyer.id, key, body);
    assert.equal(replay.status, 'failed');
    assert.equal(replay.error.code, 'provider_failure');
    assert.equal(calls, 1);
    assert.deepEqual(await walletBalances(context.buyer.id), { available: context.balance, reserved: 0n });
    assert.deepEqual(await walletBalances(context.seller.id), { available: 0n, reserved: 0n });
    const row = await db.query('SELECT status,error_code FROM decisions WHERE account_id=$1', [context.buyer.id]);
    assert.equal(row.rows[0].status, 'failed');
    assert.equal(row.rows[0].error_code, 'provider_failure');
    const budget = await db.query('SELECT spent::text,reserved::text FROM budgets WHERE account_id=$1', [context.buyer.id]);
    assert.deepEqual(budget.rows, [{ spent: '0', reserved: '0' }]);
  });

  test('simultaneous stale recovery refunds once and fences late provider completion', async () => {
    const provider = heldProvider();
    const context = await fixture({ provider: provider.invoke });
    const key = randomUUID(), body = { quoteId: context.quote.id, ...decisionInput };
    const first = context.market.decide(context.buyer.id, key, body);
    // Attach rejection handling immediately, while preserving the final assertion.
    void first.catch(() => undefined);
    try {
      await provider.entered;
      await db.query("UPDATE decisions SET expires_at=now()-interval '1 second' WHERE account_id=$1", [context.buyer.id]);
      const otherProcess = new Market(db, config, provider.invoke);
      const recovered = await Promise.all([context.market.recoverStale(), otherProcess.recoverStale()]);
      assert.equal(recovered.reduce((sum, count) => sum + count, 0), 1);
      assert.equal(await context.market.recoverStale(), 0);
      assert.deepEqual(await walletBalances(context.buyer.id), { available: context.balance, reserved: 0n });
      const replay = await otherProcess.decide(context.buyer.id, key, body);
      assert.equal(replay.status, 'indeterminate');
      assert.equal(replay.error.code, 'execution_expired');
      assert.equal(provider.calls, 1);
    } finally {
      provider.response.resolve(structuredClone(successfulResult));
      assert.equal((await first).status, 'indeterminate');
    }
    assert.deepEqual(await walletBalances(context.buyer.id), { available: context.balance, reserved: 0n });
    assert.deepEqual(await walletBalances(context.seller.id), { available: 0n, reserved: 0n });
    const row = await db.query('SELECT status,response FROM decisions WHERE account_id=$1', [context.buyer.id]);
    assert.equal(row.rows[0].status, 'indeterminate');
    assert.equal(row.rows[0].response, null);
  });

  test('recovery releases the persisted reservation day, even after a UTC date rollover', async () => {
    const provider = heldProvider();
    const context = await fixture({ provider: provider.invoke });
    const first = context.market.decide(context.buyer.id, randomUUID(), { quoteId: context.quote.id, ...decisionInput });
    void first.catch(() => undefined);
    try {
      await provider.entered;
      // Move the complete persisted reservation to yesterday, emulating a
      // process restart after midnight without changing the host's clock.
      await transaction(db, async tx => {
        await tx.query('UPDATE budgets SET reserved=0 WHERE account_id=$1', [context.buyer.id]);
        await tx.query(`INSERT INTO budgets(account_id,day,reserved) VALUES($1,CURRENT_DATE-1,$2)`, [context.buyer.id, price.toString()]);
        await tx.query("UPDATE decisions SET budget_day=CURRENT_DATE-1,expires_at=now()-interval '1 second' WHERE account_id=$1", [context.buyer.id]);
      });
      assert.equal(await context.market.recoverStale(), 1);
      const budgets = await db.query('SELECT spent::text,reserved::text FROM budgets WHERE account_id=$1 ORDER BY day', [context.buyer.id]);
      assert.deepEqual(budgets.rows, [{ spent: '0', reserved: '0' }, { spent: '0', reserved: '0' }]);
    } finally {
      provider.response.resolve(structuredClone(successfulResult));
      assert.equal((await first).status, 'indeterminate');
    }
    assert.deepEqual(await walletBalances(context.buyer.id), { available: context.balance, reserved: 0n });
  });

  test('confidence thresholds preserve their precision and low-confidence responses follow the quoted charge policy', async () => {
    const result = structuredClone(successfulResult);
    result.answers.urgent = { type: 'noul', noul: 0.950000005 };
    const context = await fixture({ provider: async () => result });
    // This threshold rounds downward in PostgreSQL REAL; DOUBLE PRECISION is
    // required to preserve the buyer's JSON number through quote persistence.
    const quote = await context.market.quote(context.buyer.id, decisionInput, { minConfidence: 0.95000001 });
    assert.equal(quote.chargePolicy, 'schema_valid_response_including_low_confidence');
    const receipt = await context.market.decide(context.buyer.id, randomUUID(), { quoteId: quote.id, ...decisionInput });
    assert.equal(receipt.status, 'succeeded');
    assert.equal(receipt.confidence, 0.950000005);
    assert.equal(receipt.accepted, false);
    assert.deepEqual(await walletBalances(context.buyer.id), { available: context.balance - price, reserved: 0n });
  });
});
