import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import test from 'node:test';
import { Address, Ecc, Script, Tx } from 'ecash-lib';
import { MAX_MONEY_NANOS, NANOS_PER_ATOM, PaymentError } from '../src/payments/money.js';
import {
  MAX_WALLET_INPUTS, ProgrammaticWallet, decodeTransaction,
  type WalletInput, type WalletNetwork, type WithdrawalBuildRequest,
} from '../src/payments/wallet.js';

// Public deterministic fixtures only. These keys must never hold real funds.
const SEED = createHash('sha256').update('Zoko wallet unit test fixture: never fund').digest('hex');
const RECIPIENT_SEED = createHash('sha256').update('Zoko wallet recipient fixture: never fund').digest('hex');
const wallet = new ProgrammaticWallet(SEED, 'mainnet');
const recipient = new ProgrammaticWallet(RECIPIENT_SEED, 'mainnet');
const MAX_ATOMS = MAX_MONEY_NANOS / NANOS_PER_ATOM;

function request(overrides: Partial<WithdrawalBuildRequest> = {}): WithdrawalBuildRequest {
  return {
    inputs: [
      { txid: '11'.repeat(32), vout: 1, sats: 20_000n, branch: 0, index: 0 },
      { txid: '22'.repeat(32), vout: 0, sats: 30_000n, branch: 1, index: 0 },
    ],
    recipientAddress: recipient.derive(0, 0).address,
    recipientSats: 10_000n, changeIndex: 1,
    feeRateSatsPerKb: 1_000n, maxFeeSats: 10_000n, maxFeeRateSatsPerKb: 10_000n,
    ...overrides,
  };
}

const code = (expected: string) => (error: unknown) => error instanceof PaymentError && error.code === expected;

function u32(value: number): Buffer { const bytes = Buffer.alloc(4); bytes.writeUInt32LE(value); return bytes; }
function u64(value: bigint): Buffer { const bytes = Buffer.alloc(8); bytes.writeBigUInt64LE(value); return bytes; }
function hash(bytes: Uint8Array): Buffer { return createHash('sha256').update(bytes).digest(); }
function hash256(bytes: Uint8Array): Buffer { return hash(hash(bytes)); }
function compactBytes(bytes: Uint8Array): Buffer {
  assert.ok(bytes.length < 253, 'Reference fixture uses only short scripts');
  return Buffer.concat([Buffer.from([bytes.length]), bytes]);
}
function outpoint(tx: Tx, i: number): Buffer {
  const prev = tx.inputs[i]!.prevOut;
  const hashBytes = typeof prev.txid === 'string' ? Buffer.from(prev.txid, 'hex').reverse() : prev.txid;
  return Buffer.concat([hashBytes, u32(prev.outIdx)]);
}

/** Independent BIP143 serialization; does not use ecash-lib's signing digest. */
function verifySignatures(hex: string, reserved: WalletInput[]): void {
  const tx = Tx.fromHex(hex);
  const outputsHash = hash256(Buffer.concat(tx.outputs.map(output =>
    Buffer.concat([u64(output.sats), compactBytes(output.script.bytecode)]))));
  const previousHash = hash256(Buffer.concat(tx.inputs.map((_, i) => outpoint(tx, i))));
  const sequencesHash = hash256(Buffer.concat(tx.inputs.map(input => u32(input.sequence!))));
  for (let i = 0; i < tx.inputs.length; i++) {
    const input = tx.inputs[i]!;
    const coin = reserved[i]!;
    const unlock = input.script!.bytecode;
    assert.equal(unlock.length, 100);
    assert.equal(unlock[0], 65);
    assert.equal(unlock[65], 0x41, 'ALL|FORKID commits to all inputs and outputs');
    assert.equal(unlock[66], 33);
    const publicKey = unlock.subarray(67);
    const pkh = createHash('ripemd160').update(hash(publicKey)).digest('hex');
    const expectedScript = wallet.derive(coin.branch, coin.index).outputScript;
    assert.equal(`76a914${pkh}88ac`, expectedScript, 'Signature key owns the reserved derivation path');
    const preimage = Buffer.concat([
      u32(tx.version), previousHash, sequencesHash, outpoint(tx, i),
      compactBytes(Buffer.from(expectedScript, 'hex')), u64(coin.sats), u32(input.sequence!),
      outputsHash, u32(tx.locktime), u32(0x41),
    ]);
    new Ecc().schnorrVerify(unlock.subarray(1, 65), hash256(preimage), publicKey);
  }
}

