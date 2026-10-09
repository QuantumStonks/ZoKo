import { z } from 'zod';
import { OfferContractSchema } from './offer-contract.js';

const ref=(name:string)=>({$ref:`#/components/schemas/${name}`});
const json=(schema:unknown)=>({content:{'application/json':{schema}}});
const money={type:'string',pattern:'^(0|[1-9][0-9]{0,29})$',description:'Exact integer nanoXEC; 1 XEC = 1000000000 nanoXEC.'};
const object=(properties:Record<string,unknown>,required=Object.keys(properties))=>({type:'object',properties,required,additionalProperties:false});
const entry={oneOf:[{type:'string'},{type:'object',additionalProperties:true},{type:'array',items:{}}]};
const description={anyOf:[entry,{type:'null'}]};
const label={type:'string',minLength:1,maxLength:128,not:{enum:['__proto__','prototype','constructor']}};
const question=(type:string,criteria:unknown,required:string[])=>object({type:{const:type},instructions:description,criteria},required);
const errors=Object.fromEntries([400,401,402,403,404,409,429,500,502,503].map(code=>[code,{description:'Rejected or uncertain request; retain original purchase identity and reconcile before replacement.',...json(ref('Error'))}]));
const key={name:'Idempotency-Key',in:'header',required:true,schema:{type:'string',pattern:'^[A-Za-z0-9_.:-]{8,128}$'}};
const id=(name:string,uuid=false)=>({name,in:'path',required:true,schema:{type:'string',...(uuid?{format:'uuid'}:{pattern:'^[a-z0-9][a-z0-9_-]{0,63}$'})}});
function operation(operationId:string,response:unknown,request?:unknown,parameters:unknown[]=[],accepted=false,publicRoute=false,created=false) {
  return {operationId,security:publicRoute?[]:[{accountKey:[]}],...(parameters.length?{parameters}:{}),
    ...(request?{requestBody:{required:true,...json(request)}}:{}),responses:{[created?'201':'200']:{description:'Result',...json(response)},
      ...(accepted?{'202':{description:'Purchase running; poll its ID or replay the original identity.',headers:{'Retry-After':{schema:{type:'integer',minimum:1}}},...json(ref('Receipt'))}}:{}),...errors}};
}
const probability={type:'number',minimum:0,maximum:1};
const probabilities={type:'object',additionalProperties:probability};
export const openApiDocument={
  openapi:'3.1.0',info:{title:'ZoKo independent inference marketplace HTTP API',version:'1.0.0',description:'Buyer and seller lifecycle. Model-specific outputs are sold at immutable fixed nanoXEC prices. Seller declarations do not independently prove permission or live capacity. Funding and operator endpoints are outside this document.'},
  servers:[{url:'/'}],
  paths:{
    '/v1/openapi.json':{get:operation('openapi',{type:'object'},undefined,[],false,true)},
    '/v1/capabilities':{get:operation('capabilities',{type:'object'},undefined,[],false,true)},
    '/.well-known/zoko.json':{get:operation('discover',{type:'object'},undefined,[],false,true)},
    '/v1/catalog':{get:operation('catalog',object({sellers:{type:'array',items:ref('Offer')}}),undefined,[],false,true)},
    '/v1/me':{get:operation('account', {type:'object'})},
    '/v1/quotes':{post:operation('quote',ref('Quote'),object({state:entry,questions:ref('Questions'),policy:ref('Policy')},['state','questions']))},
    '/v1/decisions':{post:operation('submit',ref('Receipt'),object({quoteId:{type:'string',format:'uuid'},state:entry,questions:ref('Questions')}),[key],true)},
    '/v1/decisions/{id}':{get:operation('receipt',ref('Receipt'),undefined,[id('id',true)],true)},
    '/v1/seller/offers':{get:operation('ownedOffers',object({offers:{type:'array',items:{type:'object'}},nextCursor:{type:['string','null']}}),undefined,[{name:'limit',in:'query',schema:{type:'integer',minimum:1,maximum:100,default:100}},{name:'after',in:'query',schema:{type:'string'}}]),
      post:operation('registerOffer',{type:'object'},object({id:{type:'string',pattern:'^[a-z0-9][a-z0-9_-]{0,63}$'},name:{type:'string',minLength:1,maxLength:120},endpoint:{type:'string',format:'uri',description:'Operator-admitted public HTTPS seller endpoint.'},apiKey:{type:'string',minLength:1,maxLength:4096,writeOnly:true},model:{type:'string',minLength:1,maxLength:100},priceNanos:money,inferenceContract:ref('InferenceContract')},['id','name','endpoint','apiKey','model','priceNanos']),[],false,false,true)},
    '/v1/seller/offers/{id}':{patch:operation('updateOwnedOffer',{type:'object'},{...object({priceNanos:money,apiKey:{type:'string',minLength:1,maxLength:4096,writeOnly:true},paused:{type:'boolean'}},[]),minProperties:1},[id('id')])},
    '/v1/seller/offers/{id}/capacity':{post:operation('declareCapacity',object({id:{type:'string'},capacityUntil:{type:['string','null'],format:'date-time'},provenance:{const:'seller_declared'},liveInferenceVerified:{const:false}}),object({ready:{type:'boolean'}}),[id('id')])},
  },
  components:{securitySchemes:{accountKey:{type:'http',scheme:'bearer',description:'Buyer/seller account key; keep separate from seller endpoint and inference backend credentials.'}},schemas:{
    InferenceContract:z.toJSONSchema(OfferContractSchema),
    Questions:{type:'object',minProperties:1,maxProperties:20,propertyNames:label,additionalProperties:ref('Question')},
    Question:{oneOf:[question('noul',{anyOf:[object({true:description,false:description},[]),{type:'null'}]},['type']),question('choice',{type:'object',minProperties:1,maxProperties:255,propertyNames:label,additionalProperties:description},['type','criteria']),question('score',{type:'array',minItems:2,maxItems:10,items:entry},['type','criteria'])]},
    DecisionInput:{...object({state:entry,questions:ref('Questions')}),'x-max-utf8-bytes':32768,'x-max-json-depth':24,'x-max-json-values':8192},
    Policy:object({maxPriceNanos:money,maxLatencyMs:{type:'integer',minimum:100,maximum:60000},minConfidence:probability,allowedSellers:{type:'array',minItems:1,maxItems:100,items:{type:'string',minLength:1,maxLength:64}},model:{type:'string',minLength:1,maxLength:128},usageRequirement:{const:'backend_reported_required'}},[]),
    Offer:{type:'object',required:['id','model','priceNanos','available','questionTypes'],properties:{id:{type:'string'},model:{type:'string'},priceNanos:money,available:{type:'boolean',description:'Routing eligibility only, not proof of live inference capacity.'},questionTypes:{type:'array',items:{enum:['noul','choice','score']}},inferenceContract:{anyOf:[ref('InferenceContract'),{type:'null'}]},capacityUntil:{type:['string','null'],format:'date-time'},capacityEvidence:{enum:['seller_declared_expiring','legacy_capacity_unverified']}}},
    Quote:{type:'object',required:['id','sellerId','model','priceNanos','schemaHash','requestHash','expiresAt','timeoutMs','currency'],properties:{id:{type:'string',format:'uuid'},sellerId:{type:'string'},model:{type:'string'},priceNanos:money,currency:{const:'nanoXEC'},schemaHash:{type:'string'},requestHash:{type:'string'},expiresAt:{type:'string',format:'date-time'},timeoutMs:{type:'integer'},inferenceContract:{anyOf:[ref('InferenceContract'),{type:'null'}]}}},
    Usage:{...object({input_tokens:{type:['integer','null'],minimum:0,maximum:9007199254740991},output_tokens:{type:['integer','null'],minimum:0,maximum:9007199254740991}}),description:'Backend-reported counts only. Required-usage offers require both integer counts. Optional offers preserve each reported count and mark a missing field null; both missing is usage:null.'},
    Answer:{oneOf:[object({type:{const:'noul'},noul:probability}),object({type:{const:'choice'},choice:{type:'string'},probabilities,confidence:probability}),object({type:{const:'score'},score:{type:'number'},legend:{type:'object',additionalProperties:entry},probabilities,confidence:probability})]},
    Result:object({model:{type:'string'},answers:{type:'object',additionalProperties:ref('Answer')},usage:{anyOf:[ref('Usage'),{type:'null'}]}}),
    Receipt:{type:'object',required:['id','status'],properties:{id:{type:'string',format:'uuid'},status:{enum:['running','succeeded','failed','indeterminate']},result:ref('Result'),priceNanos:money,accepted:{type:'boolean'},usageEvidence:{type:'object',properties:{actual:{anyOf:[ref('Usage'),{type:'null'}]},estimate:{type:'null'},source:{enum:['seller_backend_reported','missing']},model:{type:'string'},modelIdentity:{type:'string'},verifiedByMarketplace:{const:false}}},error:ref('ErrorDetail')}},
    ErrorDetail:object({code:{type:'string'},message:{type:'string'},details:{}},['code','message']),
    Error:object({error:ref('ErrorDetail'),requestId:{type:'string'}},['error']),
  }},
} as const;
