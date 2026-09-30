import assert from 'node:assert/strict';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { once } from 'node:events';
import type { AddressInfo } from 'node:net';
import test from 'node:test';
import { createHash } from 'node:crypto';
import * as proto from 'chronik-client/dist/proto/chronik.js';
import type { Token, Tx } from 'chronik-client';
import { encodeCashAddress } from 'ecashaddrjs';
import {
  MAX_MONEY_NANOS, NANOS_PER_ATOM, PaymentError, nanosToXec, parseNanos,
  requireAtoms, txid, xecToNanos,
} from '../src/payments/money.js';
import { readPaymentsConfig, trustedUrl } from '../src/payments/config.js';
import { boundedBody } from '../src/payments/transport.js';
import { ChronikGateway, ChronikHttpError, assertPlainXec } from '../src/payments/chronik.js';
import {
  addressScript, canonicalAddress, scriptAddress, transactionId,
  verifyChronikTransaction, verifyFee, verifyInputsUnchanged, verifyWithdrawalOutputs,
  type DecodedTransaction,
} from '../src/payments/verification.js';

type Handler = (req: IncomingMessage, res: ServerResponse) => void | Promise<void>;

/** Real loopback sockets exercise fetch, redirects, aborts, and protobuf integers. */
async function serve<T>(handler: Handler, run: (url: string) => Promise<T>): Promise<T> {
  const server = createServer((req, res) => {
    Promise.resolve(handler(req, res)).catch(error => {
      res.destroy(error instanceof Error ? error : new Error(String(error)));
    });
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  try {
    const address = server.address() as AddressInfo;
    return await run(`http://127.0.0.1:${address.port}`);
  } finally {
    server.closeAllConnections();
    await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
  }
}

function paymentCode(code: string): (error: unknown) => boolean {
  return error => error instanceof PaymentError && error.code === code;
}

test('native amount conversion is lossless across the entire XEC range', () => {
  for (const value of ['0.00', '0.01', '1.00', '5.46', '999999999.99', '20999999999999.99', '21000000000000.00']) {
    const nanos = xecToNanos(value);
    assert.equal(nanosToXec(nanos), value);
    assert.equal(requireAtoms(nanos) * NANOS_PER_ATOM, nanos);
  }
  assert.equal(xecToNanos('20999999999999.99'), 20_999_999_999_999_990_000_000n);
  assert.equal(xecToNanos('-5.46'), -5_460_000_000n);
  assert.equal(xecToNanos('5.4'), 5_400_000_000n);
  assert.equal(parseNanos(MAX_MONEY_NANOS.toString()), MAX_MONEY_NANOS);
});

test('monetary boundaries reject precision loss, subatomic withdrawals, and malformed values', () => {
  for (const value of ['', ' 1', '1 ', '01', '+1', '-1', '1e9', '1.0', 'NaN', (MAX_MONEY_NANOS + 1n).toString()]) {
    assert.throws(() => parseNanos(value), paymentCode('invalid_amount'), value);
  }
  assert.throws(() => parseNanos('0'), paymentCode('invalid_amount'));
  assert.equal(parseNanos('0', 'balance', true), 0n);
  for (const value of [1, 0.01, '1e2', '0.001', '-0.001', '01.00', '21000000000000.01', 'Infinity', '1.']) {
    assert.throws(() => xecToNanos(value), paymentCode('invalid_amount'), String(value));
  }
  for (const value of [-NANOS_PER_ATOM, 1n, NANOS_PER_ATOM + 1n]) {
    assert.throws(() => nanosToXec(value), paymentCode('subatomic_withdrawal'));
  }
});

test('transaction identifiers reject ambiguous or malformed values', () => {
  assert.equal(txid('ab'.repeat(32)), 'ab'.repeat(32));
  for (const value of ['AB'.repeat(32), 'ab'.repeat(31), 'ag'.repeat(32)]) assert.throws(() => txid(value), paymentCode('invalid_txid'));
});

test('programmatic payment configuration rejects wrong seeds, networks, endpoints, and inexact fee ceilings', () => {
  const seed = createHash('sha256').update('Zoko public unit test seed; never fund').digest('hex');
  const config = readPaymentsConfig({ XEC_WALLET_SEED_HEX: seed });
  assert.equal(config.walletSeedHex, seed);
  assert.equal(config.network, 'mainnet');
  assert.equal(config.requireFinalized, true);
  assert.equal(config.feeRateXecPerKb, '10.00');
  for (const env of [
    { XEC_NETWORK: 'bitcoin' }, { XEC_CONFIRMATIONS: '-1' }, { XEC_CONFIRMATIONS: '1.5' },
    { XEC_REQUIRE_FINALIZED: 'yes' }, { ZOKO_PAYMENTS_ENABLED: '1' },
    { XEC_WALLET_SEED_HEX: '00' }, { XEC_WALLET_SEED_HEX: seed.toUpperCase() },
    { ABC_RPC_PASSWORD: 'obsolete-test-configuration' },
    { CHRONIK_URLS: 'https://user:secret@chronik.e.cash' },
    { CHRONIK_URLS: 'https://chronik.e.cash?key=secret' }, { CHRONIK_URLS: 'https://chronik.e.cash,' },
    { XEC_FEE_RATE: '0.00' }, { XEC_FEE_RATE: '10.001' },
    { XEC_FEE_RATE: '10.00', XEC_MAX_FEE_RATE: '9.99' }, { XEC_MAX_FEE_NANOS: '10000001' },
  ]) assert.throws(() => readPaymentsConfig({ XEC_WALLET_SEED_HEX: seed, ...env }), PaymentError, JSON.stringify(env));
  assert.equal(trustedUrl('http://127.0.0.1:8332/', 'Chronik'), 'http://127.0.0.1:8332');
  for (const url of ['file:///etc/passwd', 'ftp://localhost', 'http://localhost/#secret', '/relative']) {
    assert.throws(() => trustedUrl(url, 'Chronik'), paymentCode('configuration'));
  }
});

test('response size bound applies to chunked data without a declared content length', async () => {
  const response = new Response(new ReadableStream<Uint8Array>({
    start(controller) { controller.enqueue(new Uint8Array(5)); controller.enqueue(new Uint8Array(6)); controller.close(); },
  }));
  await assert.rejects(boundedBody(response, 10), paymentCode('upstream_response_limit'));
  assert.deepEqual(await boundedBody(new Response(new Uint8Array([1, 2, 3])), 3), new Uint8Array([1, 2, 3]));
});

function plainTransaction(): Tx {
  return {
    txid: '12'.repeat(32), version: 2, lockTime: 0, timeFirstSeen: 0, size: 192,
    isCoinbase: false, isFinal: true, tokenStatus: 'TOKEN_STATUS_NON_TOKEN', tokenEntries: [], tokenFailedParsings: [],
    inputs: [{ prevOut: { txid: '34'.repeat(32), outIdx: 0 }, inputScript: '', outputScript: '51', sats: 1000n, sequenceNo: 0xffffffff }],
    outputs: [{ sats: 546n, outputScript: '51' }],
  };
}

test('validation accepts NORMAL only with entirely absent token data; indexed reads stay strict', () => {
  const native = plainTransaction(); native.tokenStatus = 'TOKEN_STATUS_NORMAL';
  assert.throws(() => assertPlainXec(native), paymentCode('unsupported_token_transaction'));
  assert.doesNotThrow(() => assertPlainXec(native, 'validation'));
  for (const tokenStatus of ['TOKEN_STATUS_NOT_NORMAL', 'TOKEN_STATUS_UNKNOWN'] as const) {
    assert.throws(() => assertPlainXec({ ...native, tokenStatus }, 'validation'), paymentCode('unsupported_token_transaction'));
  }
  const tokenEntry = { tokenId: 'ab'.repeat(32) } as Tx['tokenEntries'][number];
  const parsing = { pushdataIdx: 0, bytes: '', error: 'invalid token prefix' };
  assert.throws(() => assertPlainXec({ ...native, tokenEntries: [tokenEntry] }, 'validation'), paymentCode('unsupported_token_transaction'));
  assert.throws(() => assertPlainXec({ ...native, tokenFailedParsings: [parsing] }, 'validation'), paymentCode('unsupported_token_transaction'));
});

test('native XEC policy rejects zero-quantity token mint batons on either side', () => {
  const token: Token = {
    tokenId: 'cdcdcdcdcdc9dda4c92bb1145aa84945c024346ea66fd4b699e344e45df2e145',
    tokenType: { protocol: 'ALP', type: 'ALP_TOKEN_TYPE_STANDARD', number: 0 },
    atoms: 0n, isMintBaton: true,
  };
  assert.doesNotThrow(() => assertPlainXec(plainTransaction()));
  for (const side of ['inputs', 'outputs'] as const) {
    const value = plainTransaction(); value[side][0]!.token = token;
    assert.throws(() => assertPlainXec(value), paymentCode('unsupported_token_transaction'));
    value.tokenStatus = 'TOKEN_STATUS_NORMAL';
    assert.throws(() => assertPlainXec(value, 'validation'), paymentCode('unsupported_token_transaction'));
  }
  const invalid = plainTransaction(); invalid.tokenStatus = 'TOKEN_STATUS_NOT_NORMAL';
  assert.throws(() => assertPlainXec(invalid), paymentCode('unsupported_token_transaction'));
  const parsed = plainTransaction(); parsed.tokenFailedParsings = [{ pushdataIdx: 0, bytes: '00', error: 'invalid token' }];
  assert.throws(() => assertPlainXec(parsed), paymentCode('unsupported_token_transaction'));
});

test('Chronik gateway preserves protobuf bytes and reports 404 as failure, never token capability', async () => {
  await serve((req, res) => {
    assert.equal(req.headers['content-type'], 'application/x-protobuf');
    if (req.url?.startsWith('/token/')) { res.statusCode = 404; res.end('remote diagnostic'); }
    else if (req.url === '/chronik-info') res.end(Buffer.from([10, 5, ...Buffer.from('0.1.0')]));
    else res.end(Buffer.from([8, 1, 16, 2]));
  }, async url => {
    const gateway = new ChronikGateway(url, 1000);
    assert.deepEqual(await gateway.request('/raw', 'GET'), new Uint8Array([8, 1, 16, 2]));
    assert.deepEqual(await gateway.client.chronikInfo(), { version: '0.1.0' });
    await assert.rejects(gateway.request(`/token/${'0'.repeat(64)}`, 'GET'), error => {
      assert.ok(error instanceof ChronikHttpError);
      assert.equal(error.httpStatus, 404);
      assert.doesNotMatch(error.message, /diagnostic/);
      return true;
    });
  });
});

test('Chronik gateway refuses redirects and aborts a stalled body', async () => {
  let redirected = 0;
  await serve((_req, res) => { redirected++; res.end(); }, async destination => {
    await serve((_req, res) => { res.writeHead(302, { location: destination }); res.end(); }, async url => {
      await assert.rejects(new ChronikGateway(url, 1000).request('/tx/id', 'GET'), paymentCode('chronik_unavailable'));
    });
  });
  assert.equal(redirected, 0);
  await serve((_req, res) => { res.writeHead(200); res.write(Buffer.from([8])); }, async url => {
    await assert.rejects(new ChronikGateway(url, 80).request('/tx/id', 'GET'), paymentCode('chronik_unavailable'));
  });
});

test('withdrawal addresses require explicit network and canonical supported scripts', () => {
  const hash = '12'.repeat(20);
  for (const [network, prefix] of [['mainnet', 'ecash'], ['testnet', 'ectest'], ['regtest', 'ecregtest']] as const) {
    for (const type of ['p2pkh', 'p2sh'] as const) {
      const address = encodeCashAddress(prefix, type, hash);
      const script = type === 'p2pkh' ? `76a914${hash}88ac` : `a914${hash}87`;
      assert.equal(canonicalAddress(address, network), address);
      assert.equal(canonicalAddress(address.toUpperCase(), network), address);
      assert.equal(addressScript(address, network), script);
      assert.equal(scriptAddress(script, network), address);
      assert.throws(() => canonicalAddress(address.split(':')[1]!, network), paymentCode('invalid_address'));
    }
  }
  for (const value of [
    encodeCashAddress('bitcoincash', 'p2pkh', hash),
    encodeCashAddress('ectest', 'p2pkh', hash),
    encodeCashAddress('ecash', 'p2pkh', '12'.repeat(24)),
    encodeCashAddress('ecash', 'p2pkh', hash).replace(/.$/, 'x'),
    `${encodeCashAddress('ecash', 'p2pkh', hash)}?amount=1`,
  ]) assert.throws(() => canonicalAddress(value, 'mainnet'), paymentCode('invalid_address'));
  assert.equal(scriptAddress('6a', 'mainnet'), null);
});

test('transaction ID hashing matches the upstream published historical transaction vector', () => {
  // Bitcoin ABC modules/bitcoinsuite-chronik-client/tests/test_chronik_client.rs::test_raw_tx
  const raw = [
    '0100000001c997a5e56e104102fa209c6a852dd90660a20b2d9c352423edce258',
    '57fcd3704000000004847304402204e45e16932b8af514961a1d3a1a25fdf3f4f',
    '7732e9d624c6c61548ab5fb8cd410220181522ec8eca07de4860a4acdd12909d8',
    '31cc56cbbac4622082221a8768d1d0901ffffffff0200ca9a3b00000000434104',
    'ae1a62fe09c5f51b13905f07f06b99a2f7159b2225f374cd378d71302fa28414e',
    '7aab37397f554a7df5f142c21c1b7303b8a0626f1baded5c72a704f7e6cd84cac',
    '00286bee0000000043410411db93e1dcdb8a016b49840f8c53bc1eb68a382e97b',
    '1482ecad7b148a6909a5cb2e0eaddfb84ccf9744464f82e160bfa9b8b64f9d4c0',
    '3f999b8643f656b412a3ac00000000',
  ].join('');
  assert.equal(transactionId(raw), 'f4184fc596403b9d638783cf57adfe4c75c605f6356fbc91338530e9831e9e16');
});

function decodedTransaction(): DecodedTransaction {
  return { txid: '12'.repeat(32), coinbase: false, size: 192, version: 2, lockTime: 0, inputs: [{ txid: '34'.repeat(32), vout: 0 }],
    outputs: [{ vout: 0, script: '51', nanos: 5_460_000_000n }] };
}

test('withdrawal verification enforces exact recipients, change, dust, and no third output', () => {
  const base = decodedTransaction();
  assert.doesNotThrow(() => verifyWithdrawalOutputs(base, '51', 5_460_000_000n, '52'));
  const change = { vout: 1, script: '52', nanos: 10_000_000_000n };
  assert.doesNotThrow(() => verifyWithdrawalOutputs({ ...base, outputs: [...base.outputs, change] }, '51', 5_460_000_000n, '52'));
  for (const outputs of [
    [], [{ ...base.outputs[0]!, nanos: 5_450_000_000n }],
    [...base.outputs, { ...base.outputs[0]!, vout: 1 }],
    [...base.outputs, change, { ...change, vout: 2 }],
    [...base.outputs, { ...change, nanos: 0n }],
    [...base.outputs, { vout: 1, script: '53', nanos: 10_000_000n }],
    [...base.outputs, { vout: 1, script: '6a', nanos: 0n }],
  ]) assert.throws(() => verifyWithdrawalOutputs({ ...base, outputs }, '51', 5_460_000_000n, '52'), paymentCode('payout_output_mismatch'));
  assert.throws(() => verifyWithdrawalOutputs(base, '51', 5_450_000_000n, '52'), paymentCode('dust_withdrawal'));
  assert.throws(() => verifyWithdrawalOutputs(base, '51', 5_460_000_000n, '51'), paymentCode('invalid_change'));
});

test('reserved-input comparison is order-independent and rejects changes or duplicates', () => {
  const a = { txid: '12'.repeat(32), vout: 0 }, b = { txid: '34'.repeat(32), vout: 1 };
  assert.doesNotThrow(() => verifyInputsUnchanged([b, a], [a, b]));
  for (const actual of [[a], [a, { ...b, vout: 2 }], [a, a]]) {
    assert.throws(() => verifyInputsUnchanged(actual, [a, b]), paymentCode('payout_input_mismatch'));
  }
});

test('Chronik and wallet must agree on the complete recipient value and script', () => {
  const decoded: DecodedTransaction = decodedTransaction();
  assert.doesNotThrow(() => verifyChronikTransaction(decoded, plainTransaction()));
  for (const patch of [
    { txid: '56'.repeat(32) }, { outputs: [] },
    { version: 1 }, { size: 193 }, { lockTime: 1 },
    { outputs: [{ sats: 547n, outputScript: '51' }] },
    { outputs: [{ sats: 546n, outputScript: '52' }] },
    { inputs: [{ ...plainTransaction().inputs[0]!, prevOut: { txid: '78'.repeat(32), outIdx: 0 } }] },
  ]) assert.throws(() => verifyChronikTransaction(decoded, { ...plainTransaction(), ...patch }), paymentCode('payment_source_mismatch'));
});

test('fee verifier uses exact totals and enforces both absolute budget and rate ceiling', () => {
  const atom = NANOS_PER_ATOM;
  assert.doesNotThrow(() => verifyFee(1000n * atom, 800n * atom, 200n * atom, 200n * atom, 1000n * atom, 200));
  const invalidCases: Parameters<typeof verifyFee>[] = [
    [1000n * atom, 801n * atom, 200n * atom, 200n * atom, 1000n * atom, 200],
    [1000n * atom, 799n * atom, 201n * atom, 200n * atom, 2000n * atom, 200],
    [1000n * atom, 799n * atom, 201n * atom, 300n * atom, 1000n * atom, 200],
    [1000n * atom, 1000n * atom, 0n, 200n * atom, 1000n * atom, 200],
    [1000n * atom, 1100n * atom, -100n * atom, 200n * atom, 1000n * atom, 200],
    [1000n * atom, 800n * atom, 200n * atom, 200n * atom, 1000n * atom, 0],
  ];
  for (const args of invalidCases) assert.throws(() => verifyFee(...args), paymentCode('payout_fee_limit'));
});


test('Chronik protobuf preserves exact native atoms and raw transaction bytes', async () => {
  const id = '12'.repeat(32), sats = 2_099_999_999_999_999n;
  const raw = Buffer.from('02000000000000000000', 'hex');
  await serve((req, res) => {
    assert.equal(req.headers['content-type'], 'application/x-protobuf');
    assert.equal(req.headers.authorization, undefined);
    if (req.url === `/raw-tx/${id}`) res.end(proto.RawTx.encode(proto.RawTx.fromPartial({ rawTx: raw })).finish());
    else if (req.url === `/tx/${id}`) res.end(proto.Tx.encode(proto.Tx.fromPartial({
      txid: Buffer.from(id, 'hex').reverse(), version: 2, isFinal: true,
      outputs: [{ sats, outputScript: Buffer.from('51', 'hex') }], tokenStatus: proto.TokenStatus.TOKEN_STATUS_NON_TOKEN,
    })).finish());
    else { res.statusCode = 404; res.end(); }
  }, async url => {
    const gateway = new ChronikGateway(url, 1000), tx = await gateway.tx(id);
    assert.equal(tx.txid, id); assert.equal(tx.outputs[0]!.sats, sats);
    assert.equal(tx.outputs[0]!.sats * NANOS_PER_ATOM, 20_999_999_999_999_990_000_000n);
    assert.deepEqual(await gateway.client.rawTx(id), { rawTx: raw.toString('hex') });
  });
});

test('Chronik broadcast sends exact bytes with token checks enabled and never retries an HTTP failure', async () => {
  const raw = Buffer.from('02000000000000000000', 'hex');
  let attempts = 0;
  await serve(async (req, res) => {
    attempts++;
    assert.equal(req.method, 'POST'); assert.equal(req.url, '/broadcast-tx');
    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(Buffer.from(chunk));
    const request = proto.BroadcastTxRequest.decode(Buffer.concat(chunks));
    assert.deepEqual(Buffer.from(request.rawTx), raw); assert.equal(request.skipTokenChecks, false);
    res.statusCode = 503; res.end('private server diagnostic');
  }, async url => {
    await assert.rejects(new ChronikGateway(url, 1000).client.broadcastTx(raw), error => {
      assert.ok(error instanceof ChronikHttpError); assert.equal(error.httpStatus, 503);
      assert.doesNotMatch(error.message, /private|diagnostic/); return true;
    });
  });
  assert.equal(attempts, 1);
});

test('Chronik aborts a stalled response before its headers arrive', async () => {
  await serve(() => undefined, async url => {
    const start = performance.now();
    await assert.rejects(new ChronikGateway(url, 80).request('/tx/id', 'GET'), paymentCode('chronik_unavailable'));
    assert.ok(performance.now() - start < 2000);
  });
});

test('Chronik bounds a declared oversized response before reading its body', async () => {
  await serve((_req, res) => { res.setHeader('content-length', 8 * 1024 * 1024 + 1); res.flushHeaders(); }, async url => {
    await assert.rejects(new ChronikGateway(url, 1000).request('/tx/id', 'GET'), paymentCode('upstream_response_limit'));
  });
});
