import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import type { Db, Tx } from './db.js';
import { transaction, transfer, lockWallets } from './db.js';
import { MoneySchema, type Config } from './config.js';
import { AppError, decrypt, digest, encrypt, validateEndpoint } from './security.js';
import { DecisionInputSchema, type DecisionInput } from './protocol.js';
import { evaluateProvider, resultConfidence } from './provider.js';
import { evaluateRestrictedProvider } from './provider-network.js';

export const PolicySchema = z.object({
  maxPriceNanos: MoneySchema.optional(),
  maxLatencyMs: z.number().int().min(100).max(60000).optional(),
  minConfidence: z.number().min(0).max(1).optional(),
  allowedSellers: z.array(z.string().min(1).max(64)).min(1).max(100).optional(),
}).strict();
export type Policy = z.infer<typeof PolicySchema>;
export type Provider = typeof evaluateProvider;
type Row = Record<string, any>; // PostgreSQL rows, narrowed at trust boundaries by schema and SQL constraints.

export class Market {
  constructor(private db: Db, private config: Config, private provider: Provider = evaluateRestrictedProvider) {}

  async seed(): Promise<void> {
    if (!this.config.jevApiKey) return;
    const encrypted = encrypt(this.config.jevApiKey, this.config.encryptionKey);
    // Operator edits survive restarts; env only provisions the initial offer.
    await this.db.query(`INSERT INTO sellers(id,name,endpoint,api_key_encrypted,model,price_nanos)
      VALUES('jev','Jev · TypeSafe','https://api.typesafe.ai/v1/systemone',$1,$2,$3) ON CONFLICT(id) DO NOTHING`, [encrypted,this.config.jevModel,this.config.jevPriceNanos]);
  }

  async catalog(): Promise<unknown[]> {
    const sellers = await this.db.query(`SELECT s.id,s.name,s.model,s.price_nanos,s.enabled,s.circuit_until,
      (SELECT count(*)::integer FROM decisions d WHERE d.seller_id=s.id AND d.status='succeeded') AS completed,
      (SELECT percentile_cont(0.95) WITHIN GROUP(ORDER BY latency_ms) FROM decisions d WHERE d.seller_id=s.id AND d.status='succeeded' AND d.created_at>now()-interval '24 hours') AS p95_ms
      FROM sellers s WHERE s.enabled ORDER BY s.price_nanos,s.id`);
    return sellers.rows.map(s => ({id:s.id,name:s.name,model:s.model,priceNanos:s.price_nanos,questionTypes:['choice','score','noul'],available:!s.circuit_until || new Date(s.circuit_until).getTime()<=Date.now(),completed:s.completed,p95LatencyMs:s.p95_ms===null?null:Math.round(s.p95_ms),confidenceProvenance:'provider_reported',protocol:'typesafe-systemone-v1'}));
  }

