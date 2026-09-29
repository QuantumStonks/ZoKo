import assert from 'node:assert/strict';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { after, afterEach, before, beforeEach, describe, test } from 'node:test';
import pg from 'pg';
import { encodeCashAddress } from 'ecashaddrjs';
import type { Tx as IndexedTx } from 'chronik-client';
import { ALL_BIP143, Ecc, Script, Tx as EcashTx, UnsignedTx, sha256d, shaRmd160, toHexRev } from 'ecash-lib';
import { auditLedger, createAccount, transaction, transfer, type Db, type Tx } from '../src/db.js';
import { migrate } from '../src/migration.js';
import { Payments, readPaymentsConfig } from '../src/payments/index.js';
import { ChronikHttpError } from '../src/payments/chronik.js';
import { MAINNET_GENESIS, networkCheckpoints } from '../src/payments/config.js';
import { NANOS_PER_ATOM, PaymentError } from '../src/payments/money.js';
import { addressScript } from '../src/payments/verification.js';
import { ProgrammaticWallet, decodeTransaction, type WalletInput } from '../src/payments/wallet.js';

/**
 * Real PostgreSQL owns every lock, journal entry, identity, cursor, and retry.
 * Only external Chronik evidence is controlled in this file. Deposits and payouts
 * use actual ecash-lib serialization and Schnorr signatures. The synthetic chain
 * has no real money and does not stand in for a public-network consensus test.
 */
const databaseUrl = process.env.TEST_DATABASE_URL;
const XEC = 1_000_000_000n;
const seed = createHash('sha256').update('Zoko public integration wallet seed; never fund').digest('hex');
const otherSeed = createHash('sha256').update('Zoko public replacement wallet seed; never fund').digest('hex');
const externalWallet = new ProgrammaticWallet(createHash('sha256').update('Zoko public external payer seed; never fund').digest('hex'), 'mainnet');
const tokenId = 'cdcdcdcdcdc9dda4c92bb1145aa84945c024346ea66fd4b699e344e45df2e145';
const tokenType = { protocol: 'ALP', type: 'ALP_TOKEN_TYPE_STANDARD', number: 0 } as const;
const recipient = encodeCashAddress('ecash', 'p2pkh', '24'.repeat(20));
const blockHash = (height: number) => createHash('sha256').update(`Zoko controlled block ${height}`).digest('hex');
const outpointKey = (txid: string, vout: number) => `${txid}:${vout}`;

type PreviousOutput = { sats: bigint; outputScript: string };
interface ChainFixture { raw: string; id: string; indexed: IndexedTx }
interface ChainState {
  indexed: Map<string, IndexedTx>;
  raw: Map<string, string>;
  previousOutputs: Map<string, PreviousOutput>;
  history: Map<string, string[]>;
  unconfirmed: Map<string, string[]>;
  historyFailures: Set<string>;
  txFailures: Set<string>;
  rawFailures: Set<string>;
  hashes: Map<number, string>;
  genesis: string;
  checkpointValid: boolean;
  tipHeight: number;
  tokenIndex: boolean;
  broadcastMode: 'timeout' | 'accept' | 'accept_then_timeout';
  validationFails: boolean;
  validationObserver?: (raw: string) => Promise<void>;
  broadcastObserver?: (raw: string) => Promise<void>;
}
interface Harness {
  payments: Payments;
  chain: ChainState;
  calls: { method: string; args: unknown[] }[];
  signatures: { count: number };
}
interface TestInternals {
  gateways: unknown[];
  wallet: ProgrammaticWallet;
  processWithdrawal(client: Tx, row: Record<string, unknown>): Promise<void>;
  buildWithdrawal(client: Tx, row: Record<string, unknown>): Promise<Record<string, unknown>>;
  syncWalletHistory(client: Tx): Promise<void>;
}

function chainState(): ChainState {
  return {
    indexed: new Map(), raw: new Map(), previousOutputs: new Map(), history: new Map(), unconfirmed: new Map(),
    historyFailures: new Set(), txFailures: new Set(), rawFailures: new Set(), hashes: new Map(),
    genesis: MAINNET_GENESIS, checkpointValid: true, tipHeight: 900_000, tokenIndex: true, broadcastMode: 'timeout', validationFails: false,
  };
}
function controlledHash(chain: ChainState, height: number): string {
  if (height === 0) return chain.genesis;
  if (height === networkCheckpoints.mainnet!.height) return chain.checkpointValid ? networkCheckpoints.mainnet!.hash : 'ff'.repeat(32);
  return chain.hashes.get(height) ?? blockHash(height);
}
function previousOutput(chain: ChainState, txid: string, vout: number): PreviousOutput {
  const output = chain.indexed.get(txid)?.outputs[vout] ?? chain.previousOutputs.get(outpointKey(txid, vout));
  assert.ok(output, `Controlled chain must contain input ${txid}:${vout}`);
  return { sats: output.sats, outputScript: output.outputScript };
}

