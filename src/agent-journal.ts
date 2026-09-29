import { randomUUID } from 'node:crypto';
import { open, lstat } from 'node:fs/promises';
import { z } from 'zod';
import { ZokoClient } from './client.js';
import { DecisionInputSchema } from './protocol.js';
import { validateAgentResult } from './provider.js';
import { digest } from './security.js';

const Header=z.object({version:z.literal(1),baseUrl:z.string(),accountId:z.uuid(),sellerId:z.string().regex(/^[a-z0-9][a-z0-9_-]{0,63}$/),claimKey:z.uuid()}).strict();
const Job=z.object({id:z.uuid(),sellerId:z.string(),model:z.string(),input:DecisionInputSchema,claimToken:z.uuid(),status:z.enum(['running','succeeded','failed','indeterminate']),deadline:z.iso.datetime({offset:true})}).strict();
async function read(path:string):Promise<unknown> {
  const file=await open(path,'r');
  try {
    const stat=await file.stat();
    if(!stat.isFile()||stat.size>65536)throw new Error('Invalid or oversized seller journal; preserve it for recovery.');
    const bytes=Buffer.alloc(65537);let length=0;
    while(length<bytes.length){const {bytesRead}=await file.read(bytes,length,bytes.length-length,null);if(!bytesRead)break;length+=bytesRead;}
    if(length>65536)throw new Error('Seller journal exceeds its size limit.');
    return JSON.parse(bytes.subarray(0,length).toString('utf8'));
  }finally{await file.close();}
}
async function exists(path:string):Promise<boolean>{
  try{const stat=await lstat(path);if(!stat.isFile()||stat.isSymbolicLink())throw new Error('Seller journal must be a regular file.');return true;}
  catch(error){if((error as NodeJS.ErrnoException).code==='ENOENT')return false;throw error;}
}
async function persist(path:string,value:unknown):Promise<void>{
  const serialized=JSON.stringify(value);
  if(Buffer.byteLength(serialized)>65536)throw new Error('Seller journal exceeds its size limit; nothing dispatched.');
  let file;
  try{file=await open(path,'wx',0o600);}catch(error){
    if((error as NodeJS.ErrnoException).code!=='EEXIST')throw error;
    if(!await exists(path)||digest(await read(path))!==digest(value))throw new Error('Seller journal already contains different or incomplete data; preserve the original.');
    return;
  }
  try{await file.writeFile(serialized);await file.sync();}finally{await file.close();}
}
async function identity(client:ZokoClient):Promise<string>{
  const me=await client.me<{account:{id:string}}>();return z.uuid().parse(me?.account?.id);
}
async function bound(client:ZokoClient,path:string,sellerId?:string){
  const accountId=await identity(client);
  if(!await exists(path)){
    if(!sellerId)throw new Error('Original seller claim journal is required.');
    await persist(path,Header.parse({version:1,baseUrl:client.baseUrl,accountId,sellerId,claimKey:randomUUID()}));
  }
  const header=Header.parse(await read(path));
  if(header.baseUrl!==client.baseUrl||header.accountId!==accountId||(sellerId&&header.sellerId!==sellerId))throw new Error('Seller journal is bound to another server, account or offer. Restore the original configuration.');
  return header;
}

/** Claim key is durable before dispatch; a lost response is recovered using it. */
export async function claimWithJournal(client:ZokoClient,path:string,sellerId:string){
  const header=await bound(client,path,sellerId);
  let job:z.infer<typeof Job>;
  if(await exists(`${path}.claim.json`))job=Job.parse(await read(`${path}.claim.json`));
  else{
    const response=await client.request<{job:unknown}>('POST','/v1/seller/jobs/claim',{sellerId},{idempotencyKey:header.claimKey});
    if(response.job===null)return {job:null,journal:path};
    job=Job.parse(response.job);
    if(job.sellerId!==sellerId)throw new Error('Claimed job belongs to another offer.');
    await persist(`${path}.claim.json`,job);
  }
  // Claim tokens stay in protected journals, away from routine stdout/logging.
  const {claimToken,...visible}=job;
  return {job:visible,journal:path};
}

/** Freeze the exact validated result before dispatch; recovery never regenerates it. */
export async function completeWithJournal(client:ZokoClient,path:string,raw?:unknown){
  await bound(client,path);
  if(!await exists(`${path}.claim.json`))throw new Error('Recover the original claim before submitting its result.');
  const job=Job.parse(await read(`${path}.claim.json`));
  const resultPath=`${path}.result.json`;
  if(raw!==undefined)await persist(resultPath,validateAgentResult(raw,job.input,job.model));
  if(!await exists(resultPath))throw new Error('A typed result is required for the first submission.');
  const result=validateAgentResult(await read(resultPath),job.input,job.model);
  return client.request('POST',`/v1/seller/jobs/${job.id}/complete`,{claimToken:job.claimToken,result});
}
