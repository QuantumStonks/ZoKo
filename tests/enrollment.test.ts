import assert from 'node:assert/strict';
import {mkdtemp,readFile,rm,symlink,writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import test from 'node:test';
import {prepareEnrollment,readAgentCredentials} from '../src/enrollment.js';

test('enrollment durably preserves the same secret and exact policy across recovery',async()=>{
 const dir=await mkdtemp(join(tmpdir(),'zoko-enroll-'));
 try{
  const path=join(dir,'account.json'), input={name:'Independent seller',dailyLimitNanos:'0',maxPriceNanos:'0'};
  const original=await prepareEnrollment(path,'https://market.example',input);
  assert.match(original.apiKey,/^zoko_[A-Za-z0-9_-]{43}$/);
  assert.deepEqual(await prepareEnrollment(path,'https://market.example/',input),original);
  assert.deepEqual(await readAgentCredentials(path),original);
  await assert.rejects(prepareEnrollment(path,'https://other.example',input),/original/);
  await assert.rejects(prepareEnrollment(path,'https://market.example',{...input,maxPriceNanos:'1'}),/original/);
  assert.equal(JSON.parse(await readFile(path,'utf8')).apiKey,original.apiKey);
 }finally{await rm(dir,{recursive:true,force:true});}
});
test('credential loading refuses malformed data without echoing it',async()=>{
 const dir=await mkdtemp(join(tmpdir(),'zoko-enroll-'));
 try{const path=join(dir,'account.json');await writeFile(path,'SECRET_DO_NOT_ECHO',{mode:0o600});await assert.rejects(readAgentCredentials(path),e=>e instanceof Error&&!e.message.includes('SECRET_DO_NOT_ECHO'));
 if(process.platform!=='win32'){const link=join(dir,'link');await symlink(path,link);await assert.rejects(readAgentCredentials(link),/regular file/);}}
 finally{await rm(dir,{recursive:true,force:true});}
});
