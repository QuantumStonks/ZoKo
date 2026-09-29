import assert from 'node:assert/strict';
import test from 'node:test';
import { randomUUID } from 'node:crypto';
import { mkdtemp,readFile,rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { claimWithJournal,completeWithJournal } from '../src/agent-journal.js';
import { ZokoClient } from '../src/client.js';

test('seller journals bind identity, recover lost claims and freeze results before uncertain dispatch',async()=>{
  const directory=await mkdtemp(join(tmpdir(),'zoko-agent-journal-')),path=join(directory,'job.json');
  const owner=randomUUID(),job={id:randomUUID(),sellerId:'owned-agent',model:'test-session',input:{state:'Fixture',questions:{a:{type:'noul'}}},claimToken:randomUUID(),status:'running',deadline:new Date(Date.now()+60000).toISOString()};
  const result={model:job.model,answers:{a:{type:'noul',noul:0.9}},usage:null};
  let claimKey:string|undefined,claimCalls=0,completeCalls=0,accountId=owner;
  const client=new ZokoClient({baseUrl:'https://market.invalid',apiKey:'test-account',fetch:async(url,options)=>{
    const pathname=new URL(String(url)).pathname;
    if(pathname==='/v1/me')return Response.json({account:{id:accountId}});
    if(pathname==='/v1/seller/jobs/claim'){
      claimCalls++;const journal=JSON.parse(await readFile(path,'utf8'));
      assert.equal(journal.accountId,owner);
      const key=new Headers(options?.headers).get('idempotency-key')!;assert.equal(journal.claimKey,key);
      if(claimKey)assert.equal(key,claimKey);claimKey=key;
      if(claimCalls===1)throw new Error('Controlled lost claim response');return Response.json({job});
    }
    completeCalls++;assert.deepEqual(JSON.parse(await readFile(`${path}.result.json`,'utf8')),result);
    assert.deepEqual(JSON.parse(String(options?.body)),{claimToken:job.claimToken,result});
    if(completeCalls===1)throw new Error('Controlled lost completion response');return Response.json({id:job.id,status:'succeeded'});
  }});
  try{
    await assert.rejects(claimWithJournal(client,path,job.sellerId),/lost claim/);
    const recovered=await claimWithJournal(client,path,job.sellerId);assert.ok(recovered.job);assert.equal('claimToken' in recovered.job,false);
    assert.equal(claimCalls,2);await claimWithJournal(client,path,job.sellerId);assert.equal(claimCalls,2);
    await assert.rejects(completeWithJournal(client,path,result),/lost completion/);
    const receipt=await completeWithJournal(client,path);assert.deepEqual(receipt,{id:job.id,status:'succeeded'});assert.equal(completeCalls,2);
    await assert.rejects(completeWithJournal(client,path,{...result,answers:{a:{type:'noul',noul:0.2}}}),/different or incomplete/);assert.equal(completeCalls,2);
    accountId=randomUUID();await assert.rejects(completeWithJournal(client,path),/bound to another/);assert.equal(completeCalls,2);
  }finally{await rm(directory,{recursive:true,force:true});}
});
