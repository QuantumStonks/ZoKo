import { readFile } from 'node:fs/promises';
import { z } from 'zod';
import { buildOllamaSellerServer } from './http.js';

/** Place behind seller-owned TLS. Configuration and endpoint secret stay on seller infrastructure. */
const path=process.env.ZOKO_SELLER_CONFIG;
const key=process.env.ZOKO_SELLER_ENDPOINT_KEY;
if(!path || !key || key.length<32 || /[^\x21-\x7e]/.test(key))throw new Error('Protected seller config and endpoint credential are required');
const {app,seller}=await buildOllamaSellerServer(JSON.parse(await readFile(path,'utf8')),key);
try{
  await seller.preflight();
  const port=z.coerce.number().int().min(1).max(65535).parse(process.env.ZOKO_SELLER_PORT??8090);
  await app.listen({host:'127.0.0.1',port});
}catch(error){await app.close();throw error;}
for(const signal of ['SIGINT','SIGTERM'] as const)process.once(signal,()=>{void app.close();});