test('dedicated seed validation rejects malformed or obvious repeated secrets without echoing them', () => {
  const invalid = ['', '0'.repeat(64), 'ff'.repeat(32), 'ab'.repeat(32), '0123456789abcdef'.repeat(4),
    'a'.repeat(63), `${SEED}00`, SEED.toUpperCase(), ` ${SEED}`, 'words are not a signing seed'];
  for (const value of invalid) {
    assert.throws(() => new ProgrammaticWallet(value, 'mainnet'), error => {
      assert.ok(error instanceof PaymentError);
      assert.equal(error.code, 'configuration');
      if (value.length >= 16) assert.ok(!error.message.includes(value));
      return true;
    });
  }
  assert.throws(() => new ProgrammaticWallet(SEED, 'unknown' as WalletNetwork), code('configuration'));
  assert.ok(!JSON.stringify(wallet).includes(SEED));
});

test('HD receive and change paths have stable public identity and address vectors', () => {
  assert.equal(wallet.fingerprint, '916f3ed6213314f840032cde81d6fad61e0948baa906fc9aa83f7152566f78fd');
  assert.deepEqual(wallet.derive(0, 0), {
    address: 'ecash:qz9x4sm759xnudnu5wtfngcpyw39v76n7u2tyrrclj',
    outputScript: '76a9148a6ac37ea14d3e367ca39699a30123a2567b53f788ac', branch: 0, index: 0,
  });
  assert.equal(wallet.derive(1, 0).address, 'ecash:qray9kwcn2c0ej4mq92lgtr07d4tqu5w2van5e9jv6');
  assert.notEqual(wallet.derive(0, 1).address, wallet.derive(1, 1).address);
  assert.equal(new ProgrammaticWallet(SEED, 'mainnet').fingerprint, wallet.fingerprint);
  assert.notEqual(recipient.fingerprint, wallet.fingerprint);
});

test('wallet identity and destination address checks bind the configured network', () => {
  const networks: WalletNetwork[] = ['mainnet', 'testnet', 'regtest'];
  const fingerprints = new Set<string>();
  for (const network of networks) {
    const other = new ProgrammaticWallet(SEED, network);
    fingerprints.add(other.fingerprint);
    assert.equal(other.derive(0, 0).outputScript, wallet.derive(0, 0).outputScript);
    if (network !== 'mainnet') assert.throws(() => wallet.buildWithdrawal(request({ recipientAddress: other.derive(0, 0).address })), code('invalid_address'));
  }
  assert.equal(fingerprints.size, 3);
  for (const address of [recipient.derive(0, 0).address.split(':')[1]!, '1BoatSLRHtKNngkdXEeobR76b53LETtpyT',
    recipient.derive(0, 0).address.replace('ecash:', 'etoken:'), 'ecash:invalid']) {
    assert.throws(() => wallet.buildWithdrawal(request({ recipientAddress: address })), code('invalid_address'));
  }
});

test('derivation enforces branches and unhardened allocation indices', () => {
  for (const bad of [-1, 0.5, 0x80000000, Number.NaN, Number.POSITIVE_INFINITY]) {
    assert.throws(() => wallet.derive(0, bad), code('invalid_derivation'));
  }
  assert.throws(() => wallet.derive(2 as 0, 0), code('invalid_derivation'));
  assert.match(wallet.derive(1, 0x7fffffff).address, /^ecash:/);
  assert.equal(wallet.derive(0, 0).address, 'ecash:qz9x4sm759xnudnu5wtfngcpyw39v76n7u2tyrrclj');
});

