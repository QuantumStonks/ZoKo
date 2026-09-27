import test from 'node:test';
import assert from 'node:assert/strict';
import { encodeCashAddress } from 'ecashaddrjs';
import {
  CashtabFundingClient,
  createFundingRequest,
  depositKey,
  observeDeposits,
  parseFundingAmount,
  pollFunding,
  type DepositRecord,
} from '../src/browser/cashtab.js';

const address = encodeCashAddress('ecash', 'p2pkh', '11'.repeat(20));
const txid = 'ab'.repeat(32);
const otherTxid = 'cd'.repeat(32);
const pending: DepositRecord = { txid, vout: 0, amountNanos: '10010000000', status: 'pending', confirmations: 0, creditedAt: null };
const credited: DepositRecord = { ...pending, status: 'credited', confirmations: 2, creditedAt: '2026-09-27T01:00:00Z' };

test('funding amounts retain exact on-chain atoms and reject rounded or sub-dust payments', () => {
  assert.deepEqual(parseFundingAmount(' 10.01 '), { amountXec: '10.01', amountNanos: '10010000000' });
  assert.deepEqual(parseFundingAmount('5.46'), { amountXec: '5.46', amountNanos: '5460000000' });
  assert.deepEqual(parseFundingAmount('21000000000000.00'), { amountXec: '21000000000000', amountNanos: '21000000000000000000000' });
  assert.equal(parseFundingAmount('10.50').amountXec, '10.5');
  for (const invalid of ['0', '5.45', '10.001', '1e5', '1,000', '-10', '.50', '010', 'Infinity', '21000000000000.01']) assert.throws(() => parseFundingAmount(invalid));
});

test('official wallet link contains only the checksum-validated destination and exact amount', () => {
  const request = createFundingRequest(address, '10.01');
  const url = new URL(request.payUrl);
  assert.equal(url.origin, 'https://pay.e.cash');
  assert.equal(url.pathname, '/');
  assert.equal(url.searchParams.get('b'), '1');
  assert.equal(url.searchParams.get('bip21'), `${address}?amount=10.01`);
  assert.deepEqual([...url.searchParams.keys()], ['bip21', 'b']);
  assert.equal(request.amountNanos, '10010000000');
  for (const destination of [
    `javascript:alert(1)`,
    `${address}?amount=999&return_url=https://attacker.example`,
    address.slice(0, -1) + (address.endsWith('q') ? 'p' : 'q'),
    encodeCashAddress('ectest', 'p2pkh', '11'.repeat(20)),
    encodeCashAddress('ecash', 'p2pkh', '11'.repeat(32)),
  ]) assert.throws(() => createFundingRequest(destination, '10'));
});

test('Cashtab receives a string amount and a returned txid never creates credit', async () => {
  const calls: unknown[][] = [];
  const client = new CashtabFundingClient({
    isExtensionAvailable: async () => true,
    sendXec: async (...args) => { calls.push(args); return { success: true, txid: txid.toUpperCase(), creditedNanos: '999999999999' }; },
  });
  const request = createFundingRequest(address, '10.01');
  const result = await client.send({ ...request, bip21: 'attacker-controlled', payUrl: 'https://attacker.example' });
  assert.deepEqual(calls, [[address, '10.01']]);
  assert.deepEqual(result, { kind: 'submitted', txid });
  assert.equal(observeDeposits([], { txid }).status, 'waiting');
  assert.equal(observeDeposits([], { txid }).creditedNanos, '0');
});

test('overlapping button activations cannot open two Cashtab transaction requests', async () => {
  let sendCount = 0;
  let complete!: (value: unknown) => void;
  const response = new Promise((resolve) => { complete = resolve; });
  const client = new CashtabFundingClient({ isExtensionAvailable: async () => true, sendXec: async () => { sendCount++; return response; } });
  const request = createFundingRequest(address, '10');
  const first = client.send(request);
  assert.deepEqual(await client.send(request), { kind: 'busy' });
  complete({ success: true, txid });
  assert.deepEqual(await first, { kind: 'submitted', txid });
  assert.equal(sendCount, 1);
});

test('missing extension does not send or open a fallback automatically', async () => {
  let sends = 0;
  const client = new CashtabFundingClient({ isExtensionAvailable: async () => false, sendXec: async () => { sends++; throw new Error('Must not send'); } });
  assert.deepEqual(await client.send(createFundingRequest(address, '10')), { kind: 'unavailable' });
  assert.equal(sends, 0);
});