/** Decode genuine bytes, then verify each signature independently at the wire boundary. */
function verifySignedBytes(chain: ChainState, raw: string): void {
  const parsed = EcashTx.fromHex(raw);
  for (const input of parsed.inputs) {
    const inputId = typeof input.prevOut.txid === 'string' ? input.prevOut.txid : toHexRev(input.prevOut.txid);
    const prev = previousOutput(chain, inputId, input.prevOut.outIdx);
    input.signData = { sats: prev.sats, outputScript: new Script(Buffer.from(prev.outputScript, 'hex')) };
  }
  const unsigned = UnsignedTx.fromTx(parsed), ecc = new Ecc();
  parsed.inputs.forEach((input, index) => {
    const script = input.script!.bytecode;
    assert.equal(script.length, 100);
    assert.equal(script[0], 65);
    assert.equal(script[65], 0x41); // SIGHASH_ALL | FORKID
    assert.equal(script[66], 33);
    const pubkey = script.subarray(67);
    assert.equal(Script.p2pkh(shaRmd160(pubkey)).toHex(), input.signData!.outputScript!.toHex());
    assert.doesNotThrow(() => ecc.schnorrVerify(script.subarray(1, 65), sha256d(unsigned.inputAt(index).sigHashPreimage(ALL_BIP143).bytes), pubkey));
  });
}
function indexedFromRaw(chain: ChainState, raw: string, height?: number): IndexedTx {
  const tx = EcashTx.fromHex(raw), decoded = decodeTransaction(raw);
  return {
    txid: decoded.txid, version: tx.version, lockTime: tx.locktime, timeFirstSeen: 1, size: decoded.size,
    isCoinbase: false, isFinal: height !== undefined,
    ...(height === undefined ? {} : { block: { height, hash: controlledHash(chain, height), timestamp: 1 } }),
    tokenStatus: 'TOKEN_STATUS_NON_TOKEN', tokenEntries: [], tokenFailedParsings: [],
    inputs: tx.inputs.map((input, index) => {
      const prev = decoded.inputs[index]!;
      return { prevOut: { txid: prev.txid, outIdx: prev.vout }, inputScript: input.script!.toHex(),
        ...previousOutput(chain, prev.txid, prev.vout), sequenceNo: input.sequence ?? 0xffffffff };
    }),
    outputs: tx.outputs.map(output => ({ sats: output.sats, outputScript: output.script.toHex() })),
  };
}
function deposit(chain: ChainState, address: string, nanos: bigint, height = chain.tipHeight - 1): ChainFixture {
  const input: WalletInput = { txid: randomBytes(32).toString('hex'), vout: 0, sats: nanos / NANOS_PER_ATOM + 20_000n, branch: 0, index: 0 };
  chain.previousOutputs.set(outpointKey(input.txid, input.vout), { sats: input.sats, outputScript: externalWallet.derive(0, 0).outputScript });
  const signed = externalWallet.buildWithdrawal({ inputs: [input], recipientAddress: address, recipientSats: nanos / NANOS_PER_ATOM,
    changeIndex: 0, feeRateSatsPerKb: 1000n, maxFeeSats: 10_000n, maxFeeRateSatsPerKb: 10_000n });
  verifySignedBytes(chain, signed.hex);
  const indexed = indexedFromRaw(chain, signed.hex, height);
  chain.indexed.set(signed.txid, indexed); chain.raw.set(signed.txid, signed.hex);
  return { raw: signed.hex, id: signed.txid, indexed };
}
function publish(chain: ChainState, raw: string, height?: number): ChainFixture {
  verifySignedBytes(chain, raw);
  const indexed = indexedFromRaw(chain, raw, height);
  chain.indexed.set(indexed.txid, indexed); chain.raw.set(indexed.txid, raw);
  indexed.inputs.forEach((input, outIdx) => {
    const source = chain.indexed.get(input.prevOut.txid)?.outputs[input.prevOut.outIdx];
    if (source) source.spentBy = { txid: indexed.txid, outIdx };
  });
  return { raw, id: indexed.txid, indexed };
}
function isPaymentError(code: string) { return (error: unknown) => error instanceof PaymentError && error.code === code; }

function harness(db: Db, chain = chainState(), walletSeed = seed): Harness {
  const payments = new Payments(db, readPaymentsConfig({ XEC_WALLET_SEED_HEX: walletSeed,
    XEC_NETWORK: 'mainnet', XEC_CONFIRMATIONS: '2', XEC_MAX_FEE_NANOS: (10n * XEC).toString() }));
  const calls: Harness['calls'] = [], signatures = { count: 0 };
  const note = (method: string, ...args: unknown[]) => calls.push({ method, args });
  const probe: IndexedTx = {
    txid: tokenId, version: 2, lockTime: 0, timeFirstSeen: 1, size: 192, isCoinbase: false, isFinal: true,
    block: { height: 795_680, hash: controlledHash(chain, 795_680), timestamp: 1 },
    tokenStatus: 'TOKEN_STATUS_NORMAL', tokenFailedParsings: [], inputs: [],
    outputs: [{ sats: 546n, outputScript: addressScript(recipient, 'mainnet'), token: { tokenId, tokenType, atoms: 0n, isMintBaton: true } }],
    tokenEntries: [{ tokenId, tokenType, txType: 'GENESIS', isInvalid: false, burnSummary: '', failedColorings: [],
      actualBurnAtoms: 0n, intentionalBurnAtoms: 0n, burnsMintBatons: false }],
  };
  const getTx = async (id: string): Promise<IndexedTx> => {
    note('tx', id);
    if (chain.txFailures.has(id)) throw new PaymentError('chronik_unavailable', 'Controlled transient Chronik failure');
    if (id === tokenId && chain.tokenIndex) return probe;
    const value = chain.indexed.get(id); if (!value) throw new ChronikHttpError(404); return value;
  };
  const client = {
    tx: getTx,
    blockchainInfo: async () => { note('blockchainInfo'); return { tipHeight: chain.tipHeight, tipHash: controlledHash(chain, chain.tipHeight) }; },
    block: async (height: number) => { note('block', height); return { blockInfo: { hash: controlledHash(chain, height), height, timestamp: Math.floor(Date.now() / 1000) } }; },
    token: async () => {
      note('token'); if (!chain.tokenIndex) throw new ChronikHttpError(404);
      return { tokenId, tokenType, genesisInfo: { decimals: 4 } };
    },
    rawTx: async (id: string) => {
      note('rawTx', id);
      if (chain.rawFailures.has(id)) throw new PaymentError('chronik_unavailable', 'Controlled transient raw transaction failure');
      const rawTx = chain.raw.get(id); if (!rawTx) throw new ChronikHttpError(404); return { rawTx };
    },
    address: (address: string) => ({
      confirmedTxs: async (page = 0, pageSize = 100) => {
        note('confirmedTxs', address, page, pageSize);
        if (chain.historyFailures.has(`${address}:${page}`)) throw new PaymentError('chronik_unavailable', 'Controlled history-page outage');
        const ids = chain.history.get(address) ?? [];
        return { txs: ids.slice(page * pageSize, (page + 1) * pageSize).map(id => {
          const value = chain.indexed.get(id); assert.ok(value, `History refers to missing controlled transaction ${id}`); return value;
        }), numPages: Math.ceil(ids.length / pageSize), numTxs: ids.length };
      },
      unconfirmedTxs: async () => {
        note('unconfirmedTxs', address);
        const ids = chain.unconfirmed.get(address) ?? [];
        return { txs: ids.map(id => chain.indexed.get(id)!), numPages: ids.length ? 1 : 0, numTxs: ids.length };
      },
      utxos: async () => {
        note('utxos', address);
        const outputScript = addressScript(address, 'mainnet');
        const utxos = [...chain.indexed.values()].flatMap(tx => tx.outputs.flatMap((output, outIdx) =>
          output.outputScript === outputScript && !output.spentBy ? [{ outpoint: { txid: tx.txid, outIdx },
            blockHeight: tx.block?.height ?? -1, isCoinbase: tx.isCoinbase, sats: output.sats, isFinal: tx.isFinal,
            ...(output.token ? { token: output.token } : {}) }] : []));
        return { outputScript, utxos };
      },
    }),
    validateRawTx: async (raw: string) => {
      note('validateRawTx', raw); verifySignedBytes(chain, raw); await chain.validationObserver?.(raw);
      if (chain.validationFails) throw new PaymentError('chronik_unavailable', 'Controlled unknown validation result');
      return indexedFromRaw(chain, raw);
    },
    broadcastTx: async (raw: string, skipTokenChecks = false) => {
      note('broadcastTx', raw, skipTokenChecks); assert.equal(skipTokenChecks, false); verifySignedBytes(chain, raw);
      await chain.broadcastObserver?.(raw);
      if (chain.broadcastMode !== 'timeout') publish(chain, raw);
      if (chain.broadcastMode !== 'accept') throw new PaymentError('chronik_unavailable', 'Controlled unknown broadcast result');
      return { txid: decodeTransaction(raw).txid };
    },
  };
  const internals = payments as unknown as TestInternals;
  internals.gateways = [{ url: 'https://chronik-controlled.test', tx: getTx, client }];
  const originalBuild = internals.wallet.buildWithdrawal.bind(internals.wallet);
  internals.wallet.buildWithdrawal = request => { signatures.count++; return originalBuild(request); };
  return { payments, chain, calls, signatures };
}