test('real Schnorr withdrawal preserves reserved inputs, recipient, exact fee and deterministic bytes', () => {
  const plan = request();
  const built = wallet.buildWithdrawal(plan);
  const decoded = decodeTransaction(built.hex);
  assert.equal(built.txid, '2745baee8ba2c3b6d0dd501d2a8213181d041dca8d1b4341684591701a97f29f');
  assert.equal(built.hex, wallet.buildWithdrawal(plan).hex);
  assert.equal(decoded.txid, Buffer.from(hash256(Buffer.from(built.hex, 'hex'))).reverse().toString('hex'));
  assert.deepEqual(built.inputs, plan.inputs);
  assert.deepEqual(decoded.inputs, plan.inputs.map(({ txid, vout }) => ({ txid, vout })));
  assert.equal(decoded.size, 360);
  assert.equal(built.feeSats, 360n);
  assert.deepEqual(built.outputs, [
    { outputScript: recipient.derive(0, 0).outputScript, sats: 10_000n },
    { outputScript: wallet.derive(1, 1).outputScript, sats: 39_640n },
  ]);
  assert.equal(built.changeAddress, wallet.derive(1, 1).address);
  assert.equal(decoded.version, 2);
  assert.equal(decoded.lockTime, 0);
  verifySignatures(built.hex, plan.inputs);
});

test('Schnorr signatures commit to recipient, amounts, all outpoints, sequence and locktime', () => {
  const plan = request();
  const built = wallet.buildWithdrawal(plan);
  const mutations: Array<(tx: Tx) => void> = [
    tx => { tx.outputs[0]!.sats += 1n; },
    tx => { tx.outputs[0]!.script = Script.fromAddress(wallet.derive(0, 7).address); },
    tx => { tx.outputs[1]!.sats -= 1n; },
    tx => { tx.inputs[1]!.prevOut.outIdx += 1; },
    tx => { tx.inputs[1]!.sequence = 0xfffffffe; },
    tx => { tx.locktime = 1; },
    tx => { tx.inputs[0]!.script!.bytecode[5]! ^= 1; },
  ];
  for (const mutate of mutations) {
    const altered = Tx.fromHex(built.hex);
    mutate(altered);
    assert.throws(() => verifySignatures(altered.toHex(), plan.inputs));
  }
  const wrongAmount = plan.inputs.map(input => ({ ...input }));
  wrongAmount[0]!.sats += 1n;
  assert.throws(() => verifySignatures(built.hex, wrongAmount));
});

test('P2SH recipients are supported without changing the signed input scheme', () => {
  const destination = Address.p2sh(Buffer.from('42'.repeat(20), 'hex')).toString();
  const plan = request({ recipientAddress: destination });
  const built = wallet.buildWithdrawal(plan);
  assert.equal(built.outputs[0]!.outputScript, `a914${'42'.repeat(20)}87`);
  assert.equal(built.feeSats, 358n);
  verifySignatures(built.hex, plan.inputs);
});

test('fees round up exactly and honor both absolute and per-kilobyte limits', () => {
  const built = wallet.buildWithdrawal(request({ feeRateSatsPerKb: 1001n, maxFeeRateSatsPerKb: 1001n }));
  assert.equal(built.feeSats, 361n);
  assert.throws(() => wallet.buildWithdrawal(request({ maxFeeSats: 359n })), code('fee_limit'));
  assert.throws(() => wallet.buildWithdrawal(request({ maxFeeRateSatsPerKb: 999n })), code('invalid_fee'));
  for (const feeRateSatsPerKb of [0n, -1n, MAX_ATOMS + 1n]) {
    assert.throws(() => wallet.buildWithdrawal(request({ feeRateSatsPerKb })), code('invalid_amount'));
  }
});

test('sub-dust change becomes a bounded actual fee while exact dust remains change', () => {
  const input = { ...request().inputs[0]!, sats: 10_764n };
  const withoutChange = wallet.buildWithdrawal(request({ inputs: [input] }));
  assert.equal(withoutChange.outputs.length, 1);
  assert.equal(withoutChange.feeSats, 764n);
  assert.equal(decodeTransaction(withoutChange.hex).size, 185);
  assert.throws(() => wallet.buildWithdrawal(request({ inputs: [input], maxFeeSats: 763n })), code('fee_limit'));
  assert.throws(() => wallet.buildWithdrawal(request({ inputs: [input], maxFeeRateSatsPerKb: 4_000n })), code('fee_limit'));
  const withChange = wallet.buildWithdrawal(request({ inputs: [{ ...input, sats: 10_765n }] }));
  assert.equal(withChange.outputs[1]!.sats, 546n);
  assert.equal(withChange.feeSats, 219n);
  verifySignatures(withoutChange.hex, [input]);
});

