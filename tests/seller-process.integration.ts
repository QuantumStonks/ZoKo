import assert from 'node:assert/strict';
import { spawn, execFile } from 'node:child_process';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { createServer } from 'node:http';
import { createServer as createTcpServer } from 'node:net';
import { copyFile, mkdir, mkdtemp, readFile, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { test } from 'node:test';
import pg from 'pg';
import { readConfig } from '../src/config.js';
import { auditLedger, createAccount, transaction, transfer } from '../src/db.js';
import { migrate } from '../src/migration.js';
import { Payments } from '../src/payments/index.js';
import { evaluateProvider } from '../src/provider.js';
import { buildServer } from '../src/server.js';
import { createOllamaSeller } from '../src/seller/ollama.js';
import { ZokoHttpClient, HttpError } from '../clients/typescript/zoko.js';

const databaseUrl=process.env.TEST_DATABASE_URL;
const root=resolve(fileURLToPath(new URL('..',import.meta.url)));
const exec=promisify(execFile);
const digest='b'.repeat(64);
const input={state:'deterministic protocol fixture; genuine_model_inference=false; simulated/payment-not-applicable',questions:{urgent:{type:'noul' as const}}};
const contract={version:'zoko.inference-offer/1',backend:'ollama',modelIdentity:`ollama:fixture:1@sha256:${digest}`,
  authorization:{sellerAuthorized:true,resalePermitted:true,basis:'owned_weights_license',evidenceReference:'test-fixture-not-live-permission'},
  questionTypes:['noul','choice','score'],maxInputBytes:32768,maxOutputBytes:262144,maxOutputTokens:256,maxConcurrency:1,deadlineMs:5000,usageRequirement:'backend_reported_required'};
const sleep=(ms:number)=>new Promise(r=>setTimeout(r,ms));
const exists=(path:string)=>stat(path).then(()=>true,()=>false);
async function exited(child:ReturnType<typeof spawn>,timeoutMs=5000){
  if(child.exitCode!==null||child.signalCode!==null)return true;
  await Promise.race([new Promise<void>(yes=>child.once('exit',()=>yes())),sleep(timeoutMs)]);
  return child.exitCode!==null||child.signalCode!==null;
}

async function freePort():Promise<number>{
  const server=createTcpServer();await new Promise<void>((yes,no)=>{server.once('error',no);server.listen(0,'127.0.0.1',yes);});
  const address=server.address();assert(address&&typeof address==='object');
  await new Promise<void>((yes,no)=>server.close(error=>error?no(error):yes()));return address.port;
}

test('separate emitted seller process and buyer; synthetic fixture, disposable PostgreSQL, no real funds or inference',
  {skip:databaseUrl?false:'Requires disposable TEST_DATABASE_URL',timeout:120000},async()=>{
  const runsRoot=join(root,'.local','seller-process-review','runs');
  await mkdir(runsRoot,{recursive:true});
  const directory=await mkdtemp(join(runsRoot,'fixture-'));
  const outsideDirectory=await mkdtemp(join(tmpdir(),'zoko-seller-process-work-'));
  const schema=`zoko_process_${randomUUID().replaceAll('-','')}`;
  const endpointKey=randomBytes(32).toString('hex');
  let db:pg.Pool|undefined,control:pg.Pool|undefined,app:Awaited<ReturnType<typeof buildServer>>|undefined;
  let child:ReturnType<typeof spawn>|undefined,restart:ReturnType<typeof spawn>|undefined;
  let mode:'success'|'failure'='success',calls=0,childOutput='';
  const backend=createServer(async(req,res)=>{
    res.setHeader('content-type','application/json');
    if(req.url==='/api/tags'){res.end(JSON.stringify({models:[{name:'fixture:1',digest}]}));return;}
    if(req.url!=='/api/chat'){res.writeHead(404);res.end('{}');return;}
    for await(const _ of req){/* synthetic request only */}
    calls++;
    if(mode==='failure'){res.writeHead(503);res.end('{}');return;}
    res.end(JSON.stringify({model:'fixture:1',done:true,done_reason:'stop',message:{content:JSON.stringify({answers:{urgent:{type:'noul',noul:0.9}}})},prompt_eval_count:23,eval_count:7}));
  });
  try{
    control=new pg.Pool({connectionString:databaseUrl,max:1});await control.query(`CREATE SCHEMA ${schema}`);
    db=new pg.Pool({connectionString:databaseUrl,options:`-c search_path=${schema} -c timezone=UTC`,max:10});await migrate(db);
    const config=readConfig({NODE_ENV:'test',DATABASE_URL:databaseUrl,ZOKO_ADMIN_TOKEN:randomBytes(32).toString('hex'),ZOKO_ENCRYPTION_KEY:randomBytes(32).toString('base64'),ZOKO_PROVIDER_HOSTS:'seller.example',ZOKO_PAYMENTS_ENABLED:'false',ZOKO_PLATFORM_FEE_BPS:'1000'});
    const buyer=await createAccount(db,{name:'Synthetic process fixture buyer',dailyLimitNanos:'100000',maxPriceNanos:'1000'});
    const owner=await createAccount(db,{name:'Synthetic process fixture seller',dailyLimitNanos:'0',maxPriceNanos:'0'});
    await transaction(db,tx=>transfer(tx,'process-fixture-credit','external',`available:${buyer.id}`,100000n,{genuine_model_inference:false,payment:'simulated/payment-not-applicable'}));
    await new Promise<void>(yes=>backend.listen(0,'127.0.0.1',yes));const address=backend.address();assert(address&&typeof address==='object');
    const sellerPort=await freePort(),sellerOrigin=`http://127.0.0.1:${sellerPort}`;
    const dispatchDirectory=join(directory,'dispatches');
    const sellerConfig={backendUrl:`http://127.0.0.1:${address.port}`,backendModel:'fixture:1',modelDigest:digest,marketplaceModel:'fixture-model',contract,dispatchDirectory};
    await writeFile(join(directory,'seller.json'),JSON.stringify(sellerConfig));
    const sellerExecutable=join(root,'dist','src','seller','main.js');
    child=spawn(process.execPath,[sellerExecutable],{cwd:outsideDirectory,env:{...process.env,ZOKO_SELLER_CONFIG:join(directory,'seller.json'),ZOKO_SELLER_ENDPOINT_KEY:endpointKey,ZOKO_SELLER_PORT:String(sellerPort)},windowsHide:true,stdio:['ignore','pipe','pipe']});
    child.stdout?.on('data',chunk=>{childOutput+=String(chunk).slice(0,1000);});child.stderr?.on('data',chunk=>{childOutput+=String(chunk).slice(0,1000);});
    let ready=false;
    for(let i=0;i<100;i++){
      if(child.exitCode!==null)break;
      try{const response=await fetch(`${sellerOrigin}/health/ready`);if(response.status===200){ready=true;break;}}catch{}
      await sleep(100);
    }
    assert.equal(ready,true,`Seller failed first-use CLI preflight/start (exit ${child.exitCode}; output ${childOutput.slice(0,500)})`);
    const capabilities=await (await fetch(`${sellerOrigin}/v1/capabilities`)).json() as any;
    assert.equal(capabilities.model,'fixture-model');assert.equal(capabilities.inferenceContract.modelIdentity,contract.modelIdentity);
    assert.equal(capabilities.liveInferenceVerified,false);
    const unauthorized=await fetch(`${sellerOrigin}/v1/inference`,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({model:'fixture-model',...input})});assert.equal(unauthorized.status,401);
    const payments=new Payments(db,config.payments);await payments.preflight();
    app=await buildServer(config,db,payments,(p,i,t)=>evaluateProvider({...p,endpoint:`${sellerOrigin}/v1/inference`},i,t));
    const origin=await app.listen({host:'127.0.0.1',port:0});
    const sellerClient=new ZokoHttpClient(origin,owner.apiKey),buyerClient=new ZokoHttpClient(origin,buyer.apiKey);
    const registered=await sellerClient.request('POST','/v1/seller/offers',{id:'process-fixture',name:'Synthetic process fixture seller',endpoint:'https://seller.example/v1/inference',apiKey:endpointKey,model:'fixture-model',priceNanos:'250',inferenceContract:contract});
    assert.equal(registered.enabled,false);assert.equal(registered.capacityUntil,null);
    await db.query("UPDATE sellers SET enabled=true WHERE id='process-fixture'");
    await sellerClient.request('POST','/v1/seller/offers/process-fixture/capacity',{ready:true});
    const offer=(await buyerClient.catalog()).sellers.find((s:any)=>s.id==='process-fixture');assert.equal(offer.available,true);
    const artifact=join(root,'dist','http-clients','zoko.mjs');await copyFile(artifact,join(outsideDirectory,'zoko.mjs'));
    assert.equal(createHash('sha256').update(await readFile(artifact)).digest('hex'),createHash('sha256').update(await readFile(join(outsideDirectory,'zoko.mjs'))).digest('hex'));
    const runner=join(outsideDirectory,'buyer.mjs');
    await writeFile(runner,`import assert from 'node:assert/strict';import {ZokoHttpClient} from './zoko.mjs';const c=new ZokoHttpClient(process.env.FIXTURE_ORIGIN,process.env.FIXTURE_KEY);const path=process.env.FIXTURE_JOURNAL;if(process.env.FIXTURE_MODE==='prepare')await c.prepare(path,JSON.parse(process.env.FIXTURE_INPUT),JSON.parse(process.env.FIXTURE_POLICY));const r=process.env.FIXTURE_MODE==='prepare'?await c.execute(path):await c.recover(path);assert.deepEqual(await c.poll(path,r.id,0),r);console.log(JSON.stringify({id:r.id,status:r.status,priceNanos:r.priceNanos,usage:r.usageEvidence?.actual,genuine_model_inference:false,payment:'simulated/payment-not-applicable'}));`);
    const buyerEnv={...process.env,FIXTURE_ORIGIN:origin,FIXTURE_KEY:buyer.apiKey,FIXTURE_JOURNAL:join(directory,'buyer.purchase.json'),FIXTURE_INPUT:JSON.stringify(input),FIXTURE_POLICY:JSON.stringify({maxPriceNanos:'250',allowedSellers:['process-fixture'],model:'fixture-model',usageRequirement:'backend_reported_required'})};
    const first=JSON.parse((await exec(process.execPath,[runner],{cwd:outsideDirectory,env:{...buyerEnv,FIXTURE_MODE:'prepare'},timeout:20000})).stdout);
    const recovered=JSON.parse((await exec(process.execPath,[runner],{cwd:outsideDirectory,env:{...buyerEnv,FIXTURE_MODE:'recover'},timeout:20000})).stdout);
    assert.deepEqual(first,recovered);assert.deepEqual({...first,id:null},{id:null,status:'succeeded',priceNanos:'250',usage:{input_tokens:23,output_tokens:7},genuine_model_inference:false,payment:'simulated/payment-not-applicable'});
    assert.equal(calls,1);
    const receipt=JSON.parse(await readFile(join(directory,'buyer.purchase.json.receipt.json'),'utf8'));
    assert.equal(receipt.id,first.id);
    assert.equal(JSON.parse(await readFile(join(directory,'buyer.purchase.json.decision.json'),'utf8')).id,first.id);
    const transfers=(await db.query('SELECT amount::text FROM transfers WHERE reference LIKE $1 ORDER BY reference',[`decision:${receipt.id}:%`])).rows;
    assert.deepEqual(transfers.map((r:any)=>r.amount),['25','250','225']);
    const balance=async(wallet:string)=>(await db!.query('SELECT balance::text FROM wallets WHERE id=$1',[wallet])).rows[0].balance;
    assert.equal(await balance(`available:${buyer.id}`),'99750');
    assert.equal(await balance(`reserved:${buyer.id}`),'0');
    assert.equal(await balance(`available:${owner.id}`),'225');
    assert.equal(await balance('platform'),'25');
    assert.equal((await auditLedger(db) as any).ok,true);
    console.log(JSON.stringify({phase:'successful-independent-purchase',backendCalls:calls,priceNanos:'250',usage:first.usage,ledgerAudit:true,genuineModelInference:false,realFunds:false}));
    mode='failure';
    await sellerClient.request('POST','/v1/seller/offers/process-fixture/capacity',{ready:true});
    const failedPath=join(directory,'failure.purchase.json');await buyerClient.prepare(failedPath,input,{maxPriceNanos:'250',allowedSellers:['process-fixture'],model:'fixture-model',usageRequirement:'backend_reported_required'});
    await assert.rejects(buyerClient.execute(failedPath),(error:any)=>error instanceof HttpError&&error.code==='provider_failure');
    const failed=await buyerClient.recover(failedPath);assert.equal(failed.status,'failed');assert.equal(calls,2);
    const refunds=(await db.query('SELECT reference,from_wallet,to_wallet,amount::text FROM transfers WHERE reference LIKE $1',[`decision:${failed.id}:%`])).rows;
    assert.equal(refunds.length,2);
    assert.deepEqual(refunds.find((r:any)=>r.reference===`decision:${failed.id}:reserve`),{reference:`decision:${failed.id}:reserve`,from_wallet:`available:${buyer.id}`,to_wallet:`reserved:${buyer.id}`,amount:'250'});
    assert.deepEqual(refunds.find((r:any)=>r.reference===`decision:${failed.id}:refund`),{reference:`decision:${failed.id}:refund`,from_wallet:`reserved:${buyer.id}`,to_wallet:`available:${buyer.id}`,amount:'250'});
    assert.equal(await balance(`available:${buyer.id}`),'99750');
    assert.equal(await balance(`reserved:${buyer.id}`),'0');
    assert.equal(await balance(`available:${owner.id}`),'225');
    assert.equal(await balance('platform'),'25');
    assert.equal((await fetch(`${sellerOrigin}/health/ready`)).status,503);
    assert.equal((await auditLedger(db) as any).ok,true);
    console.log(JSON.stringify({phase:'backend-error-quarantine',backendCalls:calls,failedStatus:failed.status,refunds:1,readiness:503,ledgerAudit:true}));
    child.kill('SIGTERM');
    assert.equal(await exited(child),true,'Seller child did not exit after SIGTERM');
    const ownerGate=join(dispatchDirectory,'.adapter-owner');
    const ownerRemains=await exists(ownerGate);
    // Node child.kill() on Windows forcefully terminates. The owner gate must fail closed.
    assert.equal(ownerRemains,process.platform==='win32');
    let restartOutput='';
    restart=spawn(process.execPath,[sellerExecutable],{cwd:outsideDirectory,env:{...process.env,ZOKO_SELLER_CONFIG:join(directory,'seller.json'),ZOKO_SELLER_ENDPOINT_KEY:endpointKey,ZOKO_SELLER_PORT:String(sellerPort)},windowsHide:true,stdio:['ignore','pipe','pipe']});
    restart.stdout?.on('data',chunk=>{restartOutput+=String(chunk).slice(0,1000);});
    restart.stderr?.on('data',chunk=>{restartOutput+=String(chunk).slice(0,1000);});
    assert.equal(await exited(restart),true,'Unreconciled seller restarted unexpectedly');
    assert.match(restartOutput,process.platform==='win32'?/backend_owner_unresolved/:/backend_dispatch_unresolved/);
    assert.equal(await exists(ownerGate),process.platform==='win32');
    console.log(JSON.stringify({phase:'forced-stop',platform:process.platform,ownerGateRetained:ownerRemains,restartRejected:true}));
    // Separate adapter-close contract: no ambiguous dispatch, close releases ownership.
    const cleanConfig={...sellerConfig,dispatchDirectory:join(directory,'clean-dispatches')};
    const clean=await createOllamaSeller(cleanConfig);
    const cleanGate=join(cleanConfig.dispatchDirectory,'.adapter-owner');assert.equal(await exists(cleanGate),true);
    await clean.preflight();await clean.close();assert.equal(await exists(cleanGate),false);
    const cleanRestart=await createOllamaSeller(cleanConfig);await cleanRestart.preflight();await cleanRestart.close();
    assert.equal(await exists(cleanGate),false);
    console.log(JSON.stringify({phase:'adapter-graceful-close',ownerAcquired:true,ownerReleased:true,cleanRestartPassed:true}));
  }finally{
    let childrenStopped=true;
    if(restart&&!await exited(restart,0)){restart.kill();childrenStopped=await exited(restart)&&childrenStopped;}
    if(child&&!await exited(child,0)){child.kill();childrenStopped=await exited(child)&&childrenStopped;}
    console.log(JSON.stringify({phase:'fixture-preserved',directory,outsideDirectory,postgresSchema:schema,childrenStopped}));
    assert.equal(childrenStopped,true,'Owned child exit unverified; fixture preserved for investigation');
    if(app)await app.close();backend.closeAllConnections();await new Promise<void>(yes=>backend.close(()=>yes()));
    if(db)await db.end();if(control)await control.end();
    // Retain the owned synthetic directory and stopped disposable DB for dispatch reconciliation.
  }
});