  async quote(accountId: string, raw: DecisionInput, rawPolicy: Policy = {}): Promise<Row> {
    const input = DecisionInputSchema.parse(raw), policy = PolicySchema.parse(rawPolicy);
    const account = await this.account(this.db, accountId);
    let price = BigInt(account.max_price_nanos);
    if (policy.maxPriceNanos !== undefined && BigInt(policy.maxPriceNanos)<price) price = BigInt(policy.maxPriceNanos);
    const selected = await this.db.query(`SELECT * FROM sellers WHERE enabled AND price_nanos<=$1
      AND (circuit_until IS NULL OR circuit_until<=now())
      AND ($2::text[] IS NULL OR id=ANY($2)) AND ($3::text[] IS NULL OR id=ANY($3))
      ORDER BY price_nanos,id LIMIT 1`, [price.toString(), account.allowed_sellers, policy.allowedSellers ?? null]);
    if (!selected.rowCount) throw new AppError(503,'no_seller','No enabled seller meets the account and request policy');
    const s = selected.rows[0], id = randomUUID(), requestHash = digest(input), schemaHash = digest(input.questions);
    validateEndpoint(s.endpoint, this.config.providerHosts);
    const timeoutMs = Math.min(policy.maxLatencyMs ?? this.config.providerMaxTimeoutMs, this.config.providerMaxTimeoutMs);
    const row = await this.db.query(`INSERT INTO quotes(id,account_id,seller_id,request_hash,schema_hash,price_nanos,endpoint,api_key_encrypted,model,payout_account_id,fee_bps,timeout_ms,min_confidence,expires_at)
      VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,now()+$14*interval '1 second') RETURNING expires_at`,
    [id,accountId,s.id,requestHash,schemaHash,s.price_nanos,s.endpoint,s.api_key_encrypted,s.model,s.payout_account_id,this.config.platformFeeBps,timeoutMs,policy.minConfidence ?? 0,this.config.quoteTtlSeconds]);
    return {id,sellerId:s.id,model:s.model,priceNanos:s.price_nanos,schemaHash,requestHash,expiresAt:row.rows[0].expires_at.toISOString(),timeoutMs,minConfidence:policy.minConfidence ?? 0,chargePolicy:'schema_valid_response_including_low_confidence',currency:'nanoXEC'};
  }

