import assert from 'node:assert/strict';
import { randomUUID, randomBytes } from 'node:crypto';
import { createServer } from 'node:http';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, rm, copyFile, writeFile, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { after, afterEach, before, describe, test } from 'node:test';
import type { FastifyInstance } from 'fastify';
import pg from 'pg';
import { build } from 'esbuild';
import { readConfig, type Config } from '../src/config.js';
import { createAccount, transaction, transfer, auditLedger, type Db } from '../src/db.js';
import { migrate } from '../src/migration.js';
import { Market } from '../src/market.js';
import { buildServer } from '../src/server.js';
import { Payments } from '../src/payments/index.js';
import { evaluateProvider, type ProviderResult } from '../src/provider.js';
import { buildOllamaSellerServer } from '../src/seller/http.js';
import { ZokoHttpClient, HttpError } from '../clients/typescript/zoko.js';

const databaseUrl=process.env.TEST_DATABASE_URL;
const exec=promisify(execFile);
const input={state:'deterministic protocol fixture; genuine_model_inference=false; simulated/payment-not-applicable',questions:{urgent:{type:'noul' as const}}};
const digest='b'.repeat(64);
const contract={version:'zoko.inference-offer/1',backend:'ollama',modelIdentity:`ollama:fixture:1@sha256:${digest}`,
  authorization:{sellerAuthorized:true,resalePermitted:true,basis:'owned_weights_license',evidenceReference:'test-fixture-not-live-permission'},
  questionTypes:['noul','choice','score'],maxInputBytes:32768,maxOutputBytes:262144,maxOutputTokens:256,maxConcurrency:1,deadlineMs:5000,usageRequirement:'backend_reported_required'};

