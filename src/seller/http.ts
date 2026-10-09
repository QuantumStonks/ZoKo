import Fastify from 'fastify';
import { z } from 'zod';
import { safeEqual } from '../security.js';
import { ProviderError } from '../provider.js';
import { createOllamaSeller } from './ollama.js';

export async function buildOllamaSellerServer(config:unknown,key:string){
  if(key.length<32 || /[^\x21-\x7e]/.test(key))throw new Error('Protected seller endpoint credential is required');
  const seller=await createOllamaSeller(config);
  const app=Fastify({bodyLimit:65536,logger:false,requestTimeout:70000});
  app.addHook('onClose',async()=>seller.close());
  app.addHook('onSend',async(_req,reply,payload)=>{reply.header('cache-control','no-store').header('x-content-type-options','nosniff');return payload;});
  app.post('/v1/inference',async(req,reply)=>{
    if(!safeEqual(req.headers.authorization??'',`Bearer ${key}`))return reply.code(401).send({error:{code:'unauthorized'}});
    try{
      const body=z.strictObject({model:z.string(),state:z.unknown(),questions:z.unknown()}).parse(req.body);
      return await seller.evaluate({state:body.state,questions:body.questions},body.model);
    }catch(error){return reply.code(error instanceof z.ZodError?400:error instanceof ProviderError&&['backend_capacity_unavailable','backend_dispatch_unresolved'].includes(error.code)?503:502).send({error:{code:error instanceof ProviderError?error.code:'seller_invalid_request'}});}
  });
  app.get('/v1/capabilities',async()=>({version:'zoko.seller/1',model:seller.config.marketplaceModel,inferenceContract:seller.config.contract,capacity:seller.capacity(),capacityProvenance:'seller_declared',liveInferenceVerified:false}));
  app.get('/health/ready',async(_req,reply)=>{
    const capacity=seller.capacity();return reply.code(capacity.available?200:503).send({...capacity,liveInferenceVerified:false});
  });
  return {app,seller};
}
