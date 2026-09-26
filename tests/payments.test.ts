import assert from 'node:assert/strict';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { once } from 'node:events';
import type { AddressInfo } from 'node:net';
import test from 'node:test';
import type { Token, Tx } from 'chronik-client';
import { encodeCashAddress } from 'ecashaddrjs';
import {
  MAX_MONEY_NANOS, NANOS_PER_ATOM, PaymentError, nanosToXec, parseNanos,
  rawHex, record, requireAtoms, safeInteger, txid, xecToNanos,
} from '../src/payments/money.js';
import { readPaymentsConfig, trustedUrl } from '../src/payments/config.js';
import { AbcRpc, RpcError, boundedBody, parseExactJson } from '../src/payments/rpc.js';
import { ChronikGateway, ChronikHttpError, assertPlainXec } from '../src/payments/chronik.js';
import {
  addressScript, canonicalAddress, decodeRpcTransaction, scriptAddress, transactionId,
  verifyChronikTransaction, verifyFee, verifyInputsUnchanged, verifyWithdrawalOutputs,
  type DecodedTransaction,
} from '../src/payments/verification.js';

type Handler = (req: IncomingMessage, res: ServerResponse) => void | Promise<void>;

/** Real loopback sockets exercise fetch, redirects, aborts, and wire-level numeric tokens. */
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

async function rpcRequest(req: IncomingMessage): Promise<{ id: string; method: string; params: unknown[] }> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(Buffer.from(chunk));
  return JSON.parse(Buffer.concat(chunks).toString('utf8')) as { id: string; method: string; params: unknown[] };
}

function rpc(url: string, timeoutMs = 1000): AbcRpc {
  return new AbcRpc({
    ...readPaymentsConfig({ ABC_RPC_URL: url, ABC_RPC_USERNAME: 'rpc-user', ABC_RPC_PASSWORD: 'rpc-secret' }),
    rpcTimeoutMs: timeoutMs,
  });
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
    assert.throws(() => xecToNanos(value), paymentCode('invalid_rpc_amount'), String(value));
  }
  for (const value of [-NANOS_PER_ATOM, 1n, NANOS_PER_ATOM + 1n]) {
    assert.throws(() => nanosToXec(value), paymentCode('subatomic_withdrawal'));
  }
});

test('exact JSON preserves numeric lexemes including decimals above JavaScript precision', () => {
  const parsed = parseExactJson('{"amount":20999999999999.99,"atoms":2099999999999999,"negative":-0.01,"exponent":1e20,"ok":true,"empty":null,"text":"123"}');
  assert.deepEqual(parsed, {
    amount: '20999999999999.99', atoms: '2099999999999999', negative: '-0.01', exponent: '1e20', ok: true, empty: null, text: '123',
  });
  assert.equal(xecToNanos(record(parsed, 'test').amount), 20_999_999_999_999_990_000_000n);
  assert.throws(() => xecToNanos(record(parsed, 'test').exponent), paymentCode('invalid_rpc_amount'));
  assert.throws(() => parseExactJson('{"amount":NaN}'), SyntaxError);
});

test('identifier and RPC structure guards reject ambiguous or unsafe values', () => {
  assert.equal(safeInteger('9007199254740991', 'height'), Number.MAX_SAFE_INTEGER);
  for (const value of ['9007199254740992', '1.0', '1e3', 1, null]) {
    assert.throws(() => safeInteger(value, 'height'), paymentCode('invalid_rpc_response'));
  }
  for (const value of [null, [], 'object', 3]) assert.throws(() => record(value, 'RPC'), paymentCode('invalid_rpc_response'));
  assert.equal(txid('ab'.repeat(32)), 'ab'.repeat(32));
  for (const value of ['AB'.repeat(32), 'ab'.repeat(31), 'ag'.repeat(32)]) assert.throws(() => txid(value), paymentCode('invalid_txid'));
  assert.equal(rawHex('00'.repeat(10)), '00'.repeat(10));
  for (const value of ['ab'.repeat(9), 'f'.repeat(21), 'AA'.repeat(10), '00'.repeat(100_001)]) {
    assert.throws(() => rawHex(value), paymentCode('invalid_transaction'));
  }
});

