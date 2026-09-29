import Fastify from 'fastify';
import rateLimit from '@fastify/rate-limit';
import staticFiles from '@fastify/static';
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';
import { z } from 'zod';
import { Config, MoneySchema, PositiveMoneySchema } from './config.js';
import { auditLedger, createAccount, Db, transaction, transfer } from './db.js';
import { Market, PolicySchema, Provider } from './market.js';
import { AppError, encrypt, issueKey, keyHash, safeEqual, validateEndpoint } from './security.js';
import { Payments } from './payments/index.js';
import { PaymentError } from './payments/money.js';
import { DecisionInputSchema } from './protocol.js';
import { SCHEMA_VERSION } from './migration.js';

const Uuid = z.uuid();
const SellerId = z.string().regex(/^[a-z0-9][a-z0-9_-]{0,63}$/);
const Names = z.string().trim().min(1).max(120);
const CreateAccountSchema = z.object({name:Names,dailyLimitNanos:MoneySchema,maxPriceNanos:MoneySchema,allowedSellers:z.array(SellerId).max(100).optional()}).strict();
const AccountPolicySchema = z.object({dailyLimitNanos:MoneySchema.optional(),maxPriceNanos:MoneySchema.optional(),allowedSellers:z.array(SellerId).max(100).nullable().optional(),disabled:z.boolean().optional()}).strict();
const AgentOfferSchema = z.object({id:SellerId,name:Names,endpoint:z.string().url().max(2048),apiKey:z.string().min(1).max(4096),model:z.string().min(1).max(100),priceNanos:PositiveMoneySchema}).strict();
const SessionOfferSchema = AgentOfferSchema.omit({endpoint:true,apiKey:true});
const SellerSchema = AgentOfferSchema.extend({payoutAccountId:Uuid,enabled:z.boolean().optional()});
const OfferPatchSchema = z.object({priceNanos:PositiveMoneySchema.optional(),apiKey:z.string().min(1).max(4096).optional(),paused:z.boolean().optional()}).strict().refine(value=>Object.keys(value).length>0,'Provide an offer change');