  async decide(accountId: string, idempotencyKey: string, body: {quoteId:string} & DecisionInput): Promise<Row> {
    if (!/^[A-Za-z0-9_.:-]{8,128}$/.test(idempotencyKey)) throw new AppError(400,'invalid_idempotency_key','Idempotency-Key must contain 8–128 URL-safe characters');
    z.uuid().parse(body.quoteId);
    const input = DecisionInputSchema.parse({state:body.state,questions:body.questions});
    const fingerprint = digest({quoteId:body.quoteId,...input});
    const admitted = await transaction(this.db, async tx => {
      const account = await this.account(tx, accountId, true);
      const previous = await tx.query('SELECT * FROM decisions WHERE account_id=$1 AND idempotency_key=$2', [accountId,idempotencyKey]);
      if (previous.rowCount) {
        if (previous.rows[0].request_hash !== fingerprint) throw new AppError(409,'idempotency_conflict','This idempotency key was used with a different request');
        return {previous:previous.rows[0]};
      }
      const quotes = await tx.query('SELECT *,expires_at>clock_timestamp() AS valid FROM quotes WHERE id=$1 AND account_id=$2 FOR UPDATE', [body.quoteId,accountId]);
      if (!quotes.rowCount) throw new AppError(404,'quote_not_found','Quote not found');
      const q = quotes.rows[0];
      if (!q.valid) throw new AppError(409,'quote_expired','Quote expired; obtain a new quote');
      if (q.request_hash !== digest(input) || q.schema_hash !== digest(input.questions)) throw new AppError(409,'quote_input_mismatch','Input or questions do not match the quote');
      const used = await tx.query('SELECT id FROM decisions WHERE quote_id=$1', [q.id]);
      if (used.rowCount) throw new AppError(409,'quote_consumed','Quote already used; replay the original idempotency key');
      const seller = await tx.query('SELECT enabled,circuit_until FROM sellers WHERE id=$1', [q.seller_id]);
      if (!seller.rows[0]?.enabled || (seller.rows[0].circuit_until && new Date(seller.rows[0].circuit_until).getTime()>Date.now())) throw new AppError(503,'seller_unavailable','Quoted seller is currently unavailable');
      if (BigInt(q.price_nanos)>BigInt(account.max_price_nanos) || (account.allowed_sellers && !account.allowed_sellers.includes(q.seller_id))) throw new AppError(403,'spending_policy','The quote no longer meets the account policy');
      validateEndpoint(q.endpoint,this.config.providerHosts);
      const day = (await tx.query("SELECT (clock_timestamp() AT TIME ZONE 'UTC')::date::text AS day")).rows[0].day;
      await tx.query('INSERT INTO budgets(account_id,day) VALUES($1,$2) ON CONFLICT DO NOTHING',[accountId,day]);
      const budget = (await tx.query('SELECT spent,reserved FROM budgets WHERE account_id=$1 AND day=$2 FOR UPDATE',[accountId,day])).rows[0];
      const amount = BigInt(q.price_nanos);
      if (BigInt(budget.spent)+BigInt(budget.reserved)+amount>BigInt(account.daily_limit_nanos)) throw new AppError(403,'daily_limit','The UTC daily spending limit would be exceeded');
      const id = randomUUID();
      try { await transfer(tx,`decision:${id}:reserve`,`available:${accountId}`,`reserved:${accountId}`,amount,{decisionId:id}); }
      catch (error) {
        if (error instanceof AppError && error.statusCode===402) throw new AppError(402,'payment_required','Fund the assigned eCash address before purchasing a decision',{depositAddress:account.deposit_address,requiredNanos:q.price_nanos,method:'xec_prepaid_ledger',currency:'nanoXEC'});
        throw error;
      }
      await tx.query('UPDATE budgets SET reserved=reserved+$1 WHERE account_id=$2 AND day=$3',[q.price_nanos,accountId,day]);
      const decision = (await tx.query(`INSERT INTO decisions(id,account_id,quote_id,idempotency_key,request_hash,seller_id,price_nanos,budget_day,status,expires_at)
        VALUES($1,$2,$3,$4,$5,$6,$7,$8,'running',clock_timestamp()+$9*interval '1 millisecond') RETURNING *`,[id,accountId,q.id,idempotencyKey,fingerprint,q.seller_id,q.price_nanos,day,q.timeout_ms+5000])).rows[0];
      return {decision,quote:q};
    });
    if (admitted.previous) return this.receipt(admitted.previous);
    const d = admitted.decision!, q = admitted.quote!;
    const started = performance.now();
    let result: Awaited<ReturnType<Provider>>;
    try {
      result = await this.provider({endpoint:q.endpoint,apiKey:decrypt(q.api_key_encrypted,this.config.encryptionKey),model:q.model},input,q.timeout_ms);
    } catch {
      await this.fail(d.id,accountId,'provider_failure');
      throw new AppError(502,'provider_failure','The provider did not return a valid result; reserved funds were released');
    }
    const latencyMs = Math.round(performance.now()-started);
    return transaction(this.db, async tx => {
      await tx.query('SELECT id FROM accounts WHERE id=$1 FOR UPDATE',[accountId]);
      const current = (await tx.query('SELECT *,expires_at>clock_timestamp() AS live FROM decisions WHERE id=$1 FOR UPDATE',[d.id])).rows[0];
      if (current.status !== 'running') return this.receipt(current);
      if (!current.live) {
        await this.refund(tx,current,'indeterminate','execution_expired');
        // Return a terminal object so the refund transaction commits.
        return {id:d.id,status:'indeterminate',error:{code:'execution_expired',message:'Execution deadline expired; funds released'}};
      }
      const amount = BigInt(q.price_nanos), fee = q.payout_account_id ? amount*BigInt(q.fee_bps)/10000n : amount;
      await lockWallets(tx,[`reserved:${accountId}`,...(fee>0n?['platform']:[]),...(amount-fee>0n?[`available:${q.payout_account_id}`]:[])]);
      if (fee>0n) await transfer(tx,`decision:${d.id}:fee`,`reserved:${accountId}`,'platform',fee,{decisionId:d.id});
      if (amount-fee>0n) await transfer(tx,`decision:${d.id}:seller`,`reserved:${accountId}`,`available:${q.payout_account_id}`,amount-fee,{decisionId:d.id,sellerId:q.seller_id});
      await tx.query('UPDATE budgets SET reserved=reserved-$1,spent=spent+$1 WHERE account_id=$2 AND day=(SELECT budget_day FROM decisions WHERE id=$3)',[q.price_nanos,accountId,d.id]);
      const confidence = resultConfidence(result);
      const response = {id:d.id,status:'succeeded',sellerId:q.seller_id,priceNanos:q.price_nanos,schemaHash:q.schema_hash,requestHash:q.request_hash,result,confidence,accepted:confidence>=q.min_confidence,confidenceProvenance:'provider_reported_or_noul_probability',latencyMs,createdAt:d.created_at.toISOString()};
      await tx.query("UPDATE decisions SET status='succeeded',response=$1,latency_ms=$2,completed_at=now() WHERE id=$3",[JSON.stringify(response),latencyMs,d.id]);
      await tx.query('UPDATE sellers SET failures=0,circuit_until=NULL WHERE id=$1',[q.seller_id]);
      return response;
    });
  }