test('payment configuration rejects wrong networks, embedded credentials, and inexact fee ceilings', () => {
  const config = readPaymentsConfig({});
  assert.equal(config.network, 'mainnet');
  assert.equal(config.requireFinalized, true);
  assert.equal(config.feeRateXecPerKb, '10.00');
  for (const env of [
    { XEC_NETWORK: 'bitcoin' }, { XEC_CONFIRMATIONS: '0' }, { XEC_CONFIRMATIONS: '1.5' },
    { XEC_REQUIRE_FINALIZED: 'yes' }, { ZOKO_PAYMENTS_ENABLED: '1' },
    { ABC_RPC_WALLET: '../treasury' }, { ABC_RPC_URL: 'http://user:secret@localhost:8332' },
    { CHRONIK_URLS: 'https://chronik.e.cash?key=secret' }, { CHRONIK_URLS: 'https://chronik.e.cash,' },
    { XEC_FEE_RATE: '0.00' }, { XEC_FEE_RATE: '10.001' },
    { XEC_FEE_RATE: '10.00', XEC_MAX_FEE_RATE: '9.99' }, { XEC_MAX_FEE_NANOS: '10000001' },
  ]) assert.throws(() => readPaymentsConfig(env), PaymentError, JSON.stringify(env));
  assert.equal(trustedUrl('http://127.0.0.1:8332/', 'RPC'), 'http://127.0.0.1:8332');
  for (const url of ['file:///etc/passwd', 'ftp://localhost', 'http://localhost/#secret', '/relative']) {
    assert.throws(() => trustedUrl(url, 'RPC'), paymentCode('configuration'));
  }
});

test('RPC uses dedicated wallet path and exact decimal string parameters over real HTTP', async () => {
  let called = 0;
  await serve(async (req, res) => {
    called++;
    assert.equal(req.method, 'POST');
    assert.equal(req.url, '/wallet/zoko');
    assert.equal(req.headers.authorization, `Basic ${Buffer.from('rpc-user:rpc-secret').toString('base64')}`);
    const request = await rpcRequest(req);
    assert.equal(request.method, 'fundrawtransaction');
    assert.deepEqual(request.params, ['00'.repeat(10), { feeRate: '10.00' }]);
    res.setHeader('content-type', 'application/json');
    res.end(`{"id":${JSON.stringify(request.id)},"error":null,"result":{"amount":20999999999999.99,"fee":-5.46,"confirmations":6}}`);
  }, async url => {
    assert.deepEqual(await rpc(url).call('fundrawtransaction', ['00'.repeat(10), { feeRate: '10.00' }]), {
      amount: '20999999999999.99', fee: '-5.46', confirmations: '6',
    });
  });
  assert.equal(called, 1);
});

test('RPC rejects an unrelated response ID', async () => {
  await serve((_req, res) => { res.end('{"id":"another-request","error":null,"result":true}'); }, async url => {
    await assert.rejects(rpc(url).call('getcurrencyinfo'), paymentCode('rpc_id_mismatch'));
  });
});

test('RPC error responses retain numeric code and never expose remote diagnostics', async () => {
  await serve(async (req, res) => {
    const request = await rpcRequest(req);
    res.statusCode = 500;
    res.end(JSON.stringify({ id: request.id, result: null, error: { code: -4, message: 'wallet private rpc-secret detail' } }));
  }, async url => {
    await assert.rejects(rpc(url).call('fundrawtransaction'), error => {
      assert.ok(error instanceof RpcError);
      assert.equal(error.rpcCode, -4);
      assert.doesNotMatch(error.message, /rpc-secret|private|detail/);
      return true;
    });
  });
});

