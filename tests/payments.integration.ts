import assert from 'node:assert/strict';
import { randomBytes, randomUUID } from 'node:crypto';
import { after, afterEach, before, describe, test } from 'node:test';
import pg from 'pg';
import { encodeCashAddress } from 'ecashaddrjs';
import type { Tx as IndexedTx } from 'chronik-client';
import { auditLedger, createAccount, transaction, transfer, type Db, type Tx } from '../src/db.js';
import { migrate } from '../src/migration.js';
import { Payments, readPaymentsConfig } from '../src/payments/index.js';
import { ChronikHttpError } from '../src/payments/chronik.js';
import { NANOS_PER_ATOM, PaymentError, nanosToXec } from '../src/payments/money.js';
import { RpcError } from '../src/payments/rpc.js';
import { addressScript, transactionId, type InputOutpoint } from '../src/payments/verification.js';

/**
 * Persistence, concurrency, and retry tests use real PostgreSQL. The exclusively
 * in-test protocol adapters expose controlled chain evidence and failures; they
 * do not replace database transactions and are never available in production.
 * These tests prove accounting/state transitions, not real-node consensus.
 */
const databaseUrl = process.env.TEST_DATABASE_URL;
const XEC = 1_000_000_000n;
const blockHash = 'ab'.repeat(32), genesisHash = 'cd'.repeat(32);
const tokenId = 'cdcdcdcdcdc9dda4c92bb1145aa84945c024346ea66fd4b699e344e45df2e145';

interface ChainFixture {
  raw: string;
  id: string;
  indexed: IndexedTx;
  wallet: Record<string, unknown>;
  input: InputOutpoint;
}

function chainFixture(address: string, nanos: bigint, inputId = randomBytes(32).toString('hex'), change?: { address: string; nanos: bigint }): ChainFixture {
  const outputs = [{ address, nanos }, ...(change ? [change] : [])].map(value => ({ script: addressScript(value.address, 'mainnet'), nanos: value.nanos }));
  const script = outputs[0]!.script;
  const encodedOutputs = outputs.flatMap(output => {
    const amount = Buffer.alloc(8); amount.writeBigUInt64LE(output.nanos / NANOS_PER_ATOM);
    return [amount, Buffer.from([output.script.length / 2]), Buffer.from(output.script, 'hex')];
  });
  const raw = Buffer.concat([
    Buffer.from('0200000001', 'hex'), Buffer.from(inputId, 'hex').reverse(),
    Buffer.from('000000000151ffffffff', 'hex'), Buffer.from([outputs.length]), ...encodedOutputs, Buffer.alloc(4),
  ]).toString('hex');
  const id = transactionId(raw);
  const indexed: IndexedTx = {
    txid: id, version: 2, lockTime: 0, timeFirstSeen: 1, size: raw.length / 2,
    isCoinbase: false, isFinal: true,
    block: { height: 100, hash: blockHash, timestamp: 1 },
    tokenStatus: 'TOKEN_STATUS_NON_TOKEN', tokenEntries: [], tokenFailedParsings: [],
    inputs: [{ prevOut: { txid: inputId, outIdx: 0 }, inputScript: '51', outputScript: script, sats: nanos / NANOS_PER_ATOM + 100n, sequenceNo: 0xffffffff }],
    outputs: outputs.map(output => ({ sats: output.nanos / NANOS_PER_ATOM, outputScript: output.script })),
  };
  return {
    raw, id, indexed, input: { txid: inputId, vout: 0 },
    wallet: {
      hex: raw, confirmations: '2', blockhash: blockHash, abandoned: false, walletconflicts: [],
      decoded: {
        txid: id, vin: [{ txid: inputId, vout: '0' }],
        vout: outputs.map((output, index) => ({ n: index.toString(), value: nanosToXec(output.nanos), scriptPubKey: { hex: output.script } })),
      },
    },
  };
}

