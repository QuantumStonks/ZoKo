import assert from 'node:assert/strict';
import { test } from 'node:test';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, rm, copyFile, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { createRequire } from 'node:module';
import { ZokoHttpClient, validateTypedOutput } from '../clients/typescript/zoko.js';
import { openApiDocument } from '../src/openapi.js';
import { digest } from '../src/security.js';

const input={state:'genuine_model_inference=false; simulated/payment-not-applicable',questions:{
  urgent:{type:'noul' as const},pick:{type:'choice' as const,criteria:{a:'first',b:'second'}},
  grade:{type:'score' as const,criteria:['low',{level:'high'}]},
}};
const result={model:'fixture-pinned',answers:{urgent:{type:'noul',noul:0.8},pick:{type:'choice',choice:'b',probabilities:{a:0.25,b:0.75},confidence:0.75},grade:{type:'score',score:0.6,legend:{0:'low',1:{level:'high'}},probabilities:{0:0.4,1:0.6},confidence:0.6}},usage:{input_tokens:10,output_tokens:9}};
const mutations=[
  (v:any)=>{v.model='different-model';},(v:any)=>{delete v.answers.urgent;},
  (v:any)=>{v.answers.urgent.noul=2;},(v:any)=>{v.answers.pick.choice='a';},
  (v:any)=>{v.answers.pick.probabilities.b=0.8;},(v:any)=>{v.answers.grade.score=0.7;},
  (v:any)=>{v.answers.grade.legend[1]={level:'wrong'};},(v:any)=>{v.usage.input_tokens=-1;},
  (v:any)=>{v.usage.output_tokens=1.5;},(v:any)=>{v.usage.output_tokens=true;},
  (v:any)=>{v.usage.output_tokens=9007199254740992;},(v:any)=>{v.usage=null;},
];
test('independent TypeScript validator rejects model/schema/probability/legend and usage mismatches',()=>{
  validateTypedOutput(result,input,'fixture-pinned',true);
  for(const mutate of mutations){const bad=structuredClone(result);mutate(bad);assert.throws(()=>validateTypedOutput(bad,input,'fixture-pinned',true));}
  validateTypedOutput({...result,usage:null},input,'fixture-pinned',false);
  const partial={...result,usage:{input_tokens:10,output_tokens:null}};
  validateTypedOutput(partial,input,'fixture-pinned',false);assert.throws(()=>validateTypedOutput(partial,input,'fixture-pinned',true));
});
test('legacy Jev aliases recover the same synthetic purchase; contracted models remain exact',async()=>{
  const versioned={...result,model:'jev-1.2.3'};
  for(const alias of ['jev-latest','jev-preview']){
    validateTypedOutput(versioned,input,alias,true);
    assert.throws(()=>validateTypedOutput(versioned,input,alias,true,true),/Model or answer schema mismatch/);
  }
  for(const model of ['jev-1.2','jev-1.2.3-extra','other-model'])
    assert.throws(()=>validateTypedOutput({...versioned,model},input,'jev-latest',true),/Model or answer schema mismatch/);
  assert.throws(()=>validateTypedOutput({...versioned,model:'other-model'},input,'jev-latest',true,true),/Model or answer schema mismatch/);
  const directory=await mkdtemp(join(tmpdir(),'zoko-legacy-alias-'));
  try{
    for(const alias of ['jev-latest','jev-preview']){
      const path=join(directory,`${alias}.journal.json`);
      const quote={id:'00000000-0000-4000-8000-000000000001',sellerId:'legacy-fixture',model:alias,priceNanos:'1',currency:'nanoXEC',requestHash:digest(input),schemaHash:digest(input.questions),deliveryMode:'https',inferenceContract:null};
      const receipt={id:'00000000-0000-4000-8000-000000000002',status:'succeeded',sellerId:quote.sellerId,priceNanos:quote.priceNanos,requestHash:quote.requestHash,schemaHash:quote.schemaHash,result:versioned};
      const client=new ZokoHttpClient('http://127.0.0.1','fixture-key');
      const dispatches:Array<{body:unknown;key:string|undefined}>=[];let quotes=0;
      client.request=async(method,route,body,key)=>{
        if(method==='GET'&&route==='/v1/me')return {account:{id:'fixture-account'}};
        if(method==='POST'&&route==='/v1/quotes'){quotes++;return quote;}
        if(method==='POST'&&route==='/v1/decisions'){dispatches.push({body,key});return receipt;}
        throw new Error('Unexpected synthetic route');
      };
      const journal=await client.prepare(path,input,{maxPriceNanos:'1'});
      assert.deepEqual(await client.execute(path),receipt);
      assert.deepEqual(await client.recover(path),receipt);
      assert.equal(quotes,1);
      assert.deepEqual(dispatches,[{body:{quoteId:quote.id,...input},key:journal.idempotencyKey},{body:{quoteId:quote.id,...input},key:journal.idempotencyKey}]);
      assert.deepEqual(JSON.parse(await readFile(`${path}.receipt.json`,'utf8')),receipt);
      const contractedPath=join(directory,`${alias}.contracted.json`);
      await writeFile(contractedPath,JSON.stringify({...journal,quote:{...quote,inferenceContract:{usageRequirement:'backend_reported_required'}}}));
      await assert.rejects(client.execute(contractedPath),/Model or answer schema mismatch/);
      await assert.rejects(readFile(`${contractedPath}.receipt.json`,'utf8'),{code:'ENOENT'});
    }
  }finally{await rm(directory,{recursive:true,force:true});}
});
test('independent Python validator applies the same typed contract outside the repository',async()=>{
  const directory=await mkdtemp(join(tmpdir(),'zoko-python-contract-'));
  try{
    await copyFile(resolve('clients/python/zoko.py'),join(directory,'zoko.py'));
    const invalid=mutations.map(mutate=>{const value=structuredClone(result);mutate(value);return value;});
    await writeFile(join(directory,'fixtures.json'),JSON.stringify({input,result,invalid}));
    await writeFile(join(directory,'verify.py'),`import json\nfrom zoko import validate_typed_output\nf=json.load(open('fixtures.json',encoding='utf-8'))\nvalidate_typed_output(f['result'],f['input'],'fixture-pinned',True)\nfor bad in f['invalid']:\n try: validate_typed_output(bad,f['input'],'fixture-pinned',True)\n except ValueError: pass\n else: raise AssertionError('Invalid output accepted')\nf['result']['usage']={'input_tokens':10,'output_tokens':None}\nvalidate_typed_output(f['result'],f['input'],'fixture-pinned',False)\nprint('independent Python typed contract passed; genuine_model_inference=false; simulated/payment-not-applicable')\n`);
    const checked=await promisify(execFile)('python',[join(directory,'verify.py')],{cwd:directory,timeout:15000});assert.match(checked.stdout,/passed/);
  }finally{await rm(directory,{recursive:true,force:true});}
});
test('independent Python client recovers both legacy aliases with the original synthetic identity',async()=>{
  const checked=await promisify(execFile)('python',['-m','unittest','test_zoko_reliability.ReliabilityTests.test_legacy_jev_aliases_recover_same_synthetic_purchase_and_contracts_stay_exact'],{cwd:resolve('clients/python'),env:{...process.env,PYTHONDONTWRITEBYTECODE:'1'},timeout:15000});
  assert.match(checked.stderr,/Ran 1 test/);assert.match(checked.stderr,/OK/);
});
test('OpenAPI component references resolve and JSON schemas compile with realistic protocol fixtures',()=>{
  const require=createRequire(import.meta.url);
  const Ajv=require('ajv/dist/2020.js').default;
  const addFormats=require('ajv-formats').default;
  const ajv=new Ajv({strict:false,allErrors:true});addFormats(ajv);
  const document=JSON.parse(JSON.stringify(openApiDocument));
  ajv.addSchema({$id:'https://fixture.invalid/zoko-openapi',...document});
  for(const name of Object.keys(document.components.schemas))assert.equal(typeof ajv.compile({$ref:`https://fixture.invalid/zoko-openapi#/components/schemas/${name}`}), 'function');
  const resultSchema=ajv.compile({$ref:'https://fixture.invalid/zoko-openapi#/components/schemas/Result'});
  assert.equal(resultSchema(result),true,JSON.stringify(resultSchema.errors));
  const inputSchema=ajv.compile({$ref:'https://fixture.invalid/zoko-openapi#/components/schemas/DecisionInput'});
  assert.equal(inputSchema(input),true,JSON.stringify(inputSchema.errors));
});