test('RPC refuses redirects without forwarding wallet credentials or making a second request', async () => {
  let destinationRequests = 0;
  await serve((_req, res) => { destinationRequests++; res.end('unexpected'); }, async destination => {
    await serve((_req, res) => { res.writeHead(307, { location: destination }); res.end(); }, async url => {
      await assert.rejects(rpc(url).call('sendrawtransaction'), paymentCode('wallet_rpc_unavailable'));
    });
  });
  assert.equal(destinationRequests, 0);
});

test('RPC timeouts are bounded before headers and during response streaming', async () => {
  for (const streaming of [false, true]) {
    await serve((_req, res) => {
      if (streaming) { res.writeHead(200, { 'content-type': 'application/json' }); res.write('{"result":'); }
    }, async url => {
      const start = performance.now();
      await assert.rejects(rpc(url, 80).call('gettransaction'), paymentCode('wallet_rpc_unavailable'));
      assert.ok(performance.now() - start < 2000);
    });
  }
});

test('RPC malformed JSON, invalid UTF-8, missing result, and oversized response fail closed', async () => {
  for (const mode of ['malformed', 'utf8', 'missing', 'large']) {
    await serve(async (req, res) => {
      const request = await rpcRequest(req);
      if (mode === 'malformed') res.end('private rpc-secret: not JSON');
      if (mode === 'utf8') res.end(Buffer.from([0xff, 0xfe]));
      if (mode === 'missing') res.end(JSON.stringify({ id: request.id, error: null }));
      if (mode === 'large') { res.setHeader('content-length', 16 * 1024 * 1024 + 1); res.flushHeaders(); }
    }, async url => {
      const expected = mode === 'large' ? 'upstream_response_limit' : mode === 'missing' ? 'wallet_rpc_http' : 'invalid_rpc_response';
      await assert.rejects(rpc(url).call('gettransaction'), error => {
        assert.ok(error instanceof PaymentError);
        assert.equal(error.code, expected);
        assert.doesNotMatch(error.message, /rpc-secret|private/);
        return true;
      });
    });
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

function rpcDecoded(): Record<string, unknown> {
  return {
    txid: '12'.repeat(32),
    vin: [{ txid: '34'.repeat(32), vout: '0' }],
    vout: [{ n: '0', value: '5.46', scriptPubKey: { hex: '51' } }],
  };
}

test('decoded transaction checks forbid duplicate inputs, malformed vouts, and rounded amounts', () => {
  const valid = decodeRpcTransaction(rpcDecoded());
  assert.equal(valid.outputs[0]!.nanos, 5_460_000_000n);
  const firstInput = { txid: '34'.repeat(32), vout: '0' };
  for (const patch of [
    { vin: [] }, { vout: [] }, { vin: [firstInput, firstInput] },
    { vin: [{ ...firstInput, vout: '-1' }] }, { vin: [{ ...firstInput, vout: '4294967296' }] },
    { vout: [{ n: '1', value: '5.46', scriptPubKey: { hex: '51' } }] },
    { vout: [{ n: '0', value: '-5.46', scriptPubKey: { hex: '51' } }] },
    { vout: [{ n: '0', value: 5.46, scriptPubKey: { hex: '51' } }] },
    { vout: [{ n: '0', value: '5.461', scriptPubKey: { hex: '51' } }] },
    { vout: [{ n: '0', value: '5.46', scriptPubKey: { hex: '5g' } }] },
  ]) assert.throws(() => decodeRpcTransaction({ ...rpcDecoded(), ...patch }), PaymentError);
});

test('withdrawal verification enforces exact recipients, change, dust, and no third output', () => {
  const base = decodeRpcTransaction(rpcDecoded());
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
  const decoded: DecodedTransaction = decodeRpcTransaction(rpcDecoded());
  assert.doesNotThrow(() => verifyChronikTransaction(decoded, plainTransaction()));
  for (const patch of [
    { txid: '56'.repeat(32) }, { outputs: [] },
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