describe('Independent HTTP inference lifecycle — genuine_model_inference=false; simulated/payment-not-applicable',{
  skip:databaseUrl?false:'Set TEST_DATABASE_URL for disposable PostgreSQL lifecycle validation',concurrency:false,timeout:120000,
},()=>{
  const schema=`zoko_inference_${randomUUID().replaceAll('-','')}`;
  let db:Db,control:pg.Pool,config:Config,app:FastifyInstance,sellerApp:FastifyInstance;
  let directory:string,origin:string,sellerOrigin:string,calls=0,mode='success';
  let buyer:Awaited<ReturnType<typeof createAccount>>,owner:Awaited<ReturnType<typeof createAccount>>,other:Awaited<ReturnType<typeof createAccount>>;
  let client:ZokoHttpClient;
  const endpointMap=new Map<string,string>();
  const endpointKey=randomBytes(32).toString('hex');
  const backend=createServer(async(req,res)=>{
    res.setHeader('content-type','application/json');
    if(req.url==='/api/tags'){res.end(JSON.stringify({models:[{name:'fixture:1',digest}]}));return;}
    if(req.url!=='/api/chat'){res.writeHead(404);res.end('{}');return;}
    for await(const _chunk of req){ /* consume bounded fixture request */ }
    calls++;
    if(mode==='delayed')await new Promise(r=>setTimeout(r,600));
    if(mode==='failure'){res.writeHead(503);res.end('{}');return;}
    const value:any={model:'fixture:1',done:true,done_reason:'stop',message:{content:JSON.stringify({answers:{urgent:{type:'noul',noul:0.9}}})},prompt_eval_count:23,eval_count:7};
    if(mode==='malformed')value.message.content='{bad';
    if(mode==='refusal')value.message.refusal='fixture';
    if(mode==='truncated')value.done_reason='length';
    if(mode==='wrong-model')value.model='different:1';
    if(mode==='missing-usage'){delete value.prompt_eval_count;delete value.eval_count;}
    if(mode==='missing-input')delete value.prompt_eval_count;
    if(mode==='missing-output')delete value.eval_count;
    res.end(JSON.stringify(value));
  });
  before(async()=>{
    directory=await mkdtemp(join(tmpdir(),'zoko-independent-'));
    control=new pg.Pool({connectionString:databaseUrl,max:1});await control.query(`CREATE SCHEMA ${schema}`);
    db=new pg.Pool({connectionString:databaseUrl,options:`-c search_path=${schema} -c timezone=UTC`,max:15});
    config=readConfig({NODE_ENV:'test',DATABASE_URL:databaseUrl,ZOKO_ADMIN_TOKEN:randomBytes(32).toString('hex'),ZOKO_ENCRYPTION_KEY:randomBytes(32).toString('base64'),ZOKO_PROVIDER_HOSTS:'seller.example',ZOKO_PAYMENTS_ENABLED:'false',ZOKO_PLATFORM_FEE_BPS:'1000'});
    await migrate(db);
    buyer=await createAccount(db,{name:'Independent fixture buyer',dailyLimitNanos:'100000',maxPriceNanos:'1000'});
    owner=await createAccount(db,{name:'Independent fixture seller owner',dailyLimitNanos:'0',maxPriceNanos:'0'});
    other=await createAccount(db,{name:'Other tenant',dailyLimitNanos:'100000',maxPriceNanos:'1000'});
    assert.notEqual(buyer.id,owner.id);
    await transaction(db,tx=>transfer(tx,'fixture-only-credit','external',`available:${buyer.id}`,100000n,{genuine_model_inference:false,payment:'simulated/payment-not-applicable'}));
    await new Promise<void>(r=>backend.listen(0,'127.0.0.1',r));const address=backend.address();assert(address&&typeof address==='object');
    const seller=await buildOllamaSellerServer({backendUrl:`http://127.0.0.1:${address.port}`,backendModel:'fixture:1',modelDigest:digest,marketplaceModel:'fixture-model',contract,dispatchDirectory:join(directory,'seller-dispatches')},endpointKey);
    sellerApp=seller.app;await seller.seller.preflight();sellerOrigin=await sellerApp.listen({host:'127.0.0.1',port:0});
    await startMarketplace();
    client=new ZokoHttpClient(origin,buyer.apiKey);
    const registered=await new ZokoHttpClient(origin,owner.apiKey).request('POST','/v1/seller/offers',{id:'independent-fixture',name:'Independent deterministic test seller',endpoint:'https://seller.example/v1/inference',apiKey:endpointKey,model:'fixture-model',priceNanos:'250',inferenceContract:contract});
    assert.equal(registered.enabled,false);assert.equal(registered.capacityUntil,null);
    // Operator approval in isolated fixture database; no permission or live capacity claim.
    await db.query("UPDATE sellers SET enabled=true WHERE id='independent-fixture'");
    await announce();
    await copyFile(resolve('clients/python/zoko.py'),join(directory,'zoko.py'));
    await build({entryPoints:[resolve('clients/typescript/zoko.ts')],outfile:join(directory,'zoko.mjs'),bundle:false,platform:'node',target:'node24',format:'esm'});
  });
  async function startMarketplace(){
    const payments=new Payments(db,config.payments);await payments.preflight();
    app=await buildServer(config,db,payments,(p,i,t)=>evaluateProvider({...p,endpoint:endpointMap.get(p.endpoint)??sellerOrigin+'/v1/inference'},i,t));
    origin=await app.listen({host:'127.0.0.1',port:0});
  }
  async function announce(){return new ZokoHttpClient(origin,owner.apiKey).request('POST','/v1/seller/offers/independent-fixture/capacity',{ready:true});}
  afterEach(async()=>{if(db){const audit=await auditLedger(db) as {ok:boolean};assert.equal(audit.ok,true);}});
  after(async()=>{
    if(app)await app.close();if(sellerApp)await sellerApp.close();backend.closeAllConnections();await new Promise<void>(r=>backend.close(()=>r()));
    if(db)await db.end();if(control){try{await control.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);}finally{await control.end();}}
    if(directory)await rm(directory,{recursive:true,force:true});
  });
  const policy={maxPriceNanos:'250',allowedSellers:['independent-fixture'],model:'fixture-model',usageRequirement:'backend_reported_required' as const};
  test('discovery, precise selection, immutable quote, HTTP submission, typed output, usage evidence and exact settlement',async()=>{
    assert.equal((await client.capabilities()).cancellation.supported,false);
    assert.equal((await client.discover()).openapi,'/v1/openapi.json');
    assert.equal((await client.request('GET','/v1/openapi.json',undefined,undefined,true)).openapi,'3.1.0');
    const offer=(await client.catalog()).sellers.find((s:any)=>s.id==='independent-fixture');assert.equal(offer.capacityEvidence,'seller_declared_expiring');assert.equal(offer.available,true);
    const path=join(directory,'typescript.purchase.json');const quote=await client.prepare(path,input,policy);
    await new ZokoHttpClient(origin,owner.apiKey).request('PATCH','/v1/seller/offers/independent-fixture',{priceNanos:'999'});
    const before=calls;const receipt=await client.execute(path);assert.equal(calls,before+1);assert.equal(receipt.priceNanos,'250');assert.equal(receipt.result.model,'fixture-model');
    assert.deepEqual(receipt.usageEvidence.actual,{input_tokens:23,output_tokens:7});assert.equal(receipt.usageEvidence.estimate,null);assert.equal(receipt.usageEvidence.verifiedByMarketplace,false);
    assert.equal((await client.poll(path,receipt.id,0)).id,receipt.id);
    assert.deepEqual(await client.recover(path),receipt);assert.equal(calls,before+1);
    const transfers=(await db.query('SELECT reference,amount::text FROM transfers WHERE reference LIKE $1 ORDER BY reference',[`decision:${receipt.id}:%`])).rows;
    assert.deepEqual(transfers.map(t=>t.amount),['25','250','225']);
    const wrong=new ZokoHttpClient(origin,other.apiKey);
    await assert.rejects(wrong.request('GET',`/v1/decisions/${receipt.id}`),(e:any)=>e instanceof HttpError&&e.status===404);
    await assert.rejects(wrong.execute(path),/account mismatch/);
    await assert.rejects(client.request('POST','/v1/decisions',{quoteId:quote.quote.id,...input,state:'changed'},quote.idempotencyKey),(e:any)=>e.code==='idempotency_conflict');
    await new ZokoHttpClient(origin,owner.apiKey).request('PATCH','/v1/seller/offers/independent-fixture',{priceNanos:'250'});
    assert.equal(JSON.parse(await readFile(`${path}.receipt.json`,'utf8')).id,receipt.id);
  });
  test('independent Python client runs outside the repository and recovers the same purchase in a new process',async()=>{
    const runner=join(directory,'buyer.py');
    await writeFile(runner,`import os,json\nfrom zoko import ZokoHttpClient\nc=ZokoHttpClient(os.environ['FIXTURE_ORIGIN'],os.environ['FIXTURE_KEY'])\np=os.environ['FIXTURE_JOURNAL']\nif os.environ['FIXTURE_MODE']=='prepare':\n c.discover(); c.catalog(); c.prepare(p,json.loads(os.environ['FIXTURE_INPUT']),json.loads(os.environ['FIXTURE_POLICY']))\nr=c.execute(p) if os.environ['FIXTURE_MODE']=='prepare' else c.recover(p)\nassert c.poll(p,r['id'],0)==r\nprint(json.dumps({'id':r['id'],'status':r['status'],'genuine_model_inference':False,'payment':'simulated/payment-not-applicable'}))\n`);
    const env={...process.env,FIXTURE_ORIGIN:origin,FIXTURE_KEY:buyer.apiKey,FIXTURE_JOURNAL:join(directory,'python.purchase.json'),FIXTURE_INPUT:JSON.stringify(input),FIXTURE_POLICY:JSON.stringify(policy)};
    const before=calls;const first=await exec('python',[runner],{cwd:directory,env:{...env,FIXTURE_MODE:'prepare'},timeout:20000});
    const recovered=await exec('python',[runner],{cwd:directory,env:{...env,FIXTURE_MODE:'recover'},timeout:20000});assert.deepEqual(JSON.parse(first.stdout),JSON.parse(recovered.stdout));assert.equal(calls,before+1);
  });
  test('standalone TypeScript HTTP artifact runs with Node outside the repository without server/shared SDK imports',async()=>{
    const runner=join(directory,'buyer.mjs');await writeFile(runner,`import assert from 'node:assert/strict';import {ZokoHttpClient} from './zoko.mjs';const c=new ZokoHttpClient(process.env.FIXTURE_ORIGIN,process.env.FIXTURE_KEY);const p=process.env.FIXTURE_JOURNAL;await c.prepare(p,JSON.parse(process.env.FIXTURE_INPUT),JSON.parse(process.env.FIXTURE_POLICY));const r=await c.execute(p);assert.deepEqual(await c.recover(p),r);console.log(JSON.stringify({id:r.id,status:r.status}));`);
    const before=calls;const result=await exec(process.execPath,[runner],{cwd:directory,env:{...process.env,FIXTURE_ORIGIN:origin,FIXTURE_KEY:buyer.apiKey,FIXTURE_JOURNAL:join(directory,'standalone.purchase.json'),FIXTURE_INPUT:JSON.stringify(input),FIXTURE_POLICY:JSON.stringify(policy)},timeout:20000});assert.equal(JSON.parse(result.stdout).status,'succeeded');assert.equal(calls,before+1);
  });
  test('model/schema mismatch, expiry, owner-only presence and unavailable capacity reject before reservation or backend dispatch',async()=>{
    const before=calls;
    await assert.rejects(client.prepare(join(directory,'wrong-model.json'),input,{...policy,model:'other-model'}),(e:any)=>e.code==='no_seller');
    await db.query("UPDATE sellers SET inference_contract=jsonb_set(inference_contract,'{questionTypes}','[\"choice\"]'::jsonb) WHERE id='independent-fixture'");
    await assert.rejects(client.prepare(join(directory,'wrong-schema.json'),input,policy),(e:any)=>e.code==='no_seller');
    await db.query("UPDATE sellers SET inference_contract=$1 WHERE id='independent-fixture'",[JSON.stringify(contract)]);
    const path=join(directory,'expired-capacity.json');await client.prepare(path,input,policy);
    await db.query("UPDATE sellers SET capacity_until=clock_timestamp()-interval '1 second' WHERE id='independent-fixture'");
    assert.equal((await client.catalog()).sellers.find((s:any)=>s.id==='independent-fixture').available,false);
    assert.equal((await app.inject('/health/ready')).json().tradingReady,false);
    await assert.rejects(client.execute(path),(e:any)=>e.code==='seller_unavailable');
    await assert.rejects(new ZokoHttpClient(origin,other.apiKey).request('POST','/v1/seller/offers/independent-fixture/capacity',{ready:true}),(e:any)=>e.status===404);
    assert.equal(calls,before);await announce();
    const response=await sellerApp.inject({method:'POST',url:'/v1/inference',payload:{model:'fixture-model',...input}});assert.equal(response.statusCode,401);
  });
  test('buyer HTTP abort retains its original identity while inference continues; running poll recovers one terminal charge',async()=>{
    await announce();mode='delayed';
    const path=join(directory,'aborted-http.purchase.json');await client.prepare(path,input,policy);const before=calls;
    await assert.rejects(new ZokoHttpClient(origin,buyer.apiKey,150).execute(path),(e:any)=>e.name==='TimeoutError');
    const running=await client.recover(path);assert.equal(running.status,'running');assert.equal(calls,before+1);
    assert.equal((await client.catalog()).sellers.find((s:any)=>s.id==='independent-fixture').available,false);
    const receipt=await client.poll(path,running.id,5000);assert.equal(receipt.status,'succeeded');assert.equal(calls,before+1);
    const refs=(await db.query('SELECT reference FROM transfers WHERE reference LIKE $1',[`decision:${receipt.id}:%`])).rows;
    assert.equal(refs.length,3);assert.ok(!refs.some(r=>r.reference.endsWith(':refund')));
    assert.equal(await new Market(db,config).recoverStale(),0);mode='success';
  });
  test('optional-usage offer retains partial and absent backend usage with no estimates or invented counts',async()=>{
    const address=backend.address();assert(address&&typeof address==='object');
    const optionalContract={...contract,usageRequirement:'backend_reported_optional'};
    const optional=await buildOllamaSellerServer({backendUrl:`http://127.0.0.1:${address.port}`,backendModel:'fixture:1',modelDigest:digest,marketplaceModel:'fixture-model',contract:optionalContract,dispatchDirectory:join(directory,'optional-dispatches')},endpointKey);
    const optionalOrigin=await optional.app.listen({host:'127.0.0.1',port:0});
    endpointMap.set('https://seller.example/v1/optional',optionalOrigin+'/v1/inference');
    try{
      const sellerClient=new ZokoHttpClient(origin,owner.apiKey);
      await sellerClient.request('POST','/v1/seller/offers',{id:'optional-fixture',name:'Optional usage deterministic fixture',endpoint:'https://seller.example/v1/optional',apiKey:endpointKey,model:'fixture-model',priceNanos:'250',inferenceContract:optionalContract});
      await db.query("UPDATE sellers SET enabled=true WHERE id='optional-fixture'");await sellerClient.request('POST','/v1/seller/offers/optional-fixture/capacity',{ready:true});
      for(const kind of ['missing-input','missing-output','missing-usage']){
        mode=kind;const path=join(directory,`optional-${kind}.json`);
        await client.prepare(path,input,{maxPriceNanos:'250',model:'fixture-model',allowedSellers:['optional-fixture']});
        const receipt=await client.execute(path);
        assert.deepEqual(receipt.usageEvidence.actual,kind==='missing-input'?{input_tokens:null,output_tokens:7}:kind==='missing-output'?{input_tokens:23,output_tokens:null}:null);
        assert.equal(receipt.usageEvidence.estimate,null);assert.equal(receipt.usageEvidence.missingFields.length,kind==='missing-usage'?2:1);
      }
    }finally{mode='success';await db.query("UPDATE sellers SET paused=true WHERE id='optional-fixture'");await optional.app.close();endpointMap.delete('https://seller.example/v1/optional');}
  });
  test('refusal, truncation, malformed output, wrong backend model and missing required usage refund once and retain failed identity',async()=>{
    for(const kind of ['refusal','truncated','malformed','wrong-model','missing-usage']){
      mode=kind;await db.query("UPDATE sellers SET failures=0,circuit_until=NULL WHERE id='independent-fixture'");await announce();
      const path=join(directory,`${kind}.purchase.json`);await client.prepare(path,input,policy);const before=calls;
      await assert.rejects(client.execute(path),(e:any)=>e.code==='provider_failure');
      const receipt=await client.recover(path);assert.equal(receipt.status,'failed');assert.equal(calls,before+1);
      const terminal=(await db.query('SELECT reference FROM transfers WHERE reference LIKE $1',[`decision:${receipt.id}:%`])).rows.map(r=>r.reference);
      assert.equal(terminal.length,2);assert.ok(terminal.some(r=>r.endsWith(':refund')));assert.ok(!terminal.some(r=>r.endsWith(':seller')));
    }
    mode='success';await db.query("UPDATE sellers SET failures=0,circuit_until=NULL WHERE id='independent-fixture'");
  });
  test('restart and expired quote preserve original succeeded identity without redispatch',async()=>{
    await announce();const path=join(directory,'restart.purchase.json');const journal=await client.prepare(path,input,policy);const receipt=await client.execute(path);const before=calls;
    await app.close();const payments=new Payments(db,config.payments);await payments.preflight();
    app=await buildServer(config,db,payments,(p,i,t)=>evaluateProvider({...p,endpoint:sellerOrigin+'/v1/inference'},i,t));
    const url=new URL(origin);await app.listen({host:'127.0.0.1',port:Number(url.port)});
    await db.query("UPDATE quotes SET expires_at=clock_timestamp()-interval '1 hour' WHERE id=$1",[journal.quote.id]);
    assert.deepEqual(await new ZokoHttpClient(origin,buyer.apiKey).recover(path),receipt);assert.equal(calls,before);
  });
  test('concurrent admission enforces capacity; stale recovery wins late completion without double settlement',async()=>{
    await announce();
    let finish!:(value:ProviderResult)=>void,entered!:()=>void;
    const began=new Promise<void>(r=>{entered=r;});let dispatches=0;
    const market=new Market(db,config,async()=>{dispatches++;entered();return new Promise<ProviderResult>(r=>{finish=r;});});
    const q1=await market.quote(buyer.id,input,policy),q2=await market.quote(buyer.id,input,policy);
    const pending=market.decide(buyer.id,'held-capacity-first',{quoteId:q1.id,...input});await began;
    assert.equal((await client.catalog()).sellers.find((s:any)=>s.id==='independent-fixture').available,false);
    await assert.rejects(market.decide(buyer.id,'held-capacity-second',{quoteId:q2.id,...input}),(e:any)=>e.code==='seller_unavailable');
    const d=(await db.query('SELECT * FROM decisions WHERE quote_id=$1',[q1.id])).rows[0];
    await db.query("UPDATE decisions SET expires_at=clock_timestamp()-interval '1 second' WHERE id=$1",[d.id]);
    const [a,b]=await Promise.all([market.recoverStale(),new Market(db,config).recoverStale()]);assert.equal(a+b,1);
    finish({model:'fixture-model',answers:{urgent:{type:'noul',noul:0.9}},usage:{input_tokens:1,output_tokens:1}});
    assert.equal((await pending).status,'indeterminate');assert.equal(dispatches,1);
    const refs=(await db.query('SELECT reference FROM transfers WHERE reference LIKE $1',[`decision:${d.id}:%`])).rows;assert.equal(refs.length,2);assert.equal(refs.filter(r=>r.reference.endsWith(':refund')).length,1);
    assert.equal((await market.decide(buyer.id,'held-capacity-first',{quoteId:q1.id,...input})).id,d.id);
  });
  test('backend HTTP failure refunds once, retains purchase identity and quarantines uncertain seller dispatch',async()=>{
    await announce();mode='failure';const path=join(directory,'backend-failure.json');await client.prepare(path,input,policy);const before=calls;
    await assert.rejects(client.execute(path),(e:any)=>e.code==='provider_failure');
    const receipt=await client.recover(path);assert.equal(receipt.status,'failed');assert.equal(calls,before+1);
    const refs=(await db.query('SELECT reference FROM transfers WHERE reference LIKE $1',[`decision:${receipt.id}:%`])).rows;
    assert.equal(refs.length,2);assert.equal(refs.filter(r=>r.reference.endsWith(':refund')).length,1);
    assert.equal((await sellerApp.inject('/health/ready')).statusCode,503);
    await new ZokoHttpClient(origin,owner.apiKey).request('POST','/v1/seller/offers/independent-fixture/capacity',{ready:false});
    assert.equal((await client.catalog()).sellers.find((s:any)=>s.id==='independent-fixture').available,false);mode='success';
  });
});