export async function buildServer(config:Config,db:Db,payments:Payments,provider?:Provider) {
  const app = Fastify({
    bodyLimit:65536,requestTimeout:70000,connectionTimeout:10000,trustProxy:false,
    logger:{level:process.env.LOG_LEVEL ?? 'info',redact:['req.headers.authorization','req.headers.cookie','res.headers["set-cookie"]','apiKey','api_key_encrypted','password','walletSeedHex','XEC_WALLET_SEED_HEX','state','questions']},
  });
  const market = new Market(db,config,provider);
  app.decorate('market',market);
  await app.register(rateLimit,{max:1200,timeWindow:'1 minute'});
  app.addHook('onSend',async(_req,reply,payload) => {
    reply.header('x-content-type-options','nosniff').header('referrer-policy','no-referrer').header('cache-control','no-store')
      .header('x-frame-options','DENY')
      .header('content-security-policy',"default-src 'none'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self'; base-uri 'none'; form-action 'self'; frame-ancestors 'none'")
      .header('permissions-policy','camera=(), microphone=(), geolocation=()');
    if (config.production) reply.header('strict-transport-security','max-age=31536000');
    return payload;
  });
  app.setErrorHandler((error,request,reply) => {
    if (error instanceof z.ZodError) return reply.code(400).send({error:{code:'invalid_request',message:'Request validation failed',details:error.issues.map(i=>({path:i.path,message:i.message}))},requestId:request.id});
    if (error instanceof AppError) return reply.code(error.statusCode).send({error:{code:error.code,message:error.message,...(error.details?{details:error.details}:{})},requestId:request.id});
    if (error instanceof PaymentError) return reply.code(error.statusCode).send({error:{code:error.code,message:error.message},requestId:request.id});
    const code = (error as {statusCode?:number}).statusCode;
    if (code && code>=400 && code<500) return reply.code(code).send({error:{code:'request_rejected',message:code===429?'Rate limit exceeded':'Request rejected'},requestId:request.id});
    // Do not serialize database errors, wallet secrets, or untrusted upstream bodies.
    request.log.error({requestId:request.id,errorType:error instanceof Error?error.name:'UnknownError'},'Request failed');
    return reply.code(500).send({error:{code:'internal_error',message:'Request could not be completed; retry with the same idempotency key'},requestId:request.id});
  });
  function bearer(headers: {authorization?:string}) {
    const match = /^Bearer ([^\s]{1,512})$/.exec(headers.authorization ?? '');
    if (!match) throw new AppError(401,'unauthorized','A bearer API key is required');
    return match[1];
  }
  function admin(headers:{authorization?:string}) {
    if (!safeEqual(bearer(headers),config.adminToken)) throw new AppError(401,'unauthorized','Invalid operator credential');
  }
  async function agentAccount(headers:{authorization?:string}):Promise<string> {
    const hash = keyHash(bearer(headers));
    const rows = await db.query('SELECT id FROM accounts WHERE api_key_hash=$1 AND NOT disabled',[hash]);
    if (!rows.rowCount) throw new AppError(401,'unauthorized','Invalid or disabled API key');
    return rows.rows[0].id;
  }
  function idem(headers:Record<string,unknown>):string {
    const key=headers['idempotency-key'];
    if (typeof key!=='string' || !/^[A-Za-z0-9_.:-]{8,128}$/.test(key)) throw new AppError(400,'invalid_idempotency_key','Provide an Idempotency-Key of 8–128 URL-safe characters');
    return key;
  }
  const accountView=(a:Record<string,any>)=>({id:a.id,name:a.name,dailyLimitNanos:a.daily_limit_nanos,maxPriceNanos:a.max_price_nanos,allowedSellers:a.allowed_sellers,disabled:a.disabled});
  const offerView=(s:Record<string,any>)=>({id:s.id,name:s.name,endpoint:s.delivery_mode==='agent'?null:s.endpoint,deliveryMode:s.delivery_mode,readyUntil:s.agent_ready_until,model:s.model,priceNanos:s.price_nanos,payoutAccountId:s.payout_account_id,enabled:s.enabled,paused:s.paused,commissionBps:config.platformFeeBps});
  async function createOffer(ownerId:string,offer:z.infer<typeof AgentOfferSchema>,enabled:boolean,actor:string) {
    const endpoint=validateEndpoint(offer.endpoint,config.providerHosts);
    return transaction(db,async tx=>{
      const owner=await tx.query('SELECT id FROM accounts WHERE id=$1 AND NOT disabled FOR UPDATE',[ownerId]);
      if(!owner.rowCount)throw new AppError(400,'invalid_payout_account','Seller account is unavailable');
      const result=await tx.query(`INSERT INTO sellers(id,name,endpoint,api_key_encrypted,model,price_nanos,payout_account_id,enabled,paused)
        VALUES($1,$2,$3,$4,$5,$6,$7,$8,false) ON CONFLICT(id) DO NOTHING RETURNING *`,
        [offer.id,offer.name,endpoint,encrypt(offer.apiKey,config.encryptionKey),offer.model,offer.priceNanos,ownerId,enabled]);
      if(!result.rowCount)throw new AppError(409,'seller_exists','Seller offer ID already exists');
      await tx.query('INSERT INTO audit_events(actor,action,subject,metadata) VALUES($1,$2,$3,$4)',[actor,'seller.created',offer.id,JSON.stringify({payoutAccountId:ownerId,enabled,priceNanos:offer.priceNanos})]);
      return offerView(result.rows[0]);
    });
  }
  const decisionHttp=(result:Record<string,any>,reply:{code:(code:number)=>unknown;header:(key:string,value:string)=>unknown})=>{
    if(result.status==='running'){reply.code(202);reply.header('retry-after','1');}
    return result;
  };

  app.get('/health/live',async()=>({ok:true,service:'zoko',version:'1.3.0'}));
  app.get('/health/ready',async(_req,reply)=>{
    try {
      const migration=await db.query('SELECT max(version)::integer AS version FROM zoko_migrations');
      if(migration.rows[0]?.version!==SCHEMA_VERSION)throw new Error('Unsupported schema');
      const count = await db.query(`SELECT count(*)::integer AS n FROM sellers s JOIN accounts a ON a.id=s.payout_account_id
        WHERE s.enabled AND NOT s.paused AND NOT a.disabled AND (s.circuit_until IS NULL OR s.circuit_until<=clock_timestamp())
        AND (s.delivery_mode='https' OR (s.agent_ready_until>clock_timestamp() AND NOT EXISTS
          (SELECT 1 FROM decisions busy WHERE busy.seller_id=s.id AND busy.status='running')))`);
      const paymentStatus = payments.status() as {ready?:boolean;enabled?:boolean};
      const ready=!config.payments.enabled || paymentStatus.ready===true;
      reply.code(ready?200:503);
      return {ok:ready,tradingReady:ready&&count.rows[0].n>0,database:'ready',enabledSellers:count.rows[0].n,payments:paymentStatus};
    } catch {reply.code(503);return {ok:false,tradingReady:false,database:'unavailable'};}
  });
  app.get('/v1/catalog',async()=>({sellers:await market.catalog()}));
  app.get('/.well-known/zoko.json',async()=>({
    name:'Zoko',version:'1.3.0',protocol:'typesafe-systemone-v1',
    catalog:'/v1/catalog',quote:'/v1/quotes',execute:'/v1/decisions',
    authentication:{scheme:'Bearer',provisioning:'operator_issued_scoped_account_key',accountRoles:['buyer','seller']},
    marketplace:{role:'intermediary',sellerOffers:'/v1/seller/offers',approvalRequired:true,ownership:'authenticated_seller_account',sellerPaysDeliveryCosts:true},
    agentDelivery:{register:'/v1/seller/agent-offers',claim:'/v1/seller/jobs/claim',complete:'/v1/seller/jobs/:id/complete',presenceSeconds:120,capacityPerOffer:1,tokenUsage:'unavailable',inference:'active_seller_session',credentials:'seller_local_only'},
    payment:{currency:'XEC',ledgerUnit:'nanoXEC',unitsPerXec:'1000000000',unitsPerOnChainAtom:'10000000',method:'custodial_prepaid_balance',network:config.payments.network,verification:'hosted_chronik',fundingWallet:'cashtab',depositHistory:'/v1/deposits'},
    billing:{quoteTtlSeconds:config.quoteTtlSeconds,idempotencyHeader:'Idempotency-Key',successfulResponseIsBillable:true,lowConfidenceResponseIsBillable:true,failedExecutionIsRefunded:true,platformCommissionBps:config.platformFeeBps,commissionPolicy:'deducted_from_seller_price'},
    limits:{inputBytes:32768,questions:20,maximumProviderTimeoutMs:config.providerMaxTimeoutMs},
    documentation:'https://github.com/QuantumStonks/ZoKo',
  }));
  app.get('/v1/me',async req=>{
    const id=await agentAccount(req.headers);
    const a=(await db.query('SELECT * FROM accounts WHERE id=$1',[id])).rows[0];
    const wallets=await db.query('SELECT id,balance::text FROM wallets WHERE id=ANY($1)',[[`available:${id}`,`reserved:${id}`]]);
    const b=(await db.query("SELECT spent::text,reserved::text,day::text FROM budgets WHERE account_id=$1 AND day=(now() AT TIME ZONE 'UTC')::date",[id])).rows[0];
    return {account:accountView(a),balanceNanos:wallets.rows.find(w=>w.id===`available:${id}`).balance,reservedNanos:wallets.rows.find(w=>w.id===`reserved:${id}`).balance,depositAddress:a.deposit_address,payments:payments.status(),spending:{day:b?.day??new Date().toISOString().slice(0,10),spentNanos:b?.spent??'0',reservedNanos:b?.reserved??'0'}};
  });
  app.post('/v1/deposit-address',async req=>({address:await payments.provisionAddress(await agentAccount(req.headers))}));
  app.post('/v1/deposits/claim',async req=>{
    const id=await agentAccount(req.headers),body=z.object({txid:z.string().regex(/^[0-9a-fA-F]{64}$/)}).strict().parse(req.body);
    return payments.claimDeposit(id,body.txid.toLowerCase());
  });
  app.get('/v1/deposits',async req=>{
    const id=await agentAccount(req.headers);
    const query=z.object({txid:z.string().regex(/^[0-9a-fA-F]{64}$/).transform(v=>v.toLowerCase()).optional(),limit:z.coerce.number().int().min(1).max(100).default(100)}).strict().parse(req.query);
    const rows=await db.query(`SELECT txid,vout,amount_nanos::text,status,confirmations,avalanche_finalized,credited_at,created_at
      FROM payments_deposits WHERE account_id=$1 AND network=$2 AND ($3::text IS NULL OR txid=$3)
      ORDER BY created_at DESC,txid,vout LIMIT $4`,[id,config.payments.network,query.txid??null,query.limit]);
    return {deposits:rows.rows.map(d=>({txid:d.txid,vout:d.vout,amountNanos:d.amount_nanos,status:d.status,confirmations:d.confirmations,avalancheFinalized:d.avalanche_finalized,creditedAt:d.credited_at,createdAt:d.created_at}))};
  });
  app.post('/v1/withdrawals',async req=>{
    const id=await agentAccount(req.headers),body=z.object({address:z.string().min(10).max(200),amountNanos:PositiveMoneySchema}).strict().parse(req.body);
    return payments.requestWithdrawal(id,body.address,body.amountNanos,idem(req.headers));
  });
  app.get('/v1/withdrawals',async req=>({withdrawals:await payments.listWithdrawals(await agentAccount(req.headers))}));
  app.post('/v1/quotes',async req=>{
    const id=await agentAccount(req.headers);
    const body=z.object({state:z.unknown(),questions:z.unknown(),policy:PolicySchema.optional()}).strict().parse(req.body);
    return market.quote(id,DecisionInputSchema.parse({state:body.state,questions:body.questions}),body.policy);
  });
  app.post('/v1/decisions',async(req,reply)=>{
    const id=await agentAccount(req.headers),body=z.object({quoteId:Uuid,state:z.unknown(),questions:z.unknown()}).strict().parse(req.body);
    return decisionHttp(await market.decide(id,idem(req.headers),{quoteId:body.quoteId,...DecisionInputSchema.parse({state:body.state,questions:body.questions})}),reply);
  });
  app.get('/v1/decisions/:id',async(req,reply)=>{
    const accountId=await agentAccount(req.headers),id=Uuid.parse((req.params as {id:string}).id);
    return decisionHttp(await market.getDecision(accountId,id),reply);
  });
  app.get('/v1/decisions',async req=>{
    const id=await agentAccount(req.headers),query=z.object({limit:z.coerce.number().int().min(1).max(100).default(50)}).parse(req.query);
    const rows=await db.query('SELECT id,status,seller_id,price_nanos,created_at,response,error_code FROM decisions WHERE account_id=$1 ORDER BY created_at DESC LIMIT $2',[id,query.limit]);
    return {decisions:rows.rows.map(d=>d.response??{id:d.id,status:d.status,sellerId:d.seller_id,priceNanos:d.price_nanos,createdAt:d.created_at,errorCode:d.error_code})};
  });

  app.get('/v1/seller/offers',async req=>{
    const ownerId=await agentAccount(req.headers);
    const query=z.object({limit:z.coerce.number().int().min(1).max(100).default(100),after:SellerId.optional()}).strict().parse(req.query);
    const result=await db.query(`SELECT * FROM sellers WHERE payout_account_id=$1 AND ($2::text IS NULL OR id>$2)
      ORDER BY id LIMIT $3`,[ownerId,query.after??null,query.limit+1]);
    const rows=result.rows.slice(0,query.limit);
    return {offers:rows.map(offerView),nextCursor:result.rows.length>query.limit?rows.at(-1)!.id:null};
  });
  app.post('/v1/seller/offers',async(req,reply)=>{
    const ownerId=await agentAccount(req.headers),offer=AgentOfferSchema.parse(req.body);
    const created=await createOffer(ownerId,offer,false,`agent:${ownerId}`);
    reply.code(201);return created;
  });
  app.post('/v1/seller/agent-offers',async(req,reply)=>{
    const ownerId=await agentAccount(req.headers),offer=SessionOfferSchema.parse(req.body);
    const created=await transaction(db,async tx=>{
      const owner=await tx.query('SELECT id FROM accounts WHERE id=$1 AND NOT disabled FOR UPDATE',[ownerId]);
      if(!owner.rowCount)throw new AppError(403,'account_disabled','Seller account is unavailable');
      const result=await tx.query(`INSERT INTO sellers(id,name,endpoint,api_key_encrypted,model,price_nanos,payout_account_id,enabled,paused,delivery_mode)
        VALUES($1,$2,'','',$3,$4,$5,false,false,'agent') ON CONFLICT(id) DO NOTHING RETURNING *`,[offer.id,offer.name,offer.model,offer.priceNanos,ownerId]);
      if(!result.rowCount)throw new AppError(409,'seller_exists','Seller offer ID already exists');
      await tx.query('INSERT INTO audit_events(actor,action,subject,metadata) VALUES($1,$2,$3,$4)',[`agent:${ownerId}`,'seller.created',offer.id,JSON.stringify({deliveryMode:'agent',enabled:false,priceNanos:offer.priceNanos})]);
      return offerView(result.rows[0]);
    });
    reply.code(201);return created;
  });
  app.post('/v1/seller/offers/:id/ready',async req=>{
    const ownerId=await agentAccount(req.headers),id=SellerId.parse((req.params as {id:string}).id);
    const {ready}=z.object({ready:z.boolean()}).strict().parse(req.body);
    return market.agentReady(ownerId,id,ready);
  });
  app.post('/v1/seller/jobs/claim',async req=>{
    const ownerId=await agentAccount(req.headers),{sellerId}=z.object({sellerId:SellerId}).strict().parse(req.body);
    return market.claimAgentJob(ownerId,sellerId,idem(req.headers));
  });
  app.post('/v1/seller/jobs/:id/complete',async req=>{
    const ownerId=await agentAccount(req.headers),id=Uuid.parse((req.params as {id:string}).id);
    const body=z.object({claimToken:Uuid,result:z.unknown()}).strict().parse(req.body);
    return market.completeAgentJob(ownerId,id,body.claimToken,body.result);
  });
  app.patch('/v1/seller/offers/:id',async req=>{
    const ownerId=await agentAccount(req.headers),id=SellerId.parse((req.params as {id:string}).id),input=OfferPatchSchema.parse(req.body);
    return transaction(db,async tx=>{
      // Account first, then offer: the same order used by execution admission.
      const owner=await tx.query('SELECT id FROM accounts WHERE id=$1 AND NOT disabled FOR UPDATE',[ownerId]);
      if(!owner.rowCount)throw new AppError(403,'account_disabled','Seller account is unavailable');
      const found=await tx.query('SELECT * FROM sellers WHERE id=$1 AND payout_account_id=$2 FOR UPDATE',[id,ownerId]);
      if(!found.rowCount)throw new AppError(404,'seller_not_found','Seller offer not found');
      const current=found.rows[0];
      if(current.delivery_mode==='agent' && input.apiKey)throw new AppError(400,'invalid_agent_change','Active-agent offers do not use an inference API key');
      const changed=await tx.query(`UPDATE sellers SET price_nanos=$1,api_key_encrypted=$2,paused=$3
        WHERE id=$4 AND payout_account_id=$5 RETURNING *`,[input.priceNanos??current.price_nanos,input.apiKey?encrypt(input.apiKey,config.encryptionKey):current.api_key_encrypted,input.paused??current.paused,id,ownerId]);
      await tx.query('INSERT INTO audit_events(actor,action,subject,metadata) VALUES($1,$2,$3,$4)',
        [`agent:${ownerId}`,'seller.updated',id,JSON.stringify({...input,apiKey:input.apiKey?'rotated':undefined})]);
      return offerView(changed.rows[0]);
    });
  });

  app.get('/v1/admin/overview',async req=>{
    admin(req.headers);
    const accounts=await db.query(`SELECT a.*,w.balance::text AS available,r.balance::text AS reserved FROM accounts a
      JOIN wallets w ON w.id='available:'||a.id JOIN wallets r ON r.id='reserved:'||a.id ORDER BY a.created_at DESC LIMIT 1000`);
    const counts=(await db.query("SELECT count(*)::integer AS total,count(*) FILTER(WHERE status='succeeded')::integer AS successful FROM decisions")).rows[0];
    const revenue=(await db.query("SELECT balance::text FROM wallets WHERE id='platform'")).rows[0].balance;
    const offers=await db.query('SELECT * FROM sellers ORDER BY enabled,created_at DESC LIMIT 1000');
    return {accounts:accounts.rows.map(a=>({...accountView(a),balanceNanos:a.available,reservedNanos:a.reserved,depositAddress:a.deposit_address})),sellers:offers.rows.map(offerView),platformCommissionBps:config.platformFeeBps,totalDecisions:counts.total,successfulDecisions:counts.successful,platformRevenueNanos:revenue,payments:payments.status(),ledger:await auditLedger(db)};
  });
  app.post('/v1/admin/accounts',async(req,reply)=>{admin(req.headers);reply.code(201);return createAccount(db,CreateAccountSchema.parse(req.body));});
  app.patch('/v1/admin/accounts/:id',async req=>{
    admin(req.headers);const id=Uuid.parse((req.params as {id:string}).id),input=AccountPolicySchema.parse(req.body);
    return transaction(db,async tx=>{
      const found=await tx.query('SELECT * FROM accounts WHERE id=$1 FOR UPDATE',[id]);
      if(!found.rowCount)throw new AppError(404,'account_not_found','Account not found');
      const a=found.rows[0];
      const updated=await tx.query('UPDATE accounts SET daily_limit_nanos=$1,max_price_nanos=$2,allowed_sellers=$3,disabled=$4 WHERE id=$5 RETURNING *',[input.dailyLimitNanos??a.daily_limit_nanos,input.maxPriceNanos??a.max_price_nanos,input.allowedSellers===undefined?a.allowed_sellers:input.allowedSellers,input.disabled??a.disabled,id]);
      await tx.query('INSERT INTO audit_events(actor,action,subject,metadata) VALUES($1,$2,$3,$4)',['admin','account.policy_changed',id,JSON.stringify(input)]);
      return accountView(updated.rows[0]);
    });
  });
  app.post('/v1/admin/accounts/:id/rotate-key',async req=>{
    admin(req.headers);const id=Uuid.parse((req.params as {id:string}).id),apiKey=issueKey();
    await transaction(db,async tx=>{
      const result=await tx.query('UPDATE accounts SET api_key_hash=$1 WHERE id=$2 RETURNING id',[keyHash(apiKey),id]);
      if(!result.rowCount)throw new AppError(404,'account_not_found','Account not found');
      await tx.query('INSERT INTO audit_events(actor,action,subject) VALUES($1,$2,$3)',['admin','account.key_rotated',id]);
    });
    return {id,apiKey};
  });
  app.post('/v1/admin/sellers',async(req,reply)=>{
    admin(req.headers);const s=SellerSchema.parse(req.body);
    const created=await createOffer(s.payoutAccountId,s,s.enabled??true,'admin');
    reply.code(201);return created;
  });
  app.patch('/v1/admin/sellers/:id',async req=>{
    admin(req.headers);const id=SellerId.parse((req.params as {id:string}).id);
    const input=z.object({enabled:z.boolean().optional(),priceNanos:PositiveMoneySchema.optional(),apiKey:z.string().min(1).max(4096).optional()}).strict().refine(value=>Object.keys(value).length>0,'Provide an offer change').parse(req.body);
    await transaction(db,async tx=>{
      const identity=await tx.query('SELECT payout_account_id FROM sellers WHERE id=$1',[id]);
      if(!identity.rowCount)throw new AppError(404,'seller_not_found','Seller offer not found');
      const ownerId=identity.rows[0].payout_account_id;
      const owner=ownerId?await tx.query('SELECT disabled FROM accounts WHERE id=$1 FOR UPDATE',[ownerId]):undefined;
      const found=await tx.query('SELECT * FROM sellers WHERE id=$1 FOR UPDATE',[id]);
      if(!found.rowCount)throw new AppError(404,'seller_not_found','Seller not found');
      const s=found.rows[0];
      if(s.payout_account_id!==ownerId)throw new AppError(409,'seller_owner_changed','Seller ownership changed during the request');
      const enabled=input.enabled??s.enabled;
      if(enabled&&(!owner?.rowCount||owner.rows[0].disabled))throw new AppError(400,'invalid_payout_account','Approval requires an active seller account');
      if(s.delivery_mode==='agent'&&input.apiKey)throw new AppError(400,'invalid_agent_change','Active-agent offers do not use an inference API key');
      if(enabled&&s.delivery_mode==='https')validateEndpoint(s.endpoint,config.providerHosts);
      await tx.query('UPDATE sellers SET enabled=$1,price_nanos=$2,api_key_encrypted=$3 WHERE id=$4',[enabled,input.priceNanos??s.price_nanos,input.apiKey?encrypt(input.apiKey,config.encryptionKey):s.api_key_encrypted,id]);
      await tx.query('INSERT INTO audit_events(actor,action,subject,metadata) VALUES($1,$2,$3,$4)',['admin','seller.updated',id,JSON.stringify({...input,apiKey:input.apiKey?'rotated':undefined})]);
    });
    return {id,updated:true};
  });
  app.post('/v1/admin/revenue-transfer',async req=>{
    admin(req.headers);const body=z.object({accountId:Uuid,amountNanos:PositiveMoneySchema}).strict().parse(req.body),key=idem(req.headers);
    await transaction(db,async tx=>{
      if(!(await tx.query('SELECT id FROM accounts WHERE id=$1 AND NOT disabled FOR UPDATE',[body.accountId])).rowCount)throw new AppError(400,'invalid_account','Recipient account is unavailable');
      await transfer(tx,`revenue:${key}`,'platform',`available:${body.accountId}`,BigInt(body.amountNanos),{actor:'admin'});
    });
    return {accountId:body.accountId,amountNanos:body.amountNanos};
  });
  app.get('/v1/admin/audit',async req=>{admin(req.headers);return auditLedger(db);});
  const root=resolve(fileURLToPath(new URL('.',import.meta.url)),import.meta.url.includes('/dist/')?'../../public':'../public');
  await app.register(staticFiles,{root,prefix:'/',index:'index.html',dotfiles:'deny'});
  app.setNotFoundHandler((_req,reply)=>reply.code(404).send({error:{code:'not_found',message:'Route not found'}}));
  return app;
}
