import assert from 'node:assert/strict';
import { randomBytes, randomUUID } from 'node:crypto';
import { after, before, describe, test } from 'node:test';
import pg from 'pg';
import { auditLedger, createAccount, transaction, transfer, type Db } from '../src/db.js';
import { migrate, SCHEMA_VERSION } from '../src/migration.js';
import { Payments, readPaymentsConfig } from '../src/payments/index.js';
import { MAINNET_GENESIS } from '../src/payments/config.js';
import { PaymentError } from '../src/payments/money.js';
import { encodeCashAddress } from 'ecashaddrjs';

const databaseUrl=process.env.TEST_DATABASE_URL;

describe('Durable marketplace and payment schema upgrades with PostgreSQL',{
  skip:databaseUrl?false:'Set TEST_DATABASE_URL to verify the real PostgreSQL upgrade.',
  concurrency:false,
},()=>{
  const schema=`zoko_migration_${randomUUID().replaceAll('-','')}`;
  let control:pg.Pool,db:Db;
  before(async()=>{
    assert.ok(databaseUrl);
    control=new pg.Pool({connectionString:databaseUrl,max:1});
    await control.query(`CREATE SCHEMA ${schema}`);
    db=new pg.Pool({connectionString:databaseUrl,options:`-c search_path=${schema} -c timezone=UTC`,max:4});
    await migrate(db);
  });
  after(async()=>{
    if(db)await db.end();
    if(control){try{await control.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);}finally{await control.end();}}
  });
  async function removeAgentSchema(){
    await db.query('DROP TABLE agent_jobs');
    await db.query('ALTER TABLE sellers DROP COLUMN delivery_mode,DROP COLUMN agent_ready_until');
    await db.query('ALTER TABLE quotes DROP COLUMN delivery_mode');
    await db.query('DELETE FROM zoko_migrations WHERE version=4');
  }

  test('version 1 upgrades through versions 2 and 3 while retaining accounts, liabilities and legacy wallet evidence',async()=>{
    await removeAgentSchema();
    // Remove the version-3 offer fields and version-2 HD additions to reconstruct
    // version 1 with its original tables, journal, constraints and payment fields.
    await db.query('ALTER TABLE sellers DROP CONSTRAINT sellers_enabled_requires_owner');
    await db.query('ALTER TABLE sellers DROP COLUMN paused');
    await db.query('DROP TABLE payments_address_scans');
    await db.query('DROP TABLE payments_addresses');
    await db.query('ALTER TABLE payments_deposits DROP COLUMN block_height');
    await db.query('DELETE FROM zoko_migrations');
    await db.query('INSERT INTO zoko_migrations(version) VALUES(1)');
    const account=await createAccount(db,{name:'Retained legacy account',dailyLimitNanos:'100000000000',maxPriceNanos:'100000000000'});
    const identity={walletName:'legacy-signing-wallet',identityAddress:encodeCashAddress('ecash','p2pkh','12'.repeat(20)),network:'mainnet',genesis:MAINNET_GENESIS};
    await db.query("INSERT INTO payments_state(key,value) VALUES('wallet-identity',$1)",[JSON.stringify(identity)]);
    await transaction(db,tx=>transfer(tx,'migration-test-existing-liability','external',`available:${account.id}`,100_000_000_000n));
    const before=await db.query('SELECT * FROM transfers ORDER BY id');
    await migrate(db);
    await migrate(db);
    assert.deepEqual((await db.query('SELECT version FROM zoko_migrations ORDER BY version')).rows.map(r=>r.version),[1,2,3,SCHEMA_VERSION]);
    assert.deepEqual((await db.query("SELECT value FROM payments_state WHERE key='wallet-identity'")).rows[0].value,identity);
    assert.deepEqual((await db.query('SELECT * FROM transfers ORDER BY id')).rows,before.rows);
    assert.equal((await db.query('SELECT balance::text FROM wallets WHERE id=$1',[`available:${account.id}`])).rows[0].balance,'100000000000');
    assert.equal((await db.query('SELECT id FROM accounts WHERE id=$1',[account.id])).rowCount,1);
    assert.equal((await db.query('SELECT * FROM payments_addresses')).rowCount,0);
    assert.equal((await db.query('SELECT * FROM payments_address_scans')).rowCount,0);
    assert.equal((await auditLedger(db) as {ok:boolean}).ok,true);
    // No network is needed to recognize a legacy custody binding. In particular,
    // replacing an environment secret must never reassign existing liabilities.
    const payments=new Payments(db,readPaymentsConfig({XEC_WALLET_SEED_HEX:randomBytes(32).toString('hex'),CHRONIK_URLS:'https://unavailable.invalid'}));
    await assert.rejects(payments.preflight(),(error:unknown)=>error instanceof PaymentError&&error.code==='node_wallet_migration_required');
    assert.equal((await db.query('SELECT * FROM payments_addresses')).rowCount,0);
  });

  test('version 2 disables legacy ownerless offers without rewriting quotes, receipts or financial history',async()=>{
    await removeAgentSchema();
    await db.query('ALTER TABLE sellers DROP CONSTRAINT sellers_enabled_requires_owner');
    await db.query('ALTER TABLE sellers DROP COLUMN paused');
    await db.query('DELETE FROM zoko_migrations WHERE version=3');
    const buyer=await createAccount(db,{name:'Legacy market buyer',dailyLimitNanos:'1000',maxPriceNanos:'250'});
    const seller=await createAccount(db,{name:'Existing seller agent',dailyLimitNanos:'0',maxPriceNanos:'0'});
    const legacyId=`legacy-${randomUUID()}`,ownedId=`owned-${randomUUID()}`;
    await db.query(`INSERT INTO sellers(id,name,endpoint,api_key_encrypted,model,price_nanos,payout_account_id)
      VALUES($1,'Legacy platform offer','https://api.typesafe.ai/v1/systemone','opaque-legacy-key','jev-1.13.0',250,NULL),
      ($2,'Existing agent offer','https://api.typesafe.ai/v1/systemone','opaque-agent-key','jev-1.13.0',250,$3)`,[legacyId,ownedId,seller.id]);
    const historicalQuote=randomUUID(),pendingQuote=randomUUID(),decisionId=randomUUID();
    await db.query(`INSERT INTO quotes(id,account_id,seller_id,request_hash,schema_hash,price_nanos,endpoint,api_key_encrypted,model,payout_account_id,fee_bps,timeout_ms,min_confidence,expires_at)
      SELECT quote_id,$1,$2,'frozen-request','frozen-schema',250,'https://api.typesafe.ai/v1/systemone','opaque-legacy-key','jev-1.13.0',NULL,1000,5000,0,now()+interval '1 hour'
      FROM unnest($3::uuid[]) AS quote_id`,[buyer.id,legacyId,[historicalQuote,pendingQuote]]);
    const response={id:decisionId,status:'succeeded',priceNanos:'250',legacyReceipt:true};
    await transaction(db,async tx=>{
      await transfer(tx,`migration-market:${buyer.id}:fund`,'external',`available:${buyer.id}`,1000n);
      await transfer(tx,`decision:${decisionId}:reserve`,`available:${buyer.id}`,`reserved:${buyer.id}`,250n);
      // Preserve the old platform-only capture as historical evidence. Version 3
      // must stop future ownerless work without redistributing past proceeds.
      await transfer(tx,`decision:${decisionId}:fee`,`reserved:${buyer.id}`,'platform',250n);
      await tx.query('INSERT INTO budgets(account_id,day,spent) VALUES($1,CURRENT_DATE,250)',[buyer.id]);
      await tx.query(`INSERT INTO decisions(id,account_id,quote_id,idempotency_key,request_hash,seller_id,price_nanos,budget_day,status,expires_at,response,completed_at)
        VALUES($1,$2,$3,'legacy-completed','frozen-decision-request',$4,250,CURRENT_DATE,'succeeded',now()-interval '1 hour',$5,now())`,
        [decisionId,buyer.id,historicalQuote,legacyId,JSON.stringify(response)]);
    });
    const before={
      quotes:(await db.query('SELECT * FROM quotes ORDER BY id')).rows,
      decisions:(await db.query('SELECT * FROM decisions ORDER BY id')).rows,
      transfers:(await db.query('SELECT * FROM transfers ORDER BY id')).rows,
      wallets:(await db.query('SELECT * FROM wallets ORDER BY id')).rows,
      budgets:(await db.query('SELECT * FROM budgets ORDER BY account_id,day')).rows,
      paymentState:(await db.query('SELECT * FROM payments_state ORDER BY key')).rows,
    };
    await migrate(db);
    await migrate(db);
    assert.equal((await db.query('SELECT max(version)::integer AS version FROM zoko_migrations')).rows[0].version,SCHEMA_VERSION);
    assert.deepEqual((await db.query('SELECT enabled,paused,payout_account_id FROM sellers WHERE id=$1',[legacyId])).rows,
      [{enabled:false,paused:false,payout_account_id:null}]);
    assert.deepEqual((await db.query('SELECT enabled,paused,payout_account_id FROM sellers WHERE id=$1',[ownedId])).rows,
      [{enabled:true,paused:false,payout_account_id:seller.id}]);
    assert.deepEqual((await db.query('SELECT * FROM quotes ORDER BY id')).rows,before.quotes.map(q=>({...q,delivery_mode:'https'})));
    assert.deepEqual((await db.query('SELECT * FROM decisions ORDER BY id')).rows,before.decisions);
    assert.deepEqual((await db.query('SELECT * FROM transfers ORDER BY id')).rows,before.transfers);
    assert.deepEqual((await db.query('SELECT * FROM wallets ORDER BY id')).rows,before.wallets);
    assert.deepEqual((await db.query('SELECT * FROM budgets ORDER BY account_id,day')).rows,before.budgets);
    assert.deepEqual((await db.query('SELECT * FROM payments_state ORDER BY key')).rows,before.paymentState);
    await assert.rejects(db.query('UPDATE sellers SET enabled=true WHERE id=$1',[legacyId]),
      (error:unknown)=>error instanceof Error&&'code' in error&&error.code==='23514');
    await assert.rejects(db.query('UPDATE sellers SET payout_account_id=NULL WHERE id=$1',[ownedId]),
      (error:unknown)=>error instanceof Error&&'code' in error&&error.code==='23514');
    assert.equal((await auditLedger(db) as {ok:boolean}).ok,true);
  });

  test('a newer unknown schema is rejected without altering existing data',async()=>{
    const transfersBefore=(await db.query('SELECT * FROM transfers ORDER BY id')).rows;
    await db.query('INSERT INTO zoko_migrations(version) VALUES($1)',[SCHEMA_VERSION+1]);
    try {
      await assert.rejects(migrate(db),/Unsupported database schema version/);
      assert.deepEqual((await db.query('SELECT * FROM transfers ORDER BY id')).rows,transfersBefore);
      assert.equal((await db.query('SELECT max(version)::integer AS version FROM zoko_migrations')).rows[0].version,SCHEMA_VERSION+1);
    }finally{await db.query('DELETE FROM zoko_migrations WHERE version=$1',[SCHEMA_VERSION+1]);}
  });
});