test('wallet decline, timeout, malformed receipt and missing txid are handled without a retry', async () => {
  for (const response of [{ success: true }, { success: true, txid: 'javascript:alert(1)' }, { success: false, reason: 'Broadcast connection failed' }, undefined]) {
    let calls = 0;
    const client = new CashtabFundingClient({ isExtensionAvailable: async () => true, sendXec: async () => { calls++; return response; } });
    assert.equal((await client.send(createFundingRequest(address, '10'))).kind, 'unknown');
    assert.equal(calls, 1);
  }
  for (const [name, expected] of [['CashtabTransactionDeniedError', 'unknown'], ['CashtabTimeoutError', 'unknown']]) {
    const client = new CashtabFundingClient({ isExtensionAvailable: async () => true, sendXec: async () => { const error = new Error('Wallet result'); error.name = name!; throw error; } });
    assert.equal((await client.send(createFundingRequest(address, '10'))).kind, expected);
  }
  const declined = new CashtabFundingClient({ isExtensionAvailable: async () => true, sendXec: async () => { const error = new Error('User rejected the transaction'); error.name = 'CashtabTransactionDeniedError'; throw error; } });
  assert.equal((await declined.send(createFundingRequest(address, '10'))).kind, 'declined');
});

test('deposit attribution excludes known outpoints and unrelated callback transaction IDs', () => {
  assert.equal(observeDeposits([credited], { baseline: new Set([depositKey(credited)]) }).status, 'waiting');
  assert.equal(observeDeposits([credited], { txid: otherTxid }).status, 'waiting');
  assert.equal(observeDeposits([pending], { txid }).status, 'pending');
  assert.equal(observeDeposits([pending], { txid }).creditedNanos, '0');
  assert.equal(observeDeposits([credited], { txid }).creditedNanos, '10010000000');
});

test('reorg and unsupported records never masquerade as confirmed funding', () => {
  for (const status of ['reorg_review', 'unsupported', 'unknown']) {
    const observation = observeDeposits([{ ...credited, status }], { txid });
    assert.equal(observation.status, 'review');
    assert.equal(observation.creditedNanos, '0');
  }
  assert.equal(observeDeposits([{ ...credited, creditedAt: null }], { txid }).status, 'review');
  assert.throws(() => observeDeposits([credited, credited]), /duplicate/i);
});

test('deposit sums remain exact and credits come only from authenticated deposit records', () => {
  const rows = [{ ...credited, amountNanos: '90071992547409930000' }, { ...credited, vout: 1, amountNanos: '10000000' }];
  const observation = observeDeposits(rows, { txid });
  assert.equal(observation.status, 'credited');
  assert.equal(observation.creditedNanos, '90071992547419930000');
});

test('bounded funding polling transitions only when the server reports a credited outpoint', async () => {
  let reads = 0;
  const statuses: string[] = [];
  const result = await pollFunding({ txid, readDeposits: async () => ++reads < 2 ? [pending] : [credited], onUpdate: (value) => statuses.push(value.status), intervalMs: 1, maxWaitMs: 100 });
  assert.deepEqual(statuses, ['pending', 'credited']);
  assert.equal(result.creditedNanos, '10010000000');
  assert.equal(result.timedOut, false);
  assert.equal(reads, 2);
});

test('funding polling terminates without credit when confirmation or indexing remains pending', async () => {
  let reads = 0;
  const result = await pollFunding({ txid, readDeposits: async () => { reads++; return []; }, intervalMs: 1, maxWaitMs: 8 });
  assert.equal(result.status, 'waiting');
  assert.equal(result.creditedNanos, '0');
  assert.equal(result.timedOut, true);
  assert.ok(reads <= 25);
});

test('funding polling respects disconnect cancellation and bounds failed read retries', async () => {
  const controller = new AbortController(); controller.abort(new Error('Account disconnected'));
  let reads = 0;
  await assert.rejects(pollFunding({ readDeposits: async () => { reads++; return []; }, signal: controller.signal }), /disconnected/);
  assert.equal(reads, 0);
  await assert.rejects(pollFunding({ readDeposits: async () => { reads++; throw new Error('Unavailable'); }, intervalMs: 1, maxWaitMs: 100 }), /Unavailable/);
  assert.equal(reads, 3);
});
