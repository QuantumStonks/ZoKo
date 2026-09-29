import assert from 'node:assert/strict';
import { randomBytes,randomUUID } from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { after,afterEach,before,describe,test } from 'node:test';
import pg from 'pg';
import { buildServer } from '../src/server.js';
import { readConfig } from '../src/config.js';
import { migrate } from '../src/migration.js';
import { createAccount,transaction,transfer,auditLedger,type Db } from '../src/db.js';
import { Market } from '../src/market.js';
import { Payments } from '../src/payments/index.js';

const databaseUrl=process.env.TEST_DATABASE_URL;
// Controlled fixture outputs exercise contracts; never count as real inference.
const input={state:{text:'An outage'},questions:{urgent:{type:'noul' as const}}};
const result={model:'integration-agent',answers:{urgent:{type:'noul',noul:0.9}},usage:null};
describe('Active-agent delivery against genuine PostgreSQL',{
  skip:databaseUrl?false:'Set TEST_DATABASE_URL',concurrency:false,timeout:120000,
},()=>{
  const schema=`zoko_agent_${randomUUID().replaceAll('-','')}`;
  let control:pg.Pool,db:Db,app:Awaited<ReturnType<typeof buildServer>>,market:Market;
  let config:ReturnType<typeof readConfig>;
  before(async()=>{
    control=new pg.Pool({connectionString:databaseUrl,max:1});await control.query(`CREATE SCHEMA ${schema}`);
    db=new pg.Pool({connectionString:databaseUrl,options:`-c search_path=${schema} -c timezone=UTC`,max:10});
    config=readConfig({DATABASE_URL:databaseUrl,ZOKO_ADMIN_TOKEN:randomBytes(32).toString('hex'),ZOKO_ENCRYPTION_KEY:randomBytes(32).toString('base64'),ZOKO_PAYMENTS_ENABLED:'false',ZOKO_PROVIDER_TIMEOUT_MS:'60000'});
    await migrate(db);const payments=new Payments(db,config.payments);await payments.preflight();
    app=await buildServer(config,db,payments,async()=>{throw new Error('Native agent must never call an HTTPS inference provider');});
    await app.ready();market=new Market(db,config);
  });
  afterEach(async()=>{const audit=await auditLedger(db) as {ok:boolean,totalNanos:string};assert.equal(audit.ok,true);assert.equal(audit.totalNanos,'0');});
  after(async()=>{if(app)await app.close();if(db)await db.end();if(control){await control.query(`DROP SCHEMA ${schema} CASCADE`);await control.end();}});
  function request(method:'GET'|'POST'|'PATCH',url:string,token:string,payload?:unknown,key?:string){return app.inject({method,url,headers:{authorization:`Bearer ${token}`,...(payload===undefined?{}:{'content-type':'application/json'}),...(key?{'idempotency-key':key}: {})},payload:payload===undefined?undefined:JSON.stringify(payload)});}
  async function fixture(){
    const seller=await createAccount(db,{name:'Fixture seller',dailyLimitNanos:'10000',maxPriceNanos:'1000'});
    const buyer=await createAccount(db,{name:'Fixture buyer',dailyLimitNanos:'10000',maxPriceNanos:'1000'});
    const other=await createAccount(db,{name:'Other fixture owner',dailyLimitNanos:'0',maxPriceNanos:'0'});
    const id=`agent-${randomUUID()}`;
    const registration=await request('POST','/v1/seller/agent-offers',seller.apiKey,{id,name:'Fixture active agent',model:result.model,priceNanos:'250'});
    assert.equal(registration.statusCode,201,registration.body);assert.equal(registration.json().enabled,false);assert.equal(registration.json().endpoint,null);
    await transaction(db,tx=>transfer(tx,`fixture:${buyer.id}`,'external',`available:${buyer.id}`,1000n));
    return {seller,buyer,other,id};
  }
  async function ready(f:Awaited<ReturnType<typeof fixture>>){
    const approval=await request('PATCH',`/v1/admin/sellers/${f.id}`,config.adminToken,{enabled:true});assert.equal(approval.statusCode,200,approval.body);
    const presence=await request('POST',`/v1/seller/offers/${f.id}/ready`,f.seller.apiKey,{ready:true});assert.equal(presence.statusCode,200,presence.body);
  }
  async function admit(f:Awaited<ReturnType<typeof fixture>>){
    const q=await market.quote(f.buyer.id,input,{allowedSellers:[f.id],maxLatencyMs:60000});
    const receipt=await market.decide(f.buyer.id,randomUUID(),{quoteId:q.id,...input});assert.equal(receipt.status,'running');return {q,receipt};
  }
  async function balance(id:string){return (await db.query('SELECT balance::text FROM wallets WHERE id=$1',[`available:${id}`])).rows[0].balance;}

  test('read-only doctor accepts credential-free active agents and detects expired presence',async()=>{
    const f=await fixture();await ready(f);
    const url=new URL(databaseUrl!);url.searchParams.set('options',`-c search_path=${schema} -c timezone=UTC`);
    const env={PATH:process.env.PATH,SystemRoot:process.env.SystemRoot,DATABASE_URL:url.href,
      ZOKO_ADMIN_TOKEN:config.adminToken,ZOKO_ENCRYPTION_KEY:config.encryptionKey,ZOKO_PAYMENTS_ENABLED:'false'};
    async function diagnose(){
      // Disabled payments intentionally produce exit 1; inspect its truthful checks.
      try{const output=await promisify(execFile)(process.execPath,['--import','tsx','src/doctor.ts'],{env,timeout:15000});return JSON.parse(output.stdout);}
      catch(error){const output=error as {stdout?:string};assert.ok(output.stdout,'Doctor must produce sanitized diagnostics');return JSON.parse(output.stdout);}
    }
    let diagnosis=await diagnose();assert.equal(diagnosis.checks.find((c:any)=>c.name==='seller_configuration').status,'pass');
    assert.equal(diagnosis.checks.find((c:any)=>c.name==='trading').status,'pass');
    await db.query("UPDATE sellers SET agent_ready_until=now()-interval '1 second' WHERE delivery_mode='agent'");
    diagnosis=await diagnose();assert.equal(diagnosis.checks.find((c:any)=>c.name==='seller_configuration').status,'pass');
    assert.equal(diagnosis.checks.find((c:any)=>c.name==='trading').status,'warning');
  });

  test('approval and live presence are required; no inference credential or fake availability',async()=>{
    const f=await fixture();await assert.rejects(market.quote(f.buyer.id,input,{allowedSellers:[f.id]}),/No active seller/);
    await request('PATCH',`/v1/admin/sellers/${f.id}`,config.adminToken,{enabled:true});
    assert.equal((await market.catalog() as any[]).find(s=>s.id===f.id).available,false);
    await assert.rejects(market.quote(f.buyer.id,input,{allowedSellers:[f.id]}),/No active seller/);
    await ready(f);assert.equal((await market.catalog() as any[]).find(s=>s.id===f.id).available,true);
    await db.query("UPDATE sellers SET agent_ready_until=now()-interval '1 second' WHERE id=$1",[f.id]);
    assert.equal((await market.catalog() as any[]).find(s=>s.id===f.id).available,false);
  });
  test('one claim, owner isolation, durable replay, exact settlement and conflicting-result rejection',async()=>{
    const f=await fixture();await ready(f);const {receipt}=await admit(f);
    assert.equal(await balance(f.buyer.id),'750');
    await assert.rejects(market.quote(f.buyer.id,input,{allowedSellers:[f.id]}),/No active seller/);
    const foreign=await request('POST','/v1/seller/jobs/claim',f.other.apiKey,{sellerId:f.id},randomUUID());assert.equal(foreign.statusCode,409);
    const keys=[randomUUID(),randomUUID()];
    const claimed=await Promise.all(keys.map(key=>request('POST','/v1/seller/jobs/claim',f.seller.apiKey,{sellerId:f.id},key)));
    claimed.forEach(r=>assert.equal(r.statusCode,200,r.body));
    const winner=claimed.findIndex(r=>r.json().job!==null);assert.ok(winner>=0);assert.equal(claimed.filter(r=>r.json().job!==null).length,1);
    const job=claimed[winner].json().job;assert.deepEqual(job.input,input);
    const stolen=await request('POST',`/v1/seller/jobs/${job.id}/complete`,f.other.apiKey,{claimToken:job.claimToken,result});assert.equal(stolen.statusCode,404);
    await request('POST',`/v1/seller/offers/${f.id}/ready`,f.seller.apiKey,{ready:false});
    const replay=await new Market(db,config).claimAgentJob(f.seller.id,f.id,keys[winner]);assert.deepEqual(JSON.parse(JSON.stringify(replay.job)),job);
    const invalid=await request('POST',`/v1/seller/jobs/${job.id}/complete`,f.seller.apiKey,{claimToken:job.claimToken,result:{...result,usage:{input_tokens:0,output_tokens:0}}});assert.equal(invalid.statusCode,400);
    const capture=await request('POST',`/v1/seller/jobs/${job.id}/complete`,f.seller.apiKey,{claimToken:job.claimToken,result});assert.equal(capture.statusCode,200,capture.body);assert.equal(capture.json().status,'succeeded');assert.equal(capture.json().result.usage,null);
    assert.equal(await balance(f.seller.id),'225');assert.equal(await balance(f.buyer.id),'750');
    const duplicate=await request('POST',`/v1/seller/jobs/${job.id}/complete`,f.seller.apiKey,{claimToken:job.claimToken,result});assert.deepEqual(duplicate.json(),capture.json());
    const conflict=await request('POST',`/v1/seller/jobs/${job.id}/complete`,f.seller.apiKey,{claimToken:job.claimToken,result:{...result,answers:{urgent:{type:'noul',noul:0.1}}}});assert.equal(conflict.statusCode,409);
    assert.deepEqual(await market.getDecision(f.buyer.id,receipt.id),capture.json());
    assert.equal((await db.query("SELECT count(*)::integer AS n FROM transfers WHERE reference=$1",[`decision:${job.id}:seller`])).rows[0].n,1);
  });
  test('late and abandoned delivery refund once across restart without reassigning inference',async()=>{
    const f=await fixture();await ready(f);const {receipt}=await admit(f);
    const key=randomUUID(),claimed=await market.claimAgentJob(f.seller.id,f.id,key),job=claimed.job;
    await db.query("UPDATE decisions SET expires_at=now()-interval '1 second' WHERE id=$1",[receipt.id]);
    const completion=await market.completeAgentJob(f.seller.id,job.id,job.claimToken,result);assert.equal(completion.status,'indeterminate');
    assert.equal(await balance(f.buyer.id),'1000');assert.equal(await balance(f.seller.id),'0');
    await new Market(db,config).recoverStale();
    assert.equal((await market.claimAgentJob(f.seller.id,f.id,key)).job.id,job.id);
    assert.deepEqual(await market.completeAgentJob(f.seller.id,job.id,job.claimToken,result),completion);
    assert.equal((await db.query('SELECT count(*)::integer AS n FROM transfers WHERE reference=$1',[`decision:${job.id}:refund`])).rows[0].n,1);
    await ready(f);const abandoned=await admit(f);
    await db.query("UPDATE decisions SET expires_at=now()-interval '1 second' WHERE id=$1",[abandoned.receipt.id]);
    assert.equal(await new Market(db,config).recoverStale(),1);assert.equal(await balance(f.buyer.id),'1000');
  });
});