interface Harness {
  payments: Payments;
  wallets: Map<string, Record<string, unknown>>;
  indexed: Map<string, IndexedTx>;
  calls: { method: string; params: unknown[] }[];
  state: { chain: string; tokenIndex: boolean; finalized: boolean; broadcastFails: boolean; ownsWallet: boolean; transactionUnavailable: boolean; history: string[]; spendable: unknown[] };
}

interface TestInternals {
  rpc: { call(method: string, params?: unknown[]): Promise<unknown> };
  gateways: unknown[];
  processWithdrawal(client: Tx, row: Record<string, unknown>): Promise<void>;
  restoreInputLocks(client: Tx): Promise<void>;
}

function harness(db: Db): Harness {
  const config = readPaymentsConfig({
    ABC_RPC_USERNAME: 'integration-test', ABC_RPC_PASSWORD: 'integration-test-only',
    XEC_NETWORK: 'mainnet', XEC_CONFIRMATIONS: '2', XEC_MAX_FEE_NANOS: (10n * XEC).toString(),
  });
  const payments = new Payments(db, config);
  const wallets = new Map<string, Record<string, unknown>>(), indexed = new Map<string, IndexedTx>();
  const calls: Harness['calls'] = [];
  const state: Harness['state'] = { chain: 'main', tokenIndex: true, finalized: true, broadcastFails: true, ownsWallet: true, transactionUnavailable: false, history: [], spendable: [] };
  const probe: IndexedTx = {
    ...chainFixture(encodeCashAddress('ecash', 'p2pkh', '01'.repeat(20)), 546n * NANOS_PER_ATOM).indexed,
    txid: tokenId, tokenStatus: 'TOKEN_STATUS_NORMAL',
    outputs: [{ sats: 546n, outputScript: `76a914${'01'.repeat(20)}88ac`, token: {
      tokenId, tokenType: { protocol: 'ALP', type: 'ALP_TOKEN_TYPE_STANDARD', number: 0 }, atoms: 0n, isMintBaton: true,
    } }],
    tokenEntries: [{ tokenId, tokenType: { protocol: 'ALP', type: 'ALP_TOKEN_TYPE_STANDARD', number: 0 }, txType: 'GENESIS',
      isInvalid: false, burnSummary: '', failedColorings: [], actualBurnAtoms: 0n, intentionalBurnAtoms: 0n, burnsMintBatons: false }],
  };
  const gateway = {
    tx: async (id: string): Promise<IndexedTx> => {
      if (id === tokenId && state.tokenIndex) return probe;
      const value = indexed.get(id); if (!value) throw new ChronikHttpError(404); return value;
    },
    client: {
      token: async () => {
        if (!state.tokenIndex) throw new ChronikHttpError(404);
        return { tokenId, tokenType: { protocol: 'ALP' }, genesisInfo: { decimals: 4 } };
      },
      blockchainInfo: async () => ({ tipHash: blockHash, tipHeight: 100 }),
      block: async () => ({ blockInfo: { hash: genesisHash } }),
      validateRawTx: async (hex: string) => {
        const value = indexed.get(transactionId(hex));
        if (!value) throw new ChronikHttpError(404); return value;
      },
    },
  };
  const internals = payments as unknown as TestInternals;
  internals.gateways = [gateway];
  internals.rpc = { call: async (method, params = []) => {
    calls.push({ method, params });
    switch (method) {
      case 'getcurrencyinfo': return { ticker: 'XEC', satoshisperunit: '100', decimals: '2' };
      case 'getblockchaininfo': return { chain: state.chain, blocks: '100', headers: '100', initialblockdownload: false };
      case 'getwalletinfo': return { walletname: 'zoko', private_keys_enabled: true, scanning: false };
      case 'getnetworkinfo': return { subversion: '/Bitcoin ABC:0.31.0/', connections: '8' };
      case 'getnewaddress': return encodeCashAddress('ecash', 'p2pkh', '98'.repeat(20));
      case 'getaddressinfo': return { ismine: state.ownsWallet };
      case 'getavalancheinfo': return { ready_to_poll: true };
      case 'getblockhash': return params[0] === 0 ? genesisHash : blockHash;
      case 'gettransaction': {
        if (state.transactionUnavailable) throw new PaymentError('wallet_rpc_unavailable', 'Controlled transient transaction lookup failure');
        const value = wallets.get(String(params[0])); if (!value) throw new RpcError(-5, method); return value;
      }
      case 'isfinaltransaction': return state.finalized;
      case 'listsinceblock': return { transactions: state.history.map(txid => ({ txid })), removed: [], lastblock: blockHash };
      case 'listlockunspent': return [];
      case 'gettxout': return indexed.has(String(params[0])) ? { value: '1.00' } : null;
      case 'lockunspent': return true;
      case 'listunspent': return state.spendable;
      case 'sendrawtransaction': {
        if (state.broadcastFails) throw new PaymentError('wallet_rpc_unavailable', 'Controlled unknown broadcast result');
        return transactionId(String(params[0]));
      }
      default: throw new Error(`Unexpected RPC method in controlled integration scenario: ${method}`);
    }
  } };
  return { payments, wallets, indexed, calls, state };
}

