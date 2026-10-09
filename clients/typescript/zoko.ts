/** Independent Node 24 HTTP client. No marketplace SDK/server imports or third-party dependencies. */
import { createHash, randomUUID } from 'node:crypto';
import { open, readFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';

export interface DecisionInput { state: string | object; questions: Record<string, {type:'noul'|'choice'|'score';instructions?:unknown;criteria?:any}> }
export interface Policy { maxPriceNanos:string;allowedSellers?:string[];model?:string;usageRequirement?:'backend_reported_required';maxLatencyMs?:number;minConfidence?:number }
export interface PurchaseJournal {version:1;origin:string;accountId:string;idempotencyKey:string;input:DecisionInput;quote:Record<string,any>;policy:Policy}
export class HttpError extends Error {constructor(readonly status:number,readonly code:string){super(`ZoKo HTTP ${status}: ${code}`);}}
const canonical=(v:any):string=>Array.isArray(v)?`[${v.map(canonical).join(',')}]`:v!==null&&typeof v==='object'?`{${Object.keys(v).sort().map(k=>`${JSON.stringify(k)}:${canonical(v[k])}`).join(',')}}`:JSON.stringify(v);
const hash=(v:unknown)=>createHash('sha256').update(canonical(v)).digest('hex');
const money=(v:unknown):bigint=>{if(typeof v!=='string'||!/^(0|[1-9][0-9]{0,29})$/.test(v))throw new Error('Invalid integer nanoXEC');return BigInt(v);};
const sameKeys=(v:any,keys:string[])=>v!==null&&typeof v==='object'&&!Array.isArray(v)&&Object.keys(v).length===keys.length&&keys.every(k=>Object.hasOwn(v,k));
const probability=(v:any)=>typeof v==='number'&&Number.isFinite(v)&&v>=0&&v<=1;
export function validateTypedOutput(result:any,input:DecisionInput,model:string,usageRequired:boolean):void{
  if(!sameKeys(result,['model','answers','usage'])||result.model!==model||!sameKeys(result.answers,Object.keys(input.questions)))throw new Error('Model or answer schema mismatch');
  for(const [key,q] of Object.entries(input.questions)){
    const a=result.answers[key];
    if(!a||a.type!==q.type)throw new Error('Answer type mismatch');
    if(q.type==='noul'){if(!sameKeys(a,['type','noul'])||!probability(a.noul))throw new Error('Invalid Noul');continue;}
    const keys=q.type==='choice'?Object.keys(q.criteria):q.criteria.map((_:unknown,i:number)=>String(i));
    if(!sameKeys(a,q.type==='choice'?['type','choice','probabilities','confidence']:['type','score','legend','probabilities','confidence'])||!sameKeys(a.probabilities,keys)||!probability(a.confidence))throw new Error('Invalid answer');
    const values=Object.values(a.probabilities) as number[];
    if(!values.every(probability)||Math.abs(values.reduce((sum,v)=>sum+v,0)-1)>0.0001)throw new Error('Invalid probabilities');
    if(q.type==='choice'){
      if(!Object.hasOwn(a.probabilities,a.choice)||a.probabilities[a.choice]+Number.EPSILON<Math.max(...values))throw new Error('Invalid Choice');
    }else{
      const expectation=keys.reduce((sum:number,k:string)=>sum+Number(k)*a.probabilities[k],0);
      if(!sameKeys(a.legend,keys)||keys.some((k:string)=>canonical(a.legend[k])!==canonical(q.criteria[Number(k)]))||!Number.isFinite(a.score)||a.score<0||a.score>keys.length-1||Math.abs(a.score-expectation)>0.0001*Math.max(1,keys.length-1))throw new Error('Invalid Score');
    }
  }
  if(result.usage===null){if(usageRequired)throw new Error('Required backend usage missing');}
  else if(!sameKeys(result.usage,['input_tokens','output_tokens'])||!Object.values(result.usage).every(v=>v===null&&!usageRequired||typeof v==='number'&&Number.isSafeInteger(v)&&v>=0)||Object.values(result.usage).every(v=>v===null))throw new Error('Invalid backend usage');
}
async function record(path:string,value:unknown):Promise<void>{
  const fd=await open(path,'wx',0o600);try{await fd.writeFile(JSON.stringify(value));await fd.sync();}finally{await fd.close();}
  if(process.platform!=='win32'){const dir=await open(dirname(resolve(path)),'r');try{await dir.sync();}finally{await dir.close();}}
}
export class ZokoHttpClient {
  readonly origin:string;
  constructor(origin:string,private readonly key:string,private readonly timeoutMs=70000){
    const u=new URL(origin);if(u.username||u.password||u.search||u.hash||u.pathname!=='/'||!(u.protocol==='https:'||u.protocol==='http:'&&['127.0.0.1','[::1]'].includes(u.hostname)))throw new Error('Use HTTPS marketplace origin or numeric loopback');
    if(!/^[\x21-\x7e]{1,512}$/.test(key)||!Number.isSafeInteger(timeoutMs)||timeoutMs<1||timeoutMs>300000)throw new Error('Invalid HTTP configuration');
    this.origin=u.origin;
  }
  async request(method:string,path:string,body?:unknown,idempotencyKey?:string,publicRoute=false):Promise<any>{
    if(!/^\/(?:v1\/|\.well-known\/)[A-Za-z0-9_./-]+$/.test(path))throw new Error('Invalid API path');
    const signal=AbortSignal.timeout(this.timeoutMs);
    const response=await fetch(this.origin+path,{method,redirect:'error',signal,headers:{accept:'application/json',...(publicRoute?{}:{authorization:`Bearer ${this.key}`}),...(body?{'content-type':'application/json'}:{}),...(idempotencyKey?{'idempotency-key':idempotencyKey}:{})},...(body?{body:JSON.stringify(body)}:{})});
    if(!response.body || response.headers.get('content-type')?.split(';')[0].trim()!=='application/json')throw new Error('Invalid response content type');
    const reader=response.body.getReader();let bytes=0,text='';const decoder=new TextDecoder('utf-8',{fatal:true});
    try{while(true){const chunk=await reader.read();if(chunk.done)break;bytes+=chunk.value.byteLength;if(bytes>1048576)throw new Error('Response byte limit exceeded');text+=decoder.decode(chunk.value,{stream:true});}text+=decoder.decode();}
    finally{await reader.cancel().catch(()=>undefined);reader.releaseLock();}
    const decoded=JSON.parse(text);if(!response.ok)throw new HttpError(response.status,decoded?.error?.code??'request_failed');return decoded;
  }
  discover(){return this.request('GET','/.well-known/zoko.json',undefined,undefined,true);}
  capabilities(){return this.request('GET','/v1/capabilities',undefined,undefined,true);}
  catalog(){return this.request('GET','/v1/catalog',undefined,undefined,true);}
  async prepare(path:string,input:DecisionInput,policy:Policy):Promise<PurchaseJournal>{
    policy=structuredClone(policy);
    money(policy.maxPriceNanos);
    const snapshot=JSON.parse(JSON.stringify(input));
    if(Buffer.byteLength(JSON.stringify(snapshot))>32768)throw new Error('Input byte limit exceeded');
    const account=await this.request('GET','/v1/me');
    const quote=await this.request('POST','/v1/quotes',{...snapshot,policy});
    this.validateQuote(quote,snapshot,policy);
    const journal:PurchaseJournal={version:1,origin:this.origin,accountId:account.account.id,idempotencyKey:randomUUID(),input:snapshot,quote,policy:structuredClone(policy)};
    await record(path,journal);return journal;
  }
  private validateQuote(q:any,input:DecisionInput,policy:Policy){
    if(money(q.priceNanos)>money(policy.maxPriceNanos)||q.currency!=='nanoXEC'||q.requestHash!==hash(input)||q.schemaHash!==hash(input.questions)||!q.id||!q.model||!q.sellerId)throw new Error('Quote violates bounded request');
    if(policy.model&&q.model!==policy.model||policy.allowedSellers&&!policy.allowedSellers.includes(q.sellerId)||policy.usageRequirement&&q.inferenceContract?.usageRequirement!==policy.usageRequirement)throw new Error('Quote violates selected offer');
  }
  async execute(path:string):Promise<any>{
    const journal=JSON.parse(await readFile(path,'utf8')) as PurchaseJournal;
    if(journal.version!==1||journal.origin!==this.origin)throw new Error('Journal marketplace mismatch');
    this.validateQuote(journal.quote,journal.input,journal.policy);
    const me=await this.request('GET','/v1/me');if(me.account.id!==journal.accountId)throw new Error('Journal account mismatch');
    const identity={journalHash:hash(journal),idempotencyKey:journal.idempotencyKey};
    try{await record(`${path}.attempt.json`,identity);}catch(error){
      if((error as NodeJS.ErrnoException).code!=='EEXIST')throw error;
      const prior=JSON.parse(await readFile(`${path}.attempt.json`,'utf8'));if(canonical(prior)!==canonical(identity))throw new Error('Attempt identity conflict');
    }
    // Explicit caller replay after an ambiguous response recovers this same identity; never replaces a quote.
    const receipt=await this.request('POST','/v1/decisions',{quoteId:journal.quote.id,...journal.input},journal.idempotencyKey);
    this.validateReceipt(receipt,journal);await this.saveReceipt(path,receipt);return receipt;
  }
  recover(path:string){return this.execute(path);}
  async poll(path:string,id:string,maxWaitMs=60000):Promise<any>{
    if(!/^[0-9a-f-]{36}$/.test(id)||!Number.isSafeInteger(maxWaitMs)||maxWaitMs<0||maxWaitMs>300000)throw new Error('Invalid polling bounds');
    const journal=JSON.parse(await readFile(path,'utf8')) as PurchaseJournal;
    if(journal.origin!==this.origin||(await this.request('GET','/v1/me')).account.id!==journal.accountId)throw new Error('Journal identity mismatch');
    this.validateQuote(journal.quote,journal.input,journal.policy);
    if(JSON.parse(await readFile(`${path}.decision.json`,'utf8')).id!==id)throw new Error('Polling purchase identity mismatch');
    const deadline=performance.now()+maxWaitMs;
    while(true){const receipt=await this.request('GET',`/v1/decisions/${id}`);this.validateReceipt(receipt,journal);
      await this.saveReceipt(path,receipt);
      if(receipt.status!=='running'||performance.now()>=deadline)return receipt;
      await new Promise(r=>setTimeout(r,Math.min(1000,Math.max(0,deadline-performance.now()))));}
  }
  private async saveReceipt(path:string,receipt:any){
    const save=async(file:string,value:unknown)=>{try{await record(file,value);}catch(error){if((error as NodeJS.ErrnoException).code!=='EEXIST')throw error;
      if(canonical(JSON.parse(await readFile(file,'utf8')))!==canonical(value))throw new Error('Receipt identity conflict');}};
    await save(`${path}.decision.json`,{id:receipt.id});
    if(receipt.status!=='running')await save(`${path}.receipt.json`,receipt);
  }
  private validateReceipt(receipt:any,journal:PurchaseJournal){
    if(!receipt?.id||!['running','succeeded','failed','indeterminate'].includes(receipt.status))throw new Error('Invalid receipt');
    if(receipt.status==='succeeded'){
      if(receipt.priceNanos!==journal.quote.priceNanos||receipt.sellerId!==journal.quote.sellerId||receipt.requestHash!==journal.quote.requestHash||receipt.schemaHash!==journal.quote.schemaHash)throw new Error('Receipt quote mismatch');
      validateTypedOutput(receipt.result,journal.input,journal.quote.model,journal.quote.inferenceContract?.usageRequirement!=='backend_reported_optional'&&journal.quote.deliveryMode!=='agent');
    }
  }
}