describe('Programmatic payments: genuine signed bytes and real PostgreSQL persistence', {
  skip: databaseUrl ? false : 'Set TEST_DATABASE_URL to test real payment persistence, races, and recovery.',
  concurrency: false, timeout: 180_000,
}, () => {
  let control: pg.Pool, db: Db, schema: string;
  before(async () => {
    assert.ok(databaseUrl);
    control = new pg.Pool({ connectionString: databaseUrl, max: 1, connectionTimeoutMillis: 5000 });
  });
  beforeEach(async () => {
    schema = `zoko_payments_${randomUUID().replaceAll('-', '')}`;
    await control.query(`CREATE SCHEMA ${schema}`);
    db = new pg.Pool({ connectionString: databaseUrl, options: `-c search_path=${schema} -c timezone=UTC`,
      max: 20, connectionTimeoutMillis: 5000, statement_timeout: 15000, application_name: schema });
    await migrate(db);
  });
  afterEach(async () => {
    if (!db) return;
    try { const audit = await auditLedger(db) as { ok: boolean }; assert.equal(audit.ok, true, JSON.stringify(audit)); }
    finally { await db.end(); await control.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`); }
  });
  after(async () => { if (control) await control.end(); });

  async function account(h: Harness, balance = 0n) {
    const created = await createAccount(db, { name: 'Payment integration account', dailyLimitNanos: '0', maxPriceNanos: '0' });
    const address = await h.payments.provisionAddress(created.id);
    if (balance > 0n) await transaction(db, tx => transfer(tx, `integration-fund:${created.id}`, 'external', `available:${created.id}`, balance));
    return { ...created, address };
  }
  async function balance(id: string) {
    const result = await db.query<{ id: string; balance: string }>('SELECT id,balance::text FROM wallets WHERE id=ANY($1::text[])', [[`available:${id}`, `reserved:${id}`]]);
    return { available: BigInt(result.rows.find(row => row.id === `available:${id}`)!.balance), reserved: BigInt(result.rows.find(row => row.id === `reserved:${id}`)!.balance) };
  }
  async function withdrawalRow(id: string) { return (await db.query('SELECT * FROM payments_withdrawals WHERE id=$1', [id])).rows[0] as Record<string, unknown>; }
  async function process(h: Harness, id: string) {
    await h.payments.preflight(); const client = await db.connect();
    try { await (h.payments as unknown as TestInternals).processWithdrawal(client, await withdrawalRow(id)); }
    finally { client.release(); }
  }
  async function build(h: Harness, id: string) {
    await h.payments.preflight(); const client = await db.connect();
    try { return await (h.payments as unknown as TestInternals).buildWithdrawal(client, await withdrawalRow(id)); }
    finally { client.release(); }
  }
  async function scan(h: Harness) {
    await h.payments.preflight(); const client = await db.connect();
    try { await (h.payments as unknown as TestInternals).syncWalletHistory(client); }
    finally { client.release(); }
  }
  async function due() {
    await db.query("UPDATE payments_address_scans SET next_scan_at=now()-interval '1 second'");
    await db.query("UPDATE payments_deposit_txs SET next_check_at=now()-interval '1 second' WHERE pending");
  }
  async function request(h: Harness, id: string, key = randomUUID()) {
    return await h.payments.requestWithdrawal(id, recipient, (30n * XEC).toString(), key) as { id: string };
  }
  async function preparedPayout(h: Harness) {
    const owner = await account(h, 100n * XEC), source = deposit(h.chain, owner.address, 60n * XEC);
    const withdrawal = await request(h, owner.id);
    const row = await build(h, withdrawal.id);
    assert.equal(row.status, 'signed'); assert.equal(typeof row.signed_hex, 'string');
    verifySignedBytes(h.chain, String(row.signed_hex));
    return { owner, source, id: withdrawal.id, raw: String(row.signed_hex), txid: String(row.txid), fee: BigInt(String(row.fee_nanos)) };
  }
  async function assertCreditOnce(ownerId: string, value: ChainFixture, amount: bigint) {
    assert.equal((await balance(ownerId)).available, amount);
    const entries = await db.query('SELECT count(*)::integer AS count FROM transfers WHERE reference=$1', [`deposit:mainnet:${value.id}:0`]);
    assert.equal(entries.rows[0].count, 1);
  }

  test('concurrent HD allocations are unique, stable across restart, and bound to a persisted public identity', async () => {
    const h = harness(db);
    const owners = await Promise.all(Array.from({ length: 6 }, () => createAccount(db, { name: 'HD allocation', dailyLimitNanos: '0', maxPriceNanos: '0' })));
    const addresses = await Promise.all(owners.flatMap(owner => [h.payments.provisionAddress(owner.id), h.payments.provisionAddress(owner.id)]));
    assert.equal(new Set(addresses).size, owners.length);
    owners.forEach((_, index) => assert.equal(addresses[index * 2], addresses[index * 2 + 1]));
    const rows = await db.query('SELECT address,branch,derivation_index,account_id FROM payments_addresses ORDER BY derivation_index');
    assert.equal(rows.rowCount, owners.length);
    const wallet = new ProgrammaticWallet(seed, 'mainnet');
    for (const row of rows.rows) { assert.equal(row.branch, 0); assert.equal(row.address, wallet.derive(0, row.derivation_index).address); }
    const identity = (await db.query("SELECT value FROM payments_state WHERE key='wallet-identity'")).rows[0].value;
    assert.deepEqual(identity, { backend: 'programmatic', version: 1, network: 'mainnet', fingerprint: wallet.fingerprint, genesis: MAINNET_GENESIS });
    assert.doesNotMatch(JSON.stringify(identity), new RegExp(seed));
    const resumed = harness(db, h.chain);
    assert.equal(await resumed.payments.provisionAddress(owners[0]!.id), addresses[0]);
    assert.equal(new Set([...addresses, (await account(resumed)).address]).size, owners.length + 1);
  });

  test('simultaneous deposit claims credit one genuine owned outpoint exactly once', async () => {
    const h = harness(db), owner = await account(h), value = deposit(h.chain, owner.address, 100n * XEC);
    await Promise.all(Array.from({ length: 12 }, () => h.payments.claimDeposit(owner.id, value.id)));
    await assertCreditOnce(owner.id, value, 100n * XEC);
    assert.equal((await balance(owner.id)).reserved, 0n);
  });

  test('a concurrent payout and deposit allocation persist distinct change and deposit derivation indexes', async () => {
    const h = harness(db), owner = await account(h, 100n * XEC);
    deposit(h.chain, owner.address, 60n * XEC); const withdrawal = await request(h, owner.id);
    await Promise.all([build(h, withdrawal.id), ...Array.from({ length: 8 }, () => account(h))]);
    const rows = (await db.query('SELECT address,branch,derivation_index,account_id FROM payments_addresses')).rows;
    assert.equal(rows.length, 10); assert.equal(new Set(rows.map(row => row.address)).size, 10);
    assert.equal(new Set(rows.map(row => `${row.branch}:${row.derivation_index}`)).size, 10);
    const change = rows.filter(row => row.branch === 1);
    assert.equal(change.length, 1); assert.equal(change[0]!.account_id, null);
    assert.equal(change[0]!.address, new ProgrammaticWallet(seed, 'mainnet').derive(1, 0).address);
    assert.equal((await withdrawalRow(withdrawal.id)).change_address, change[0]!.address);
  });

  test('a hostile Cashtab transaction claim cannot queue or credit another account\'s historical output', async () => {
    const h = harness(db), owner = await account(h), claimant = await account(h), value = deposit(h.chain, owner.address, 50n * XEC);
    value.indexed.outputs[0]!.spentBy = { txid: 'ad'.repeat(32), outIdx: 0 };
    await assert.rejects(h.payments.claimDeposit(claimant.id, value.id), isPaymentError('deposit_not_owned'));
    assert.deepEqual(await balance(owner.id), { available: 0n, reserved: 0n });
    assert.deepEqual(await balance(claimant.id), { available: 0n, reserved: 0n });
    assert.equal((await db.query('SELECT txid FROM payments_deposit_txs WHERE txid=$1', [value.id])).rowCount, 0);
    await h.payments.claimDeposit(owner.id, value.id);
    await assertCreditOnce(owner.id, value, 50n * XEC);
  });

  test('foreign claims during an upstream outage cannot disable a credited depositor', async () => {
    const h = harness(db), owner = await account(h), claimant = await account(h), value = deposit(h.chain, owner.address, 50n * XEC);
    await h.payments.claimDeposit(owner.id, value.id);
    h.chain.rawFailures.add(value.id); h.calls.length = 0;
    await assert.rejects(h.payments.claimDeposit(claimant.id, value.id), isPaymentError('deposit_not_owned'));
    assert.equal((await db.query('SELECT disabled FROM accounts WHERE id=$1', [owner.id])).rows[0].disabled, false);
    assert.equal(h.calls.some(call => call.method === 'rawTx'), false);
    await assertCreditOnce(owner.id, value, 50n * XEC);
  });

  test('confirmation depth and Chronik Avalanche finality both gate credit', async () => {
    const h = harness(db), owner = await account(h), value = deposit(h.chain, owner.address, 20n * XEC, h.chain.tipHeight);
    await h.payments.claimDeposit(owner.id, value.id);
    assert.equal((await balance(owner.id)).available, 0n);
    h.chain.tipHeight++; value.indexed.isFinal = false;
    await h.payments.claimDeposit(owner.id, value.id);
    assert.equal((await balance(owner.id)).available, 0n);
    value.indexed.isFinal = true;
    await h.payments.claimDeposit(owner.id, value.id);
    await assertCreditOnce(owner.id, value, 20n * XEC);
  });

  test('zero-quantity token mint batons never receive native-XEC credits', async () => {
    const h = harness(db), owner = await account(h), value = deposit(h.chain, owner.address, 10n * XEC);
    value.indexed.outputs[0]!.token = { tokenId, tokenType, atoms: 0n, isMintBaton: true };
    await h.payments.claimDeposit(owner.id, value.id);
    assert.equal((await balance(owner.id)).available, 0n);
    assert.equal((await db.query('SELECT status FROM payments_deposits WHERE txid=$1', [value.id])).rows[0].status, 'unsupported');
  });

  test('wrong genesis, wrong eCash checkpoint, and a disabled token index fail preflight', async () => {
    const h = harness(db), owner = await account(h), value = deposit(h.chain, owner.address, 10n * XEC);
    h.chain.genesis = 'ef'.repeat(32);
    await assert.rejects(h.payments.claimDeposit(owner.id, value.id), PaymentError);
    assert.equal(h.payments.status().ready, false);
    h.chain.genesis = MAINNET_GENESIS; h.chain.checkpointValid = false;
    await assert.rejects(h.payments.preflight(), PaymentError);
    h.chain.checkpointValid = true; h.chain.tokenIndex = false;
    await assert.rejects(h.payments.preflight(), PaymentError);
    assert.equal((await balance(owner.id)).available, 0n);
    assert.equal((await db.query('SELECT txid FROM payments_deposits')).rowCount, 0);
  });

  test('removed credited transactions quarantine their account without erasing the credit journal', async () => {
    const h = harness(db), owner = await account(h), value = deposit(h.chain, owner.address, 100n * XEC);
    await h.payments.claimDeposit(owner.id, value.id);
    h.chain.hashes.set(value.indexed.block!.height, 'fa'.repeat(32));
    h.chain.indexed.delete(value.id); h.chain.raw.delete(value.id);
    await h.payments.claimDeposit(owner.id, value.id);
    const rows = await db.query('SELECT a.disabled,d.status FROM accounts a JOIN payments_deposits d ON d.account_id=a.id WHERE a.id=$1', [owner.id]);
    assert.deepEqual(rows.rows, [{ disabled: true, status: 'reorg_review' }]);
    await assertCreditOnce(owner.id, value, 100n * XEC);
    await assert.rejects(request(h, owner.id), isPaymentError('account_disabled'));
  });

  test('loss of previously required finality quarantines a credited transaction still present in its block', async () => {
    const h = harness(db), owner = await account(h), value = deposit(h.chain, owner.address, 100n * XEC);
    await h.payments.claimDeposit(owner.id, value.id); value.indexed.isFinal = false;
    await h.payments.claimDeposit(owner.id, value.id);
    const rows = await db.query('SELECT a.disabled,d.status FROM accounts a JOIN payments_deposits d ON d.account_id=a.id WHERE a.id=$1', [owner.id]);
    assert.deepEqual(rows.rows, [{ disabled: true, status: 'reorg_review' }]);
    await assertCreditOnce(owner.id, value, 100n * XEC);
  });

  test('a lone indexer 404 preserves credited ownership and requires revalidation instead of inventing a reorg', async () => {
    const h = harness(db), owner = await account(h), value = deposit(h.chain, owner.address, 100n * XEC);
    await h.payments.claimDeposit(owner.id, value.id); h.chain.indexed.delete(value.id); h.chain.raw.delete(value.id);
    await assert.rejects(h.payments.claimDeposit(owner.id, value.id), ChronikHttpError);
    assert.equal((await db.query('SELECT disabled FROM accounts WHERE id=$1', [owner.id])).rows[0].disabled, false);
    assert.equal((await db.query('SELECT status FROM payments_deposits WHERE txid=$1', [value.id])).rows[0].status, 'credited');
    assert.equal((await db.query('SELECT pending FROM payments_deposit_txs WHERE txid=$1', [value.id])).rows[0].pending, true);
    await assertCreditOnce(owner.id, value, 100n * XEC);
  });

  test('reorg quarantine stops a queued unsigned withdrawal before coin selection or signing', async () => {
    const h = harness(db), owner = await account(h), value = deposit(h.chain, owner.address, 100n * XEC);
    await h.payments.claimDeposit(owner.id, value.id); const withdrawal = await request(h, owner.id);
    h.chain.hashes.set(value.indexed.block!.height, 'fa'.repeat(32));
    h.chain.indexed.delete(value.id); h.chain.raw.delete(value.id); await h.payments.claimDeposit(owner.id, value.id);
    h.calls.length = 0; await process(h, withdrawal.id);
    assert.equal(h.signatures.count, 0);
    assert.equal(h.calls.some(call => ['utxos', 'broadcastTx'].includes(call.method)), false);
    assert.equal((await withdrawalRow(withdrawal.id)).signed_hex, null);
  });

  test('withdrawal idempotency serializes concurrent requests and binds both recipient and amount', async () => {
    const h = harness(db), owner = await account(h, 100n * XEC), key = randomUUID();
    const requests = await Promise.all(Array.from({ length: 12 }, () => request(h, owner.id, key)));
    assert.equal(new Set(requests.map(value => value.id)).size, 1);
    assert.deepEqual(await balance(owner.id), { available: 60n * XEC, reserved: 40n * XEC });
    await assert.rejects(h.payments.requestWithdrawal(owner.id, recipient, (31n * XEC).toString(), key), isPaymentError('idempotency_conflict'));
    await assert.rejects(h.payments.requestWithdrawal(owner.id, owner.address, (30n * XEC).toString(), key), isPaymentError('idempotency_conflict'));
  });

  test('a different programmatic seed cannot reopen the same wallet ledger', async () => {
    const h = harness(db); await account(h);
    const resumed = harness(db, h.chain, otherSeed);
    await assert.rejects(resumed.payments.preflight(), isPaymentError('wallet_binding_mismatch'));
    assert.equal(resumed.payments.status().ready, false);
    const row = (await db.query("SELECT value FROM payments_state WHERE key='wallet-identity'")).rows[0];
    assert.equal(row.value.fingerprint, new ProgrammaticWallet(seed, 'mainnet').fingerprint);
  });

  test('actual signed bytes and attempt count commit before broadcast; timeouts replay only those bytes after restart', async () => {
    const h = harness(db), owner = await account(h, 100n * XEC);
    deposit(h.chain, owner.address, 60n * XEC); const withdrawal = await request(h, owner.id);
    const observed: string[] = [];
    h.chain.broadcastObserver = async raw => {
      const row = await withdrawalRow(withdrawal.id); // independent PG connection sees committed state
      assert.equal(row.signed_hex, raw); assert.equal(row.txid, decodeTransaction(raw).txid);
      assert.ok(Number(row.broadcast_attempts) >= 1);
      assert.deepEqual(decodeTransaction(raw).outputs[0], { outputScript: addressScript(recipient, 'mainnet'), sats: 3000n });
      observed.push(raw);
    };
    await process(h, withdrawal.id); await process(h, withdrawal.id);
    const first = await withdrawalRow(withdrawal.id);
    assert.equal(first.status, 'signed'); assert.equal(first.broadcast_attempts, 2); assert.equal(h.signatures.count, 1);
    const resumed = harness(db, h.chain); await process(resumed, withdrawal.id);
    const last = await withdrawalRow(withdrawal.id);
    assert.equal(last.signed_hex, first.signed_hex); assert.equal(last.txid, first.txid); assert.equal(last.broadcast_attempts, 3);
    assert.equal(resumed.signatures.count, 0); assert.equal(observed.length, 3); assert.equal(new Set(observed).size, 1);
    assert.deepEqual(await balance(owner.id), { available: 60n * XEC, reserved: 40n * XEC });
    assert.equal((await db.query("SELECT reference FROM transfers WHERE reference LIKE 'withdrawal-%refund:%'")).rowCount, 0);
  });

  test('confirmed genuine payout settles once and releases exactly its unused fee reserve', async () => {
    const h = harness(db), payout = await preparedPayout(h);
    publish(h.chain, payout.raw, h.chain.tipHeight - 1);
    await process(h, payout.id); await process(h, payout.id);
    assert.equal((await withdrawalRow(payout.id)).status, 'settled');
    assert.deepEqual(await balance(payout.owner.id), { available: 70n * XEC - payout.fee, reserved: 0n });
    const journal = await db.query('SELECT reference FROM transfers WHERE reference=ANY($1::text[])', [[`withdrawal-settlement:${payout.id}`, `withdrawal-fee-refund:${payout.id}`]]);
    assert.equal(journal.rowCount, 2);
    assert.equal(h.calls.some(call => call.method === 'broadcastTx'), false);
  });

  test('remote validation receives only durably signed bytes; its timeout cannot refund or rebuild them', async () => {
    const h = harness(db), owner = await account(h, 100n * XEC);
    deposit(h.chain, owner.address, 60n * XEC); const withdrawal = await request(h, owner.id), observed: string[] = [];
    h.chain.validationObserver = async raw => {
      const row = await withdrawalRow(withdrawal.id);
      assert.equal(row.status, 'signed'); assert.equal(row.signed_hex, raw); assert.equal(row.txid, decodeTransaction(raw).txid);
      assert.ok(BigInt(String(row.fee_nanos)) > 0n); assert.equal((row.input_outpoints as unknown[]).length, 1);
      observed.push(raw);
    };
    h.chain.validationFails = true; await process(h, withdrawal.id);
    const first = await withdrawalRow(withdrawal.id);
    assert.equal(first.status, 'signed'); assert.equal(first.broadcast_attempts, 1); assert.equal(h.signatures.count, 1);
    assert.equal(h.calls.some(call => call.method === 'broadcastTx'), false);
    assert.deepEqual(await balance(owner.id), { available: 60n * XEC, reserved: 40n * XEC });
    const resumed = harness(db, h.chain); h.chain.validationFails = false; await process(resumed, withdrawal.id);
    assert.equal(resumed.signatures.count, 0); assert.equal(observed.length, 2); assert.equal(new Set(observed).size, 1);
    assert.equal((await withdrawalRow(withdrawal.id)).signed_hex, first.signed_hex);
    assert.equal((await db.query('SELECT reference FROM transfers WHERE reference=$1', [`withdrawal-failed-refund:${withdrawal.id}`])).rowCount, 0);
  });

  test('an accepted broadcast with a lost reply reconciles after restart without rebuilding or refunding', async () => {
    const h = harness(db), owner = await account(h, 100n * XEC);
    deposit(h.chain, owner.address, 60n * XEC); const withdrawal = await request(h, owner.id);
    h.chain.broadcastMode = 'accept_then_timeout'; await process(h, withdrawal.id);
    const signed = await withdrawalRow(withdrawal.id);
    assert.equal(signed.status, 'signed'); assert.equal(signed.broadcast_attempts, 1);
    publish(h.chain, String(signed.signed_hex), h.chain.tipHeight - 1);
    const resumed = harness(db, h.chain); await process(resumed, withdrawal.id);
    assert.equal((await withdrawalRow(withdrawal.id)).status, 'settled');
    assert.equal(resumed.signatures.count, 0); assert.equal(resumed.calls.some(call => call.method === 'broadcastTx'), false);
    assert.deepEqual(await balance(owner.id), { available: 70n * XEC - BigInt(String(signed.fee_nanos)), reserved: 0n });
  });

  test('a conflicting spend of reserved inputs holds a signed payout for review and never refunds', async () => {
    const h = harness(db), payout = await preparedPayout(h);
    payout.source.indexed.outputs[0]!.spentBy = { txid: 'da'.repeat(32), outIdx: 0 };
    await process(h, payout.id);
    assert.equal((await withdrawalRow(payout.id)).status, 'manual_review');
    assert.deepEqual(await balance(payout.owner.id), { available: 60n * XEC, reserved: 40n * XEC });
    assert.equal(h.calls.some(call => call.method === 'broadcastTx'), false);
  });

  test('account quarantine holds a signed payout without broadcast or refund', async () => {
    const h = harness(db), payout = await preparedPayout(h);
    await db.query('UPDATE accounts SET disabled=true WHERE id=$1', [payout.owner.id]); await process(h, payout.id);
    assert.equal((await withdrawalRow(payout.id)).status, 'manual_review');
    assert.deepEqual(await balance(payout.owner.id), { available: 60n * XEC, reserved: 40n * XEC });
    assert.equal(h.calls.some(call => call.method === 'broadcastTx'), false);
    assert.equal(h.calls.some(call => call.method === 'validateRawTx'), false);
  });

  test('an unsigned liquidity failure refunds once without inventing signed bytes', async () => {
    const h = harness(db), owner = await account(h, 100n * XEC), withdrawal = await request(h, owner.id);
    await process(h, withdrawal.id); await process(h, withdrawal.id);
    const row = await withdrawalRow(withdrawal.id);
    assert.equal(row.status, 'failed'); assert.equal(row.signed_hex, null);
    assert.deepEqual(await balance(owner.id), { available: 100n * XEC, reserved: 0n });
    assert.equal((await db.query('SELECT reference FROM transfers WHERE reference=$1', [`withdrawal-failed-refund:${withdrawal.id}`])).rowCount, 1);
    assert.equal(h.signatures.count, 0);
  });

  test('restart preserves signed outpoint reservations so a second payout cannot reuse those coins', async () => {
    const h = harness(db), owner = await account(h, 200n * XEC), source = deposit(h.chain, owner.address, 60n * XEC);
    const first = await request(h, owner.id); await build(h, first.id);
    const resumed = harness(db, h.chain), second = await request(resumed, owner.id); await process(resumed, second.id);
    assert.equal((await withdrawalRow(second.id)).status, 'failed'); assert.equal(resumed.signatures.count, 0);
    const reserved = (await withdrawalRow(first.id)).input_outpoints as { txid: string; vout: number }[];
    assert.equal(reserved[0]!.txid, source.id); assert.equal(reserved[0]!.vout, 0);
    assert.equal((await withdrawalRow(first.id)).status, 'signed');
    assert.deepEqual(await balance(owner.id), { available: 160n * XEC, reserved: 40n * XEC });
  });

  test('a transient credited-deposit recheck pauses outgoing work without disabling access, then resumes safely', async () => {
    const h = harness(db), owner = await account(h), value = deposit(h.chain, owner.address, 100n * XEC);
    h.chain.history.set(owner.address, [value.id]);
    await h.payments.claimDeposit(owner.id, value.id); const withdrawal = await request(h, owner.id);
    h.chain.rawFailures.add(value.id);
    await assert.rejects(h.payments.claimDeposit(owner.id, value.id), isPaymentError('chronik_unavailable'));
    await assert.rejects(h.payments.sync(), PaymentError);
    assert.equal((await db.query('SELECT disabled FROM accounts WHERE id=$1', [owner.id])).rows[0].disabled, false);
    assert.equal((await db.query('SELECT pending FROM payments_deposit_txs WHERE txid=$1', [value.id])).rows[0].pending, true);
    assert.equal((await withdrawalRow(withdrawal.id)).status, 'requested');
    assert.equal(h.signatures.count, 0); assert.equal(h.calls.some(call => call.method === 'broadcastTx'), false);
    assert.deepEqual(await balance(owner.id), { available: 60n * XEC, reserved: 40n * XEC });
    h.chain.rawFailures.clear(); await due(); await h.payments.sync();
    assert.equal((await withdrawalRow(withdrawal.id)).status, 'signed');
    assert.equal(h.signatures.count, 1);
    assert.equal((await db.query('SELECT reference FROM transfers WHERE reference=$1', [`deposit:mainnet:${value.id}:0`])).rowCount, 1);
  });

  test('automatic history catch-up credits a deposit already spent from the custodial address only once', async () => {
    const h = harness(db), owner = await account(h), value = deposit(h.chain, owner.address, 75n * XEC);
    value.indexed.outputs[0]!.spentBy = { txid: 'bc'.repeat(32), outIdx: 0 };
    h.chain.history.set(owner.address, [value.id]);
    await h.payments.sync(); await due(); await h.payments.sync();
    await h.payments.claimDeposit(owner.id, value.id);
    await assertCreditOnce(owner.id, value, 75n * XEC);
    assert.equal((await db.query('SELECT address,account_id FROM payments_deposits WHERE txid=$1', [value.id])).rows[0].account_id, owner.id);
    assert.equal(h.calls.some(call => call.method === 'confirmedTxs'), true);
  });

  test('paginated history persists completed pages, survives an upstream page outage, and resumes after restart', async () => {
    const h = harness(db), owner = await account(h);
    const values = Array.from({ length: 105 }, () => deposit(h.chain, owner.address, 10n * XEC, h.chain.tipHeight - 200));
    h.chain.history.set(owner.address, values.map(value => value.id)); h.chain.historyFailures.add(`${owner.address}:1`);
    await assert.rejects(scan(h), PaymentError);
    const cursor = (await db.query('SELECT confirmed_offset::text FROM payments_address_scans WHERE address=$1', [owner.address])).rows[0];
    assert.equal(cursor.confirmed_offset, '100');
    assert.equal((await db.query('SELECT txid FROM payments_deposit_txs')).rowCount, 100);
    assert.equal((await balance(owner.id)).available, 0n);
    h.chain.historyFailures.clear(); const resumed = harness(db, h.chain); await due(); await scan(resumed);
    assert.equal((await db.query('SELECT confirmed_offset::text FROM payments_address_scans WHERE address=$1', [owner.address])).rows[0].confirmed_offset, '105');
    assert.equal((await db.query('SELECT txid FROM payments_deposit_txs')).rowCount, 105);
    await due(); await resumed.payments.sync(); await due(); await resumed.payments.sync();
    assert.equal((await balance(owner.id)).available, 1050n * XEC);
    assert.equal((await db.query("SELECT reference FROM transfers WHERE reference LIKE 'deposit:%'")).rowCount, 105);
    const pages = resumed.calls.filter(call => call.method === 'confirmedTxs');
    assert.ok(pages.some(call => call.args[1] === 1));
  });

  test('rescanning a partial history tail leaves already credited transactions behind the cursor untouched', async () => {
    const h = harness(db), owner = await account(h), value = deposit(h.chain, owner.address, 25n * XEC);
    h.chain.history.set(owner.address, [value.id]); await h.payments.sync();
    const before = (await db.query('SELECT updated_at::text AS revision,pending FROM payments_deposit_txs WHERE txid=$1', [value.id])).rows[0];
    assert.equal(before.pending, false); h.calls.length = 0;
    await db.query("UPDATE payments_address_scans SET next_scan_at=now()-interval '1 second'");
    await h.payments.sync();
    const after = (await db.query('SELECT updated_at::text AS revision,pending FROM payments_deposit_txs WHERE txid=$1', [value.id])).rows[0];
    assert.deepEqual(after, before);
    assert.equal(h.calls.some(call => call.method === 'tx' && call.args[0] === value.id), false);
    await assertCreditOnce(owner.id, value, 25n * XEC);
  });

  test('an exact full-page cursor catches a subsequently appended deposit without skipping or replaying its first page', async () => {
    const h = harness(db), owner = await account(h);
    const values = Array.from({ length: 100 }, () => deposit(h.chain, owner.address, 10n * XEC, h.chain.tipHeight - 200));
    h.chain.history.set(owner.address, values.map(value => value.id)); await h.payments.sync();
    assert.equal((await balance(owner.id)).available, 1000n * XEC);
    assert.equal((await db.query('SELECT confirmed_offset::text FROM payments_address_scans WHERE address=$1', [owner.address])).rows[0].confirmed_offset, '100');
    h.calls.length = 0; await due(); await h.payments.sync();
    assert.ok(h.calls.some(call => call.method === 'confirmedTxs' && call.args[1] === 1));
    assert.equal(h.calls.some(call => call.method === 'tx' && values.some(value => value.id === call.args[0])), false);
    const appended = deposit(h.chain, owner.address, 20n * XEC); h.chain.history.get(owner.address)!.push(appended.id);
    await due(); await h.payments.sync();
    assert.equal((await balance(owner.id)).available, 1020n * XEC);
    assert.equal((await db.query('SELECT confirmed_offset::text FROM payments_address_scans WHERE address=$1', [owner.address])).rows[0].confirmed_offset, '101');
    assert.equal((await db.query("SELECT reference FROM transfers WHERE reference LIKE 'deposit:%'")).rowCount, 101);
  });

  test('a changed history anchor triggers a rescan and quarantine for a removed credited deposit', async () => {
    const h = harness(db), owner = await account(h), value = deposit(h.chain, owner.address, 80n * XEC);
    h.chain.history.set(owner.address, [value.id]); await h.payments.sync(); await assertCreditOnce(owner.id, value, 80n * XEC);
    const scanRow = (await db.query('SELECT anchor_height FROM payments_address_scans WHERE address=$1', [owner.address])).rows[0];
    assert.ok(Number.isInteger(scanRow.anchor_height));
    h.chain.hashes.set(scanRow.anchor_height, 'fe'.repeat(32)); h.chain.history.set(owner.address, []);
    h.chain.hashes.set(value.indexed.block!.height, 'fa'.repeat(32));
    h.chain.indexed.delete(value.id); h.chain.raw.delete(value.id); h.calls.length = 0;
    await due(); await h.payments.sync();
    const ownerRow = (await db.query('SELECT disabled FROM accounts WHERE id=$1', [owner.id])).rows[0];
    assert.equal(ownerRow.disabled, true);
    assert.equal((await db.query('SELECT status FROM payments_deposits WHERE txid=$1', [value.id])).rows[0].status, 'reorg_review');
    await assertCreditOnce(owner.id, value, 80n * XEC);
    assert.ok(h.calls.some(call => call.method === 'confirmedTxs' && call.args[1] === 0));
  });

  test('schema upgrade preserves legacy node-wallet evidence and blocks reinterpretation as a fresh HD wallet', async () => {
    const owner = await createAccount(db, { name: 'Legacy wallet account', dailyLimitNanos: '0', maxPriceNanos: '0' });
    await db.query('UPDATE accounts SET deposit_address=$2 WHERE id=$1', [owner.id, recipient]);
    const legacy = { network: 'mainnet', walletName: 'zoko', identityAddress: recipient, genesis: MAINNET_GENESIS };
    await db.query("INSERT INTO payments_state(key,value) VALUES('wallet-identity',$1)", [JSON.stringify(legacy)]);
    await db.query('DROP TABLE payments_address_scans'); await db.query('DROP TABLE payments_addresses');
    await db.query('ALTER TABLE sellers DROP CONSTRAINT sellers_enabled_requires_owner');
    await db.query('ALTER TABLE sellers DROP COLUMN paused');
    await db.query('DROP TABLE agent_jobs');
    await db.query('ALTER TABLE sellers DROP COLUMN delivery_mode,DROP COLUMN agent_ready_until');
    await db.query('ALTER TABLE quotes DROP COLUMN delivery_mode');
    await db.query('DELETE FROM zoko_migrations'); await db.query('INSERT INTO zoko_migrations(version) VALUES(1)');
    await migrate(db);
    const h = harness(db); await assert.rejects(h.payments.preflight(), isPaymentError('node_wallet_migration_required'));
    assert.deepEqual((await db.query("SELECT value FROM payments_state WHERE key='wallet-identity'")).rows[0].value, legacy);
    assert.equal((await db.query('SELECT deposit_address FROM accounts WHERE id=$1', [owner.id])).rows[0].deposit_address, recipient);
    assert.equal((await db.query('SELECT address FROM payments_addresses')).rowCount, 0);
  });

  test('global reorg requeues spent credited deposits outside the address batch and holds payouts through an outage', async () => {
    const h = harness(db), owner = await account(h), value = deposit(h.chain, owner.address, 100n * XEC);
    value.indexed.outputs[0]!.spentBy = { txid: 'bd'.repeat(32), outIdx: 0 };
    h.chain.history.set(owner.address, [value.id]); await h.payments.sync(); const withdrawal = await request(h, owner.id);
    // Fifty never-scanned addresses precede this previously scanned address in
    // the worker's bounded round-robin batch after its global reset.
    await Promise.all(Array.from({ length: 50 }, () => account(h)));
    h.chain.hashes.set(h.chain.tipHeight, 'fc'.repeat(32)); h.chain.rawFailures.add(value.id); h.calls.length = 0;
    await assert.rejects(h.payments.sync(), isPaymentError('credited_deposit_unverified'));
    assert.equal(h.calls.some(call => call.method === 'confirmedTxs' && call.args[0] === owner.address), false);
    assert.equal(h.calls.some(call => call.method === 'tx' && call.args[0] === value.id), true);
    assert.equal((await db.query('SELECT pending FROM payments_deposit_txs WHERE txid=$1', [value.id])).rows[0].pending, true);
    assert.equal((await db.query('SELECT disabled FROM accounts WHERE id=$1', [owner.id])).rows[0].disabled, false);
    assert.equal((await withdrawalRow(withdrawal.id)).status, 'requested'); assert.equal(h.signatures.count, 0);
    assert.deepEqual(await balance(owner.id), { available: 60n * XEC, reserved: 40n * XEC });
    h.chain.rawFailures.clear(); h.chain.hashes.set(value.indexed.block!.height, 'fb'.repeat(32));
    h.chain.indexed.delete(value.id); h.chain.raw.delete(value.id); h.chain.history.set(owner.address, []);
    await due(); await h.payments.sync();
    assert.equal((await db.query('SELECT disabled FROM accounts WHERE id=$1', [owner.id])).rows[0].disabled, true);
    assert.equal((await db.query('SELECT status FROM payments_deposits WHERE txid=$1', [value.id])).rows[0].status, 'reorg_review');
    assert.equal((await withdrawalRow(withdrawal.id)).signed_hex, null);
    assert.equal(h.calls.some(call => call.method === 'broadcastTx'), false);
  });

  test('orphaned legacy addresses and node-history cursors also block implicit HD initialization', async () => {
    const owner = await createAccount(db, { name: 'Unmapped address', dailyLimitNanos: '0', maxPriceNanos: '0' });
    await db.query('UPDATE accounts SET deposit_address=$2 WHERE id=$1', [owner.id, recipient]);
    const h = harness(db); await assert.rejects(h.payments.preflight(), isPaymentError('node_wallet_migration_required'));
    await db.query('UPDATE accounts SET deposit_address=NULL WHERE id=$1', [owner.id]);
    await db.query('INSERT INTO payments_state(key,value) VALUES($1,$2)', ['wallet-cursor:mainnet:zoko', JSON.stringify({ blockHash: blockHash(900_000) })]);
    await assert.rejects(h.payments.preflight(), isPaymentError('node_wallet_migration_required'));
    assert.equal((await db.query("SELECT key FROM payments_state WHERE key='wallet-identity'")).rowCount, 0);
  });
});