test('insufficient inputs cannot trigger coin selection, additional funding or a partial transaction', () => {
  for (const sats of [9_999n, 10_000n, 10_100n]) {
    assert.throws(() => wallet.buildWithdrawal(request({ inputs: [{ ...request().inputs[0]!, sats }] })), code('insufficient_liquidity'));
  }
  assert.throws(() => wallet.buildWithdrawal(request({ inputs: [] })), code('invalid_inputs'));
});

test('duplicate, malformed and over-limit reserved inputs are rejected before signing', () => {
  const input = request().inputs[0]!;
  assert.throws(() => wallet.buildWithdrawal(request({ inputs: [input, input] })), code('invalid_inputs'));
  assert.throws(() => wallet.buildWithdrawal(request({ inputs: Array(MAX_WALLET_INPUTS + 1).fill(input) })), code('invalid_inputs'));
  for (const vout of [-1, 0x100000000, 0.5]) {
    assert.throws(() => wallet.buildWithdrawal(request({ inputs: [{ ...input, vout }] })), code('invalid_inputs'));
  }
  assert.throws(() => wallet.buildWithdrawal(request({ inputs: [{ ...input, txid: 'AA'.repeat(32) }] })), code('invalid_txid'));
  assert.throws(() => wallet.buildWithdrawal(request({ inputs: [{ ...input, sats: 0n }] })), code('invalid_amount'));
  assert.throws(() => wallet.buildWithdrawal(request({ inputs: [{ ...input, branch: 2 as 0 }] })), code('invalid_derivation'));
  assert.throws(() => wallet.buildWithdrawal(request({ inputs: [{ ...input, sats: MAX_ATOMS }, request().inputs[1]!] })), code('invalid_inputs'));
});

test('amounts remain exact at the supply bound and reject numbers or sub-dust payouts', () => {
  const input = { ...request().inputs[0]!, sats: MAX_ATOMS };
  const built = wallet.buildWithdrawal(request({ inputs: [input], recipientSats: MAX_ATOMS - 1_000n }));
  assert.equal(built.outputs[0]!.sats, MAX_ATOMS - 1_000n);
  assert.equal(built.outputs[1]!.sats, 781n);
  assert.equal(built.feeSats, 219n);
  for (const recipientSats of [0n, -1n, 545n, MAX_ATOMS + 1n, 10000 as unknown as bigint]) {
    assert.throws(() => wallet.buildWithdrawal(request({ recipientSats })), code('invalid_amount'));
  }
});

test('strict raw decoder rejects trailing bytes, nonminimal varints, truncation and invalid structure', () => {
  const { hex } = wallet.buildWithdrawal(request());
  const malformed = [hex + '00', hex.slice(0, -2), hex.toUpperCase(), hex.slice(0, 8) + 'fd0200' + hex.slice(10),
    '', '00'.repeat(10), '00'.repeat(100_001), '01000000000000000000'];
  for (const raw of malformed) assert.throws(() => decodeTransaction(raw), code('invalid_transaction'));
  const duplicated = Tx.fromHex(hex);
  duplicated.inputs[1]!.prevOut = { ...duplicated.inputs[0]!.prevOut };
  assert.throws(() => decodeTransaction(duplicated.toHex()), code('invalid_transaction'));
});

test('raw decoder preserves arbitrary output scripts but rejects impossible output totals', () => {
  const tx = Tx.fromHex(wallet.buildWithdrawal(request()).hex);
  tx.outputs.unshift({ sats: 0n, script: new Script(Buffer.from('6a04534c5000', 'hex')) });
  const decoded = decodeTransaction(tx.toHex());
  assert.equal(decoded.outputs[0]!.sats, 0n);
  assert.equal(decoded.outputs[0]!.outputScript, '6a04534c5000');
  // Token and finality policy belong to the verifier, not this byte decoder.
  tx.outputs[0]!.sats = MAX_ATOMS + 1n;
  assert.throws(() => decodeTransaction(tx.toHex()), code('invalid_transaction'));
  tx.outputs[0]!.sats = MAX_ATOMS;
  assert.throws(() => decodeTransaction(tx.toHex()), code('invalid_transaction'));
});
