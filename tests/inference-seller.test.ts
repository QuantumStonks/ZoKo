import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtemp, rm, readdir, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createOllamaSeller } from '../src/seller/ollama.js';
import { OfferContractSchema, cancellationSemantics } from '../src/offer-contract.js';
import { ProviderError } from '../src/provider.js';
import { openApiDocument } from '../src/openapi.js';

// All backend payloads here are deterministic protocol fixtures. No model is invoked and no payment occurs.
const evidence={genuine_model_inference:false,payment:'simulated/payment-not-applicable'};
const digest='a'.repeat(64);
const contract={version:'zoko.inference-offer/1',backend:'ollama',modelIdentity:`ollama:fixture:1@sha256:${digest}`,
  authorization:{sellerAuthorized:true,resalePermitted:true,basis:'owned_weights_license',evidenceReference:'fixture-not-permission-for-live-use'},
  questionTypes:['noul','choice','score'],maxInputBytes:32768,maxOutputBytes:262144,maxOutputTokens:256,maxConcurrency:1,deadlineMs:100,usageRequirement:'backend_reported_required'};
const input={state:'fixture',questions:{urgent:{type:'noul' as const}}};
const output=()=>({model:'fixture:1',done:true,done_reason:'stop',message:{content:JSON.stringify({answers:{urgent:{type:'noul',noul:0.9}}})},prompt_eval_count:17,eval_count:9});
async function fixture(mutate?:(value:any)=>any,optional=false){
  const directory=await mkdtemp(join(tmpdir(),'zoko-seller-'));
  let calls=0;
  const config={backendUrl:'http://127.0.0.1:11434',backendModel:'fixture:1',modelDigest:digest,marketplaceModel:'fixture-model',contract:{...contract,...(optional?{usageRequirement:'backend_reported_optional'}:{})},dispatchDirectory:directory};
  const transport:typeof fetch=async(url,init)=>{
    if(String(url).endsWith('/api/tags'))return Response.json({models:[{name:'fixture:1',digest}]});
    calls++;const body=JSON.parse(String(init?.body));assert.equal(body.stream,false);assert.equal(body.model,'fixture:1');assert.equal(body.options.num_predict,256);
    const value=output();return Response.json(mutate?mutate(value):value);
  };
  const seller=await createOllamaSeller(config,transport);
  return {seller,config,transport,directory,get calls(){return calls;},cleanup:async()=>{await seller.close();await rm(directory,{recursive:true,force:true});}};
}
test('Ollama adapter validates pinned identity, exact typed output, reported usage and durable completion',async()=>{
  const f=await fixture();try{
    assert.equal((await f.seller.preflight()).genuineModelInferenceVerified,false);
    const result=await f.seller.evaluate(input,'fixture-model');assert.deepEqual(result.usage,{input_tokens:17,output_tokens:9});
    assert.equal(f.calls,1);assert.equal(f.seller.capacity().available,true);
    const files=(await readdir(f.directory)).filter(name=>name.endsWith('.json'));assert.equal(files.length,2);
    assert.ok(!(await readFile(join(f.directory,files[0]),'utf8')).includes('urgent'));
    await f.seller.close();const restarted=await createOllamaSeller(f.config,f.transport);assert.equal(restarted.capacity().unresolved,0);await restarted.close();
  }finally{await f.cleanup();}
});
test('permission and exact model/schema requirements are enforced before dispatch',async()=>{
  const f=await fixture();try{
    await assert.rejects(createOllamaSeller({...f.config,contract:{...contract,authorization:{...contract.authorization,resalePermitted:false}}}));
    await assert.rejects(f.seller.evaluate(input,'other-model'),(e:any)=>e.code==='backend_model_mismatch');
    await assert.rejects(f.seller.evaluate({state:'fixture',questions:{x:{type:'choice',criteria:{}}}},'fixture-model'));
    assert.equal(f.calls,0);
    await assert.rejects(createOllamaSeller({...f.config,backendUrl:'https://cloud.example'}));
  }finally{await f.cleanup();}
});
test('missing usage is null only when the offer explicitly permits it, never estimated or zero-filled',async()=>{
  for(const optional of [false,true]){
    const f=await fixture(v=>{delete v.prompt_eval_count;delete v.eval_count;return v;},optional);
    try{if(optional)assert.equal((await f.seller.evaluate(input,'fixture-model')).usage,null);else await assert.rejects(f.seller.evaluate(input,'fixture-model'),ProviderError);
    }finally{await f.cleanup();}
  }
});
test('optional usage preserves each reported count; required usage rejects a missing counter',async()=>{
  for(const optional of [false,true]){
    const f=await fixture(v=>{delete v.eval_count;return v;},optional);
    try{if(optional)assert.deepEqual((await f.seller.evaluate(input,'fixture-model')).usage,{input_tokens:17,output_tokens:null});else await assert.rejects(f.seller.evaluate(input,'fixture-model'),ProviderError);}
    finally{await f.cleanup();}
  }
});
test('directory ownership excludes another process and concurrent dispatch obeys the declared limit',async()=>{
  const f=await fixture();try{
    await assert.rejects(createOllamaSeller(f.config,f.transport),(e:any)=>e.code==='backend_owner_unresolved');
    await f.seller.close();
    let release!:()=>void,calls=0;
    const gate=new Promise<void>(r=>{release=r;});
    const transport:typeof fetch=async(url)=>{
      if(String(url).endsWith('/api/tags'))return Response.json({models:[{name:'fixture:1',digest}]});
      calls++;await gate;return Response.json(output());
    };
    const seller=await createOllamaSeller({...f.config,contract:{...contract,maxConcurrency:2,deadlineMs:5000}},transport);
    const first=seller.evaluate(input,'fixture-model'),second=seller.evaluate(input,'fixture-model');
    const deadline=Date.now()+2000;while(calls<2&&Date.now()<deadline)await new Promise(r=>setTimeout(r,5));
    assert.equal(calls,2);assert.equal(seller.capacity().active,2);assert.equal(seller.capacity().unresolved,0);
    await assert.rejects(seller.evaluate(input,'fixture-model'),(e:any)=>e.code==='backend_capacity_unavailable');
    release();await Promise.all([first,second]);assert.equal(seller.capacity().available,true);await seller.close();
  }finally{await f.cleanup();}
});
test('refusal, truncation, malformed JSON, wrong model, invalid schema and invented usage are rejected',async()=>{
  for(const mutate of [
    (v:any)=>({...v,message:{refusal:'fixture refusal',content:''}}),
    (v:any)=>({...v,done_reason:'length'}),
    (v:any)=>({...v,message:{content:'{bad'}}),
    (v:any)=>({...v,model:'wrong-model'}),
    (v:any)=>({...v,message:{content:'{"answers":{"urgent":{"type":"noul","noul":2}}}'}}),
    (v:any)=>({...v,prompt_eval_count:-1}),
    (v:any)=>({...v,eval_count:257}),
  ]){const f=await fixture(mutate);try{await assert.rejects(f.seller.evaluate(input,'fixture-model'),ProviderError);assert.equal(f.calls,1);}finally{await f.cleanup();}}
});
test('ambiguous dispatch quarantines capacity and survives restart; timeout never claims inference stopped',async()=>{
  const directory=await mkdtemp(join(tmpdir(),'zoko-uncertain-'));
  const f=await fixture();try{
    let calls=0;const transport:typeof fetch=async(url)=>{if(String(url).endsWith('/api/tags'))return Response.json({models:[{name:'fixture:1',digest}]});calls++;return new Promise(()=>undefined);};
    const config={...f.config,dispatchDirectory:directory};const seller=await createOllamaSeller(config,transport);
    await assert.rejects(seller.evaluate(input,'fixture-model'),(e:any)=>e.code==='backend_timeout');
    assert.equal(seller.capacity().available,false);assert.equal(calls,1);
    await seller.close();const restarted=await createOllamaSeller(config,transport);await assert.rejects(restarted.preflight(),(e:any)=>e.code==='backend_dispatch_unresolved');
    await assert.rejects(restarted.evaluate(input,'fixture-model'),(e:any)=>e.code==='backend_capacity_unavailable');assert.equal(calls,1);await restarted.close();
  }finally{await f.cleanup();await rm(directory,{recursive:true,force:true});}
});
test('contract and OpenAPI describe model-specific inference and unsupported cancellation truthfully',()=>{
  assert.equal(evidence.genuine_model_inference,false);assert.equal(cancellationSemantics.supported,false);assert.equal(cancellationSemantics.httpAbortStopsInference,false);
  assert.equal(OfferContractSchema.safeParse(contract).success,true);
  assert.equal(openApiDocument.openapi,'3.1.0');assert.ok(openApiDocument.paths['/v1/decisions'].post.responses['202']);
});