function isPaymentError(code: string) { return (error: unknown) => error instanceof PaymentError && error.code === code; }

describe('Payment persistence and chain-evidence invariants with real PostgreSQL', {
  skip: databaseUrl ? false : 'Set TEST_DATABASE_URL to test real payment persistence, races, and recovery.',
  concurrency: false, timeout: 120_000,
}, () => {
  const schema = `zoko_payments_${randomUUID().replaceAll('-', '')}`;
  let control: pg.Pool, db: Db;

  before(async () => {
    assert.ok(databaseUrl);
    control = new pg.Pool({ connectionString: databaseUrl, max: 1, connectionTimeoutMillis: 5000 });
    await control.query(`CREATE SCHEMA ${schema}`);
    db = new pg.Pool({ connectionString: databaseUrl, options: `-c search_path=${schema} -c timezone=UTC`,
      max: 20, connectionTimeoutMillis: 5000, statement_timeout: 15000, application_name: schema });
    await migrate(db);
  });
  after(async () => {
    if (db) await db.end();
    if (control) { try { await control.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`); } finally { await control.end(); } }
  });
  afterEach(async () => {
    if (db) { const audit = await auditLedger(db) as { ok: boolean }; assert.equal(audit.ok, true, JSON.stringify(audit)); }
  });

  async function account(balance = 0n) {
    const created = await createAccount(db, { name: 'Payment integration account', dailyLimitNanos: '0', maxPriceNanos: '0' });
    const address = encodeCashAddress('ecash', 'p2pkh', randomBytes(20).toString('hex'));
    await db.query('UPDATE accounts SET deposit_address=$2 WHERE id=$1', [created.id, address]);
    if (balance > 0n) await transaction(db, tx => transfer(tx, `integration-fund:${created.id}`, 'external', `available:${created.id}`, balance));
    return { ...created, address };
  }
  async function balance(id: string) {
    const result = await db.query<{ id: string; balance: string }>('SELECT id,balance::text FROM wallets WHERE id=ANY($1::text[])', [[`available:${id}`, `reserved:${id}`]]);
    return {
      available: BigInt(result.rows.find(row => row.id === `available:${id}`)!.balance),
      reserved: BigInt(result.rows.find(row => row.id === `reserved:${id}`)!.balance),
    };
  }
  function addChain(h: Harness, value: ChainFixture) { h.wallets.set(value.id, value.wallet); h.indexed.set(value.id, value.indexed); }
  async function withdrawalRow(id: string) {
    const result = await db.query('SELECT * FROM payments_withdrawals WHERE id=$1', [id]); return result.rows[0] as Record<string, unknown>;
  }
  async function process(h: Harness, id: string) {
    const client = await db.connect();
    try { await (h.payments as unknown as TestInternals).processWithdrawal(client, await withdrawalRow(id)); }
    finally { client.release(); }
  }
  async function signedWithdrawal(h: Harness, owner: { id: string; address: string }, key = randomUUID()) {
    const recipient = encodeCashAddress('ecash', 'p2pkh', randomBytes(20).toString('hex'));
    const source = chainFixture(owner.address, 40n * XEC);
    const payout = chainFixture(recipient, 30n * XEC, source.id, {
      address: encodeCashAddress('ecash', 'p2pkh', randomBytes(20).toString('hex')), nanos: 9n * XEC,
    });
    payout.indexed.inputs[0]!.sats = source.indexed.outputs[0]!.sats;
    payout.indexed.inputs[0]!.outputScript = source.indexed.outputs[0]!.outputScript;
    h.indexed.set(source.id, source.indexed); h.indexed.set(payout.id, payout.indexed);
    const response = await h.payments.requestWithdrawal(owner.id, recipient, (30n * XEC).toString(), key) as { id: string };
    await db.query(`UPDATE payments_withdrawals SET status='signed',signed_hex=$2,funded_hex=$2,txid=$3,
      input_outpoints=$4,fee_nanos=$5 WHERE id=$1`, [response.id, payout.raw, payout.id, JSON.stringify([{ txid: source.id, vout: 0 }]), (1n * XEC).toString()]);
    return { id: response.id, payout, source };
  }

  test('simultaneous deposit claims create one credit per owned outpoint', async () => {
    const h = harness(db), owner = await account(), deposit = chainFixture(owner.address, 100n * XEC);
    addChain(h, deposit);
    await Promise.all(Array.from({ length: 12 }, () => h.payments.claimDeposit(owner.id, deposit.id)));
    assert.deepEqual(await balance(owner.id), { available: 100n * XEC, reserved: 0n });
    const entries = await db.query('SELECT count(*)::integer AS count FROM transfers WHERE reference=$1', [`deposit:mainnet:${deposit.id}:0`]);
    assert.equal(entries.rows[0].count, 1);
  });

  test('a foreign transaction claim cannot queue or credit another account\'s deposit', async () => {
    const h = harness(db), owner = await account(), claimant = await account(), deposit = chainFixture(owner.address, 50n * XEC);
    addChain(h, deposit);
    await assert.rejects(h.payments.claimDeposit(claimant.id, deposit.id), isPaymentError('deposit_not_owned'));
    assert.deepEqual(await balance(owner.id), { available: 0n, reserved: 0n });
    assert.deepEqual(await balance(claimant.id), { available: 0n, reserved: 0n });
    assert.equal((await db.query('SELECT txid FROM payments_deposit_txs WHERE txid=$1', [deposit.id])).rowCount, 0);
    await h.payments.claimDeposit(owner.id, deposit.id);
    assert.deepEqual(await balance(owner.id), { available: 50n * XEC, reserved: 0n });
  });

  test('foreign claims during a wallet outage cannot disable a credited depositor', async () => {
    const h = harness(db), owner = await account(), claimant = await account(), deposit = chainFixture(owner.address, 50n * XEC);
    addChain(h, deposit); await h.payments.claimDeposit(owner.id, deposit.id);
    h.state.transactionUnavailable = true; h.calls.length = 0;
    await assert.rejects(h.payments.claimDeposit(claimant.id, deposit.id), isPaymentError('deposit_not_owned'));
    assert.equal((await db.query('SELECT disabled FROM accounts WHERE id=$1', [owner.id])).rows[0].disabled, false);
    assert.equal(h.calls.some(call => call.method === 'gettransaction'), false);
    assert.deepEqual(await balance(owner.id), { available: 50n * XEC, reserved: 0n });
  });

  test('confirmation and dual-source Avalanche finality gates must all pass before credit', async () => {
    const h = harness(db), owner = await account(), deposit = chainFixture(owner.address, 20n * XEC);
    addChain(h, deposit); deposit.wallet.confirmations = '1';
    await h.payments.claimDeposit(owner.id, deposit.id);
    deposit.wallet.confirmations = '2'; deposit.indexed.isFinal = false;
    await h.payments.claimDeposit(owner.id, deposit.id);
    deposit.indexed.isFinal = true; h.state.finalized = false;
    await h.payments.claimDeposit(owner.id, deposit.id);
    assert.deepEqual(await balance(owner.id), { available: 0n, reserved: 0n });
    h.state.finalized = true;
    await h.payments.claimDeposit(owner.id, deposit.id);
    assert.deepEqual(await balance(owner.id), { available: 20n * XEC, reserved: 0n });
  });

  test('zero-quantity token mint batons do not receive native-XEC credits', async () => {
    const h = harness(db), owner = await account(), deposit = chainFixture(owner.address, 10n * XEC);
    deposit.indexed.outputs[0]!.token = { tokenId, tokenType: { protocol: 'ALP', type: 'ALP_TOKEN_TYPE_STANDARD', number: 0 }, atoms: 0n, isMintBaton: true };
    addChain(h, deposit);
    await h.payments.claimDeposit(owner.id, deposit.id);
    assert.deepEqual(await balance(owner.id), { available: 0n, reserved: 0n });
    const row = await db.query('SELECT status FROM payments_deposits WHERE txid=$1', [deposit.id]);
    assert.equal(row.rows[0].status, 'unsupported');
  });

  test('wrong node network and a disabled token index fail before deposit accounting', async () => {
    const h = harness(db), owner = await account(), deposit = chainFixture(owner.address, 10n * XEC);
    addChain(h, deposit); h.state.chain = 'test';
    await assert.rejects(h.payments.claimDeposit(owner.id, deposit.id), isPaymentError('wrong_network'));
    h.state.chain = 'main'; h.state.tokenIndex = false;
    await assert.rejects(h.payments.claimDeposit(owner.id, deposit.id), ChronikHttpError);
    assert.deepEqual(await balance(owner.id), { available: 0n, reserved: 0n });
  });

  test('a credited transaction removed by a conflict quarantines the account without erasing history', async () => {
    const h = harness(db), owner = await account(), deposit = chainFixture(owner.address, 100n * XEC);
    addChain(h, deposit); await h.payments.claimDeposit(owner.id, deposit.id);
    deposit.wallet.confirmations = '-1'; h.indexed.delete(deposit.id);
    await h.payments.claimDeposit(owner.id, deposit.id);
    const result = await db.query('SELECT a.disabled,d.status FROM accounts a JOIN payments_deposits d ON d.account_id=a.id WHERE a.id=$1', [owner.id]);
    assert.deepEqual(result.rows, [{ disabled: true, status: 'reorg_review' }]);
    assert.deepEqual(await balance(owner.id), { available: 100n * XEC, reserved: 0n });
    await assert.rejects(h.payments.requestWithdrawal(owner.id, owner.address, (10n * XEC).toString(), randomUUID()), isPaymentError('account_disabled'));
  });

  test('loss of previously required finality quarantines credited funds even while the block remains present', async () => {
    const h = harness(db), owner = await account(), deposit = chainFixture(owner.address, 100n * XEC);
    addChain(h, deposit); await h.payments.claimDeposit(owner.id, deposit.id);
    h.state.finalized = false;
    await h.payments.claimDeposit(owner.id, deposit.id);
    const result = await db.query('SELECT a.disabled,d.status FROM accounts a JOIN payments_deposits d ON d.account_id=a.id WHERE a.id=$1', [owner.id]);
    assert.deepEqual(result.rows, [{ disabled: true, status: 'reorg_review' }]);
    assert.deepEqual(await balance(owner.id), { available: 100n * XEC, reserved: 0n });
  });

  test('reorg quarantine stops an already-queued unsigned withdrawal before selecting inputs', async () => {
    const h = harness(db), owner = await account(), deposit = chainFixture(owner.address, 100n * XEC);
    addChain(h, deposit); await h.payments.claimDeposit(owner.id, deposit.id);
    const request = await h.payments.requestWithdrawal(owner.id, owner.address, (30n * XEC).toString(), randomUUID()) as { id: string };
    deposit.wallet.confirmations = '-1'; h.indexed.delete(deposit.id);
    await h.payments.claimDeposit(owner.id, deposit.id);
    h.calls.length = 0;
    await process(h, request.id);
    assert.equal(h.calls.some(call => ['listunspent', 'createrawtransaction', 'signrawtransactionwithwallet', 'sendrawtransaction'].includes(call.method)), false);
    assert.equal((await withdrawalRow(request.id)).signed_hex, null);
  });

  test('withdrawal idempotency serializes concurrent requests and binds amount and recipient', async () => {
    const h = harness(db), owner = await account(100n * XEC), key = randomUUID();
    const requests = await Promise.all(Array.from({ length: 12 }, () => h.payments.requestWithdrawal(owner.id, owner.address, (30n * XEC).toString(), key) as Promise<{ id: string }>));
    assert.equal(new Set(requests.map(value => value.id)).size, 1);
    assert.deepEqual(await balance(owner.id), { available: 60n * XEC, reserved: 40n * XEC });
    await assert.rejects(h.payments.requestWithdrawal(owner.id, owner.address, (31n * XEC).toString(), key), isPaymentError('idempotency_conflict'));
  });

  test('replacing the dedicated wallet with an unrelated wallet of the same name fails ownership preflight', async () => {
    const h = harness(db), owner = await account(100n * XEC);
    await h.payments.requestWithdrawal(owner.id, owner.address, (30n * XEC).toString(), randomUUID());
    h.state.ownsWallet = false;
    await assert.rejects(h.payments.preflight(), isPaymentError('wallet_binding_mismatch'));
    assert.equal(h.payments.status().ready, false);
  });

  test('unknown broadcasts preserve signed bytes and reservation across retries and restart', async () => {
    const h = harness(db), owner = await account(100n * XEC), payout = await signedWithdrawal(h, owner);
    await process(h, payout.id); await process(h, payout.id);
    const row = await withdrawalRow(payout.id);
    assert.equal(row.status, 'signed'); assert.equal(row.signed_hex, payout.payout.raw); assert.equal(row.txid, payout.payout.id);
    assert.equal(row.broadcast_attempts, 2);
    assert.deepEqual(await balance(owner.id), { available: 60n * XEC, reserved: 40n * XEC });
    const resumed = harness(db);
    resumed.indexed.set(payout.source.id, payout.source.indexed); resumed.indexed.set(payout.payout.id, payout.payout.indexed);
    await resumed.payments.preflight(); await process(resumed, payout.id);
    const allCalls = [...h.calls, ...resumed.calls];
    assert.equal(allCalls.filter(call => call.method === 'sendrawtransaction').length, 3);
    assert.ok(allCalls.filter(call => call.method === 'sendrawtransaction').every(call => call.params[0] === payout.payout.raw));
    assert.equal(allCalls.some(call => ['createrawtransaction', 'fundrawtransaction', 'signrawtransactionwithwallet'].includes(call.method)), false);
    assert.deepEqual(await balance(owner.id), { available: 60n * XEC, reserved: 40n * XEC });
  });

  test('confirmed payout settles once and releases only unused fee reserve', async () => {
    const h = harness(db), owner = await account(100n * XEC), payout = await signedWithdrawal(h, owner);
    h.wallets.set(payout.payout.id, payout.payout.wallet);
    await process(h, payout.id); await process(h, payout.id);
    assert.equal((await withdrawalRow(payout.id)).status, 'settled');
    assert.deepEqual(await balance(owner.id), { available: 69n * XEC, reserved: 0n });
    const journal = await db.query('SELECT reference FROM transfers WHERE reference=ANY($1::text[])', [[`withdrawal-settlement:${payout.id}`, `withdrawal-fee-refund:${payout.id}`]]);
    assert.equal(journal.rowCount, 2);
    assert.equal(h.calls.some(call => call.method === 'sendrawtransaction'), false);
  });

  test('conflicted signed payout remains reserved in manual review and never automatically refunds', async () => {
    const h = harness(db), owner = await account(100n * XEC), payout = await signedWithdrawal(h, owner);
    payout.payout.wallet.confirmations = '-1'; h.wallets.set(payout.payout.id, payout.payout.wallet);
    await process(h, payout.id);
    assert.equal((await withdrawalRow(payout.id)).status, 'manual_review');
    assert.deepEqual(await balance(owner.id), { available: 60n * XEC, reserved: 40n * XEC });
    assert.equal(h.calls.some(call => call.method === 'sendrawtransaction'), false);
  });

  test('account quarantine holds an unbroadcast signed payout without refund or broadcast', async () => {
    const h = harness(db), owner = await account(100n * XEC), payout = await signedWithdrawal(h, owner);
    await db.query('UPDATE accounts SET disabled=true WHERE id=$1', [owner.id]);
    await process(h, payout.id);
    assert.equal((await withdrawalRow(payout.id)).status, 'manual_review');
    assert.deepEqual(await balance(owner.id), { available: 60n * XEC, reserved: 40n * XEC });
    assert.equal(h.calls.some(call => call.method === 'sendrawtransaction'), false);
  });

  test('failed unsigned withdrawal refunds once and restart restores signed input locks', async () => {
    const h = harness(db), owner = await account(100n * XEC);
    const request = await h.payments.requestWithdrawal(owner.id, owner.address, (30n * XEC).toString(), randomUUID()) as { id: string };
    await process(h, request.id); await process(h, request.id);
    assert.equal((await withdrawalRow(request.id)).status, 'failed');
    assert.deepEqual(await balance(owner.id), { available: 100n * XEC, reserved: 0n });
    const payout = await signedWithdrawal(h, owner);
    const client = await db.connect();
    try { await (h.payments as unknown as TestInternals).restoreInputLocks(client); } finally { client.release(); }
    assert.ok(h.calls.some(call => call.method === 'lockunspent' && call.params[0] === false && JSON.stringify(call.params[1]) === JSON.stringify([{ txid: payout.source.id, vout: 0 }])));
  });

  test('transient revalidation failure preserves account access and credit while pausing queued payouts', async () => {
    const h = harness(db), owner = await account(), deposit = chainFixture(owner.address, 100n * XEC);
    addChain(h, deposit); await h.payments.claimDeposit(owner.id, deposit.id);
    const request = await h.payments.requestWithdrawal(owner.id, owner.address, (30n * XEC).toString(), randomUUID()) as { id: string };
    // Other cases have independent chain adapters; isolate this worker's queue
    // without touching any ledger history or previously asserted balances.
    await db.query('UPDATE payments_deposit_txs SET pending=false WHERE txid<>$1', [deposit.id]);
    h.state.transactionUnavailable = true;
    await assert.rejects(h.payments.claimDeposit(owner.id, deposit.id), isPaymentError('wallet_rpc_unavailable'));
    h.calls.length = 0;
    try { await h.payments.sync(); } catch (error) { assert.ok(error instanceof PaymentError); }
    const ownerRow = await db.query('SELECT disabled FROM accounts WHERE id=$1', [owner.id]);
    assert.equal(ownerRow.rows[0].disabled, false);
    assert.equal((await db.query('SELECT pending FROM payments_deposit_txs WHERE txid=$1', [deposit.id])).rows[0].pending, true);
    assert.equal((await db.query('SELECT status FROM payments_deposits WHERE txid=$1', [deposit.id])).rows[0].status, 'credited');
    assert.equal((await withdrawalRow(request.id)).status, 'requested');
    assert.equal(h.calls.some(call => ['listunspent', 'signrawtransactionwithwallet', 'sendrawtransaction'].includes(call.method)), false);
    assert.deepEqual(await balance(owner.id), { available: 60n * XEC, reserved: 40n * XEC });
  });
});
