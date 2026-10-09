import assert from 'node:assert/strict';
import { randomBytes, randomUUID } from 'node:crypto';
import { after, afterEach, before, describe, test } from 'node:test';
import pg from 'pg';
import { readConfig, type Config } from '../src/config.js';
import { auditLedger, createAccount, type Db } from '../src/db.js';
import { Market } from '../src/market.js';
import { migrate } from '../src/migration.js';
import type { DecisionInput } from '../src/protocol.js';
import { AppError, digest, encrypt } from '../src/security.js';

const databaseUrl=process.env.TEST_DATABASE_URL;
const input:DecisionInput={state:'Synthetic quote admission only; no model inference or payment',questions:{urgent:{type:'noul',instructions:'Is this urgent?'}}};
const contract={version:'zoko.inference-offer/1',backend:'synthetic-test',modelIdentity:'fixture-model@sha256:'+'a'.repeat(64),
  authorization:{sellerAuthorized:true,resalePermitted:true,basis:'owned_weights_license',evidenceReference:'synthetic-test-only'},
  questionTypes:['noul'],maxInputBytes:32768,maxOutputBytes:262144,maxOutputTokens:256,maxConcurrency:1,deadlineMs:5000,
  usageRequirement:'backend_reported_required'};

describe('bounded quote reselection with real PostgreSQL and synthetic offers',{
  skip:databaseUrl?false:'Set TEST_DATABASE_URL for disposable PostgreSQL quote admission tests',concurrency:false,timeout:120000,
},()=>{
  const schema=`zoko_quote_${randomUUID().replaceAll('-','')}`;
  let control:pg.Pool,db:Db,config:Config;

  before(async()=>{
    assert.ok(databaseUrl);
    control=new pg.Pool({connectionString:databaseUrl,max:1,connectionTimeoutMillis:5000});
    await control.query(`CREATE SCHEMA ${schema}`);
    db=new pg.Pool({connectionString:databaseUrl,options:`-c search_path=${schema} -c timezone=UTC`,max:20,
      connectionTimeoutMillis:5000,statement_timeout:15000,application_name:schema});
    config=readConfig({NODE_ENV:'test',DATABASE_URL:databaseUrl,ZOKO_ADMIN_TOKEN:randomBytes(32).toString('hex'),
      ZOKO_ENCRYPTION_KEY:randomBytes(32).toString('base64'),ZOKO_PROVIDER_HOSTS:'api.typesafe.ai',
      ZOKO_PLATFORM_FEE_BPS:'1000',ZOKO_PAYMENTS_ENABLED:'false'});
    await migrate(db);
  });
  after(async()=>{
    if(db)await db.end();
    if(control){try{await control.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);}finally{await control.end();}}
  });
  afterEach(async()=>{
    if(!db)return;
    const audit=await auditLedger(db) as {ok:boolean,totalNanos:string};
    assert.equal(audit.ok,true,JSON.stringify(audit));
    assert.equal(audit.totalNanos,'0');
  });

  async function fixture(){
    const first=`quote-first-${randomUUID()}`,second=`quote-second-${randomUUID()}`;
    const buyer=await createAccount(db,{name:'Synthetic quote buyer',dailyLimitNanos:'1000',maxPriceNanos:'500',allowedSellers:[first,second]});
    const firstOwner=await createAccount(db,{name:'Synthetic first owner',dailyLimitNanos:'0',maxPriceNanos:'0'});
    const secondOwner=await createAccount(db,{name:'Synthetic second owner',dailyLimitNanos:'0',maxPriceNanos:'0'});
    const firstKey=encrypt('synthetic-first-key',config.encryptionKey);
    const secondKey=encrypt('synthetic-second-key',config.encryptionKey);
    for(const [id,owner,key,price] of [[first,firstOwner.id,firstKey,'250'],[second,secondOwner.id,secondKey,'275']]){
      await db.query(`INSERT INTO sellers(id,name,endpoint,api_key_encrypted,model,price_nanos,payout_account_id,
        inference_contract,capacity_until,delivery_mode) VALUES($1,$2,$3,$4,$5,$6,$7,$8,clock_timestamp()+interval '10 minutes','https')`,
      [id,'Synthetic capacity offer','https://api.typesafe.ai/v1/systemone',key,'fixture-model',price,owner,JSON.stringify(contract)]);
    }
    const market=new Market(db,config);
    const policy={maxPriceNanos:'500',allowedSellers:[first,second],model:'fixture-model',usageRequirement:'backend_reported_required' as const};
    return {buyer,first,second,firstOwner,secondOwner,secondKey,market,policy};
  }

  async function waitForSellerLock(applicationName=schema){
    const until=Date.now()+3000;
    while(Date.now()<until){
      const found=await control.query(`SELECT EXISTS(SELECT 1 FROM pg_stat_activity WHERE application_name=$1
        AND wait_event_type='Lock' AND query LIKE '%FROM sellers WHERE id=$1 FOR UPDATE%') AS waiting`,[applicationName]);
      if(found.rows[0].waiting)return;
      await new Promise(resolve=>setTimeout(resolve,10));
    }
    assert.fail('Quote did not reach the seller row lock before the test deadline');
  }

  async function waitForAccountLock(){
    const until=Date.now()+3000;
    while(Date.now()<until){
      const found=await control.query(`SELECT EXISTS(SELECT 1 FROM pg_stat_activity WHERE application_name=$1
        AND wait_event_type='Lock' AND query LIKE '%FROM accounts WHERE id=ANY%FOR UPDATE%') AS waiting`,[schema]);
      if(found.rows[0].waiting)return;
      await new Promise(resolve=>setTimeout(resolve,10));
    }
    assert.fail('Quote did not reach the owner account lock before the test deadline');
  }

  async function assertNoReservation(buyerId:string,quoteCount:number){
    const quotes=await db.query('SELECT count(*)::integer AS count FROM quotes WHERE account_id=$1',[buyerId]);
    assert.equal(quotes.rows[0].count,quoteCount);
    const decisions=await db.query('SELECT count(*)::integer AS count FROM decisions WHERE account_id=$1',[buyerId]);
    const budgets=await db.query('SELECT count(*)::integer AS count FROM budgets WHERE account_id=$1',[buyerId]);
    const transfers=await db.query('SELECT count(*)::integer AS count FROM transfers WHERE from_wallet=$1 OR to_wallet=$1',[`available:${buyerId}`]);
    assert.equal(decisions.rows[0].count,0);
    assert.equal(budgets.rows[0].count,0);
    assert.equal(transfers.rows[0].count,0);
    const wallets=await db.query('SELECT id,balance::text FROM wallets WHERE id=ANY($1::text[]) ORDER BY id',[[`available:${buyerId}`,`reserved:${buyerId}`]]);
    assert.deepEqual(wallets.rows.map(row=>row.balance),['0','0']);
  }

  test('first offer loses its lease during admission and the next eligible fixed quote wins',async()=>{
    const f=await fixture();
    const blocker=await db.connect();
    await blocker.query('BEGIN');
    await blocker.query('SELECT id FROM sellers WHERE id=$1 FOR UPDATE',[f.first]);
    const pending=f.market.quote(f.buyer.id,input,f.policy);
    void pending.catch(()=>undefined);
    try{
      await waitForSellerLock();
      await blocker.query("UPDATE sellers SET capacity_until=clock_timestamp()-interval '1 second' WHERE id=$1",[f.first]);
    }finally{await blocker.query('COMMIT');blocker.release();}
    const quote=await pending;
    assert.equal(quote.sellerId,f.second);
    assert.equal(quote.priceNanos,'275');
    assert.equal(quote.model,'fixture-model');
    assert.equal(quote.inferenceContract.maxConcurrency,1);
    assert.equal(quote.requestHash,digest(input));
    assert.equal(quote.schemaHash,digest(input.questions));
    await db.query('UPDATE sellers SET price_nanos=999,endpoint=$2 WHERE id=$1',[f.second,'https://api.typesafe.ai/v1/changed']);
    const frozen=await db.query('SELECT * FROM quotes WHERE id=$1',[quote.id]);
    assert.equal(frozen.rowCount,1);
    assert.equal(frozen.rows[0].price_nanos,'275');
    assert.equal(frozen.rows[0].endpoint,'https://api.typesafe.ai/v1/systemone');
    assert.equal(frozen.rows[0].api_key_encrypted,f.secondKey);
    assert.equal(frozen.rows[0].payout_account_id,f.secondOwner.id);
    assert.equal(frozen.rows[0].fee_bps,config.platformFeeBps);
    await assertNoReservation(f.buyer.id,1);
  });

  test('both offers lose capacity and no quote or reservation is created',async()=>{
    const f=await fixture();
    const blocker=await db.connect();
    await blocker.query('BEGIN');
    await blocker.query('SELECT id FROM sellers WHERE id=$1 FOR UPDATE',[f.first]);
    const pending=f.market.quote(f.buyer.id,input,f.policy);
    void pending.catch(()=>undefined);
    try{
      await waitForSellerLock();
      await blocker.query("UPDATE sellers SET capacity_until=clock_timestamp()-interval '1 second' WHERE id=ANY($1::text[])",[[f.first,f.second]]);
    }finally{await blocker.query('COMMIT');blocker.release();}
    await assert.rejects(pending,(error:unknown)=>error instanceof AppError&&error.code==='quote_selection_busy');
    await assertNoReservation(f.buyer.id,0);
  });

  test('initially empty selection remains no_seller',async()=>{
    const f=await fixture();
    await db.query("UPDATE sellers SET capacity_until=clock_timestamp()-interval '1 second' WHERE id=ANY($1::text[])",[[f.first,f.second]]);
    await assert.rejects(f.market.quote(f.buyer.id,input,f.policy),
      (error:unknown)=>error instanceof AppError&&error.code==='no_seller');
    await assertNoReservation(f.buyer.id,0);
  });

  test('disabled selected owner releases its lock before a second offer is admitted',async()=>{
    const f=await fixture();
    const blocker=await db.connect();
    await blocker.query('BEGIN');
    await blocker.query('SELECT id FROM accounts WHERE id=$1 FOR UPDATE',[f.firstOwner.id]);
    const pending=f.market.quote(f.buyer.id,input,f.policy);
    void pending.catch(()=>undefined);
    try{
      await waitForAccountLock();
      await blocker.query('UPDATE accounts SET disabled=true WHERE id=$1',[f.firstOwner.id]);
    }finally{await blocker.query('COMMIT');blocker.release();}
    const quote=await pending;
    assert.equal(quote.sellerId,f.second);
    await assertNoReservation(f.buyer.id,1);
  });

  test('actual locked contract schema change falls back to the next offer',async()=>{
    const f=await fixture();
    const blocker=await db.connect();
    await blocker.query('BEGIN');
    await blocker.query('SELECT id FROM sellers WHERE id=$1 FOR UPDATE',[f.first]);
    const pending=f.market.quote(f.buyer.id,input,f.policy);
    void pending.catch(()=>undefined);
    try{
      await waitForSellerLock();
      await blocker.query('UPDATE sellers SET inference_contract=$2 WHERE id=$1',[f.first,JSON.stringify({...contract,questionTypes:['score']})]);
    }finally{await blocker.query('COMMIT');blocker.release();}
    const quote=await pending;
    assert.equal(quote.sellerId,f.second);
    await assertNoReservation(f.buyer.id,1);
  });

  test('reselection stops at its fixed bound and reports contention without a false no-seller claim',async()=>{
    const f=await fixture();
    const extra=Array.from({length:15},()=>`quote-extra-${randomUUID()}`);
    for(const [index,id] of extra.entries()){
      await db.query(`INSERT INTO sellers(id,name,endpoint,api_key_encrypted,model,price_nanos,payout_account_id,
        inference_contract,capacity_until,delivery_mode) VALUES($1,$2,$3,$4,$5,$6,$7,$8,clock_timestamp()+interval '10 minutes','https')`,
      [id,'Synthetic contested offer','https://api.typesafe.ai/v1/systemone',f.secondKey,'fixture-model',String(280+index),f.secondOwner.id,JSON.stringify(contract)]);
    }
    await db.query('UPDATE accounts SET allowed_sellers=$2 WHERE id=$1',[f.buyer.id,[f.first,f.second,...extra]]);
    const checked:string[]=[];
    const mutable=f.market as any;
    const original=mutable.checkContract;
    mutable.checkContract=async(_tx:unknown,seller:{id:string})=>{
      checked.push(seller.id);
      throw new AppError(503,'seller_unavailable','Synthetic capacity loss after selection');
    };
    try{
      await assert.rejects(f.market.quote(f.buyer.id,input,{maxPriceNanos:'500',model:'fixture-model',usageRequirement:'backend_reported_required'}),
        (error:unknown)=>error instanceof AppError&&error.code==='quote_selection_busy');
    }finally{mutable.checkContract=original;}
    assert.equal(checked.length,16);
    assert.deepEqual(checked,[f.first,f.second,...extra.slice(0,14)]);
    await assertNoReservation(f.buyer.id,0);
  });

  test('database deadline cancels a blocked admission without retry or reservation',async()=>{
    const f=await fixture();
    const deadlineDb=new pg.Pool({connectionString:databaseUrl,options:`-c search_path=${schema} -c timezone=UTC`,max:2,
      connectionTimeoutMillis:5000,statement_timeout:350,application_name:`${schema}_deadline`});
    const blocker=await db.connect();
    await blocker.query('BEGIN');
    await blocker.query('SELECT id FROM sellers WHERE id=$1 FOR UPDATE',[f.first]);
    try{
      const started=Date.now();
      await assert.rejects(new Market(deadlineDb,config).quote(f.buyer.id,input,f.policy),
        (error:unknown)=>typeof error==='object'&&error!==null&&'code' in error&&error.code==='57014');
      assert.ok(Date.now()-started<1500,'A cancelled selection must not continue through retry attempts');
      await assertNoReservation(f.buyer.id,0);
    }finally{await blocker.query('COMMIT');blocker.release();await deadlineDb.end();}
    const quote=await f.market.quote(f.buyer.id,input,f.policy);
    assert.equal(quote.sellerId,f.first);
    await assertNoReservation(f.buyer.id,1);
  });
});
