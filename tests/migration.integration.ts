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

describe('Durable payment schema upgrades with PostgreSQL',{
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

  test('version 1 upgrades add HD state while retaining accounts, liabilities and legacy wallet evidence',async()=>{
    // These are exactly the additions to the published version-1 schema. Removing
    // them leaves its original tables, constraints, immutable journal and fields.
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
    assert.deepEqual((await db.query('SELECT version FROM zoko_migrations ORDER BY version')).rows.map(r=>r.version),[1,SCHEMA_VERSION]);
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

  test('a newer unknown schema is rejected without altering existing data',async()=>{
    await db.query('INSERT INTO zoko_migrations(version) VALUES($1)',[SCHEMA_VERSION+1]);
    try {
      await assert.rejects(migrate(db),/Unsupported database schema version/);
      assert.equal((await db.query('SELECT count(*)::integer AS count FROM transfers')).rows[0].count,1);
      assert.equal((await db.query('SELECT max(version)::integer AS version FROM zoko_migrations')).rows[0].version,SCHEMA_VERSION+1);
    }finally{await db.query('DELETE FROM zoko_migrations WHERE version=$1',[SCHEMA_VERSION+1]);}
  });
});
