import pg from 'pg';
import { randomUUID } from 'node:crypto';
import { AppError, issueKey, keyHash } from './security.js';
import { MoneySchema } from './config.js';

export type Db = pg.Pool;
export type Tx = pg.PoolClient;
export function createDb(connectionString: string): Db {
  const pool = new pg.Pool({ connectionString, max: 20, connectionTimeoutMillis: 5000, idleTimeoutMillis: 30000, statement_timeout: 15000, application_name: 'zoko' });
  pool.on('error', () => console.error('An idle database connection failed; the pool will reconnect.'));
  return pool;
}
export async function transaction<T>(db: Db, fn: (tx: Tx) => Promise<T>): Promise<T> {
  const tx = await db.connect();
  try { await tx.query('BEGIN'); const result = await fn(tx); await tx.query('COMMIT'); return result; }
  catch (error) { await tx.query('ROLLBACK'); throw error; }
  finally { tx.release(); }
}
/** Acquire the complete wallet set before any multi-leg journal operation. */
export async function lockWallets(tx: Tx, ids: string[]): Promise<void> {
  const unique = [...new Set(ids)].sort();
  const rows = await tx.query('SELECT id FROM wallets WHERE id=ANY($1::text[]) ORDER BY id FOR UPDATE', [unique]);
  if (rows.rowCount !== unique.length) throw new Error('Missing ledger wallet');
}
export async function transfer(tx: Tx, reference: string, from: string, to: string, amount: bigint, metadata: unknown = {}): Promise<void> {
  if (amount <= 0n || amount >= 10n ** 40n || from === to) throw new Error('Invalid transfer');
  // The same journal reference is serialized even when callers use different wallets.
  await tx.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))', [`transfer:${reference}`]);
  const previous = await tx.query('SELECT * FROM transfers WHERE reference=$1', [reference]);
  if (previous.rowCount) {
    const old = previous.rows[0];
    if (old.from_wallet !== from || old.to_wallet !== to || BigInt(old.amount) !== amount) throw new Error('Conflicting transfer reference');
    return;
  }
  const wallets = await tx.query('SELECT id,balance FROM wallets WHERE id=ANY($1::text[]) ORDER BY id FOR UPDATE', [[from, to]]);
  if (wallets.rowCount !== 2) throw new Error('Missing ledger wallet');
  const source = wallets.rows.find(w => w.id === from);
  if (from !== 'external' && BigInt(source.balance) < amount) throw new AppError(402, 'insufficient_funds', 'Insufficient available balance');
  await tx.query('UPDATE wallets SET balance=balance-$1::numeric WHERE id=$2', [amount.toString(), from]);
  await tx.query('UPDATE wallets SET balance=balance+$1::numeric WHERE id=$2', [amount.toString(), to]);
  await tx.query('INSERT INTO transfers(reference,from_wallet,to_wallet,amount,metadata) VALUES($1,$2,$3,$4,$5)', [reference, from, to, amount.toString(), JSON.stringify(metadata)]);
}
export async function createAccount(db: Db, input: {name:string; dailyLimitNanos:string; maxPriceNanos:string; allowedSellers?:string[]}): Promise<{id:string;name:string;apiKey:string}> {
  const id = randomUUID(), apiKey = issueKey();
  MoneySchema.parse(input.dailyLimitNanos); MoneySchema.parse(input.maxPriceNanos);
  await transaction(db, async tx => {
    await tx.query('INSERT INTO accounts(id,name,api_key_hash,daily_limit_nanos,max_price_nanos,allowed_sellers) VALUES($1,$2,$3,$4,$5,$6)', [id, input.name, keyHash(apiKey), input.dailyLimitNanos, input.maxPriceNanos, input.allowedSellers ?? null]);
    await tx.query('INSERT INTO wallets(id) VALUES($1),($2)', [`available:${id}`, `reserved:${id}`]);
    await tx.query('INSERT INTO audit_events(actor,action,subject) VALUES($1,$2,$3)', ['admin','account.created',id]);
  });
  return {id, name: input.name, apiKey};
}
export async function auditLedger(db: Db): Promise<unknown> {
  return transaction(db, async tx => {
  await tx.query('SET TRANSACTION ISOLATION LEVEL REPEATABLE READ, READ ONLY');
  const total = await tx.query('SELECT COALESCE(sum(balance),0)::text AS total FROM wallets');
  const mismatches = await tx.query(`SELECT w.id,w.balance::text,COALESCE(p.expected,0)::text AS expected FROM wallets w LEFT JOIN
      (SELECT wallet,sum(delta) AS expected FROM
        (SELECT to_wallet AS wallet,amount AS delta FROM transfers UNION ALL SELECT from_wallet,-amount FROM transfers) t GROUP BY wallet) p
      ON p.wallet=w.id WHERE w.balance<>COALESCE(p.expected,0)`);
  const reserved = await tx.query(`SELECT b.account_id,b.day,b.reserved::text,COALESCE(d.expected,0)::text AS expected FROM budgets b LEFT JOIN
      (SELECT account_id,budget_day,sum(price_nanos) AS expected FROM decisions WHERE status='running' GROUP BY account_id,budget_day) d
      ON b.account_id=d.account_id AND b.day=d.budget_day WHERE b.reserved<>COALESCE(d.expected,0)`);
  const reservations = await tx.query(`WITH held AS (
      SELECT account_id,price_nanos AS amount FROM decisions WHERE status='running'
      UNION ALL SELECT account_id,amount_nanos+max_fee_nanos FROM payments_withdrawals
        WHERE status IN ('requested','preparing','signed','broadcast','manual_review')
    ), expected AS (SELECT account_id,sum(amount) AS amount FROM held GROUP BY account_id)
    SELECT a.id AS account_id,w.balance::text AS actual,COALESCE(e.amount,0)::text AS expected
    FROM accounts a JOIN wallets w ON w.id='reserved:'||a.id
    LEFT JOIN expected e ON e.account_id=a.id WHERE w.balance<>COALESCE(e.amount,0)`);
  return {ok:total.rows[0].total==='0' && !mismatches.rowCount && !reserved.rowCount && !reservations.rowCount,totalNanos:total.rows[0].total,walletMismatches:mismatches.rows,budgetMismatches:reserved.rows,reservationMismatches:reservations.rows};
  });
}