  private async account(db: Pick<Db,'query'> | Tx,id:string, lock=false): Promise<Row> {
    const result = await db.query(`SELECT * FROM accounts WHERE id=$1${lock?' FOR UPDATE':''}`,[id]);
    if (!result.rowCount || result.rows[0].disabled) throw new AppError(403,'account_disabled','Account is unavailable');
    return result.rows[0];
  }

  private receipt(d: Row): Row {
    if (d.status==='succeeded') return d.response;
    if (d.status==='running') return {id:d.id,status:'running',retryAfter:1};
    return {id:d.id,status:d.status,error:{code:d.error_code ?? 'provider_failure',message:'No charge was captured for this request'}};
  }

  private async refund(tx: Tx,d:Row,status:'failed'|'indeterminate',code:string):Promise<void> {
    await transfer(tx,`decision:${d.id}:refund`,`reserved:${d.account_id}`,`available:${d.account_id}`,BigInt(d.price_nanos),{decisionId:d.id});
    await tx.query('UPDATE budgets SET reserved=reserved-$1 WHERE account_id=$2 AND day=(SELECT budget_day FROM decisions WHERE id=$3)',[d.price_nanos,d.account_id,d.id]);
    await tx.query('UPDATE decisions SET status=$1,error_code=$2,completed_at=now() WHERE id=$3',[status,code,d.id]);
  }

  private async fail(id:string,accountId:string,code:string):Promise<void> {
    await transaction(this.db,async tx => {
      await tx.query('SELECT id FROM accounts WHERE id=$1 FOR UPDATE',[accountId]);
      const d = (await tx.query('SELECT * FROM decisions WHERE id=$1 FOR UPDATE',[id])).rows[0];
      if (d.status!=='running') return;
      await this.refund(tx,d,'failed',code);
      await tx.query("UPDATE sellers SET failures=failures+1,circuit_until=CASE WHEN failures+1>=3 THEN now()+interval '60 seconds' ELSE circuit_until END WHERE id=$1",[d.seller_id]);
    });
  }

  async recoverStale():Promise<number> {
    const stale = await this.db.query("SELECT id,account_id FROM decisions WHERE status='running' AND expires_at<clock_timestamp() ORDER BY expires_at LIMIT 100");
    let recovered=0;
    for (const row of stale.rows) await transaction(this.db,async tx => {
      await tx.query('SELECT id FROM accounts WHERE id=$1 FOR UPDATE',[row.account_id]);
      const current = await tx.query("SELECT * FROM decisions WHERE id=$1 AND status='running' AND expires_at<clock_timestamp() FOR UPDATE",[row.id]);
      if (!current.rowCount) return;
      await this.refund(tx,current.rows[0],'indeterminate','execution_expired'); recovered++;
    });
    return recovered;
  }

  async getDecision(accountId:string,id:string):Promise<Row> {
    const d = await this.db.query('SELECT * FROM decisions WHERE id=$1 AND account_id=$2',[id,accountId]);
    if (!d.rowCount) throw new AppError(404,'decision_not_found','Decision not found');
    return this.receipt(d.rows[0]);
  }
}
