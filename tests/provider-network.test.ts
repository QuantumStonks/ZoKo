import assert from 'node:assert/strict';
import type { LookupAddress, LookupOptions } from 'node:dns';
import test from 'node:test';
import { fetch as undiciFetch } from 'undici';
import {
  createPublicLookup, createPublicProviderAgent, evaluateRestrictedProvider,
  isPublicProviderAddress, restrictedProviderFetch, type ResolveProviderAddresses,
} from '../src/provider-network.js';
import { ProviderError } from '../src/provider.js';

test('IPv4 policy rejects private, shared, local, documentation, benchmark, multicast and reserved ranges', () => {
  for (const address of [
    '0.0.0.0', '0.255.255.255', '10.0.0.0', '10.255.255.255',
    '100.64.0.0', '100.100.100.200', '100.127.255.255', '127.0.0.1', '127.255.255.255',
    '169.254.0.0', '169.254.169.254', '169.254.255.255', '172.16.0.0', '172.31.255.255',
    '192.0.0.9', '192.0.0.255', '192.0.2.1', '192.31.196.1', '192.52.193.1',
    '192.88.99.1', '192.168.0.0', '192.168.255.255', '192.175.48.1',
    '198.18.0.0', '198.19.255.255', '198.51.100.1', '203.0.113.1',
    '224.0.0.0', '239.255.255.255', '240.0.0.0', '255.255.255.255',
  ]) assert.equal(isPublicProviderAddress(address), false, address);
});

test('IPv4 policy preserves public adjacent CIDR boundaries', () => {
  for (const address of [
    '1.1.1.1', '8.8.8.8', '9.255.255.255', '11.0.0.0', '100.63.255.255', '100.128.0.0',
    '126.255.255.255', '128.0.0.0', '169.253.255.255', '169.255.0.0', '172.15.255.255',
    '172.32.0.0', '192.167.255.255', '192.169.0.0', '198.17.255.255', '198.20.0.0',
    '223.255.255.255',
  ]) assert.equal(isPublicProviderAddress(address), true, address);
});

test('IPv6 policy rejects mapped, embedded, scope, transition, reserved and documentation forms', () => {
  for (const address of [
    '::', '::1', '::ffff:127.0.0.1', '::ffff:7f00:1', '0:0:0:0:0:ffff:c0a8:101',
    '::ffff:10.0.0.1', '::ffff:169.254.169.254', '::ffff:8.8.8.8', '::127.0.0.1',
    '64:ff9b::a9fe:a9fe', '64:ff9b:1::1', '100::1', '100:0:0:1::1',
    '2001::1', '2001:1::1', '2001:2::1', '2001:20::1', '2001:30::1', '2001:1ff:ffff::1',
    '2001:db8::1', '2001:DB8:ffff:ffff:ffff:ffff:ffff:ffff', '2001:1000::1', '2001:4e00::1',
    '2002:7f00:1::1', '2002:808:808::1', '2620:4f:8000::1', '2d00::1', '3000::1',
    '3ffe::1', '3fff::1', '3fff:ffff::1', '5f00::1', 'fc00::1', 'fdff:ffff::1',
    'fe80::1', 'febf:ffff::1', 'fec0::1', 'ff02::1', 'ff0e::1',
    'fe80::1%eth0', '2001:4860:4860::8888%eth0',
  ]) assert.equal(isPublicProviderAddress(address), false, address);
});

test('IPv6 policy accepts allocated public addresses in compressed and expanded notation', () => {
  for (const address of [
    '2001:4860:4860::8888', '2001:4860:4860:0000:0000:0000:0000:8888',
    '2606:4700:4700::1111', '2001:200::1', '2001:db7::1', '2001:db9::1',
    '2003:1::1', '2400::1', '2410::1', '2610::1', '2620:4f:7fff::1',
    '2620:4f:8001::1', '2630::1', '2800::1', '2a00::1', '2a10::1', '2c00::1',
  ]) assert.equal(isPublicProviderAddress(address), true, address);
});

test('IP parsing rejects hostnames, alternative IPv4 notation, whitespace, zones and malformed literals', () => {
  for (const address of [
    '', 'provider.example', 'localhost', '2130706433', '0177.0.0.1', '0x7f000001',
    '127.1', '127.000.000.001', '8.8.8.8 ', ' 8.8.8.8', '[::1]', '1.2.3.256',
    '2001:4860:::1', '::ffff:127.0.0.999', '2001:4860::1/64',
  ]) assert.equal(isPublicProviderAddress(address), false, address);
});

function resolveWith(records: readonly LookupAddress[], options: LookupOptions = { all: true }): Promise<{ addresses: string | LookupAddress[]; family?: number }> {
  const hook = createPublicLookup(async () => records);
  return new Promise((resolve, reject) => hook('seller.example', options, (error, addresses, family) => {
    if (error) reject(error);
    else resolve({ addresses, family });
  }));
}

test('socket lookup receives the exact approved set from one resolution', async () => {
  const records = [{ address: '8.8.8.8', family: 4 }, { address: '2606:4700:4700::1111', family: 6 }];
  let calls = 0;
  const hook = createPublicLookup(async hostname => {
    assert.equal(hostname, 'seller.example');
    calls++;
    return records;
  });
  const returned = await new Promise<LookupAddress[]>((resolve, reject) => hook('seller.example', { all: true }, (error, addresses) => {
    if (error) reject(error);
    else resolve(addresses as LookupAddress[]);
  }));
  assert.deepEqual(returned, records);
  assert.notEqual(returned, records);
  assert.equal(calls, 1);
});

test('mixed DNS sets fail closed even when private records are in the unrequested family', async () => {
  for (const records of [
    [{ address: '8.8.8.8', family: 4 }, { address: '127.0.0.1', family: 4 }],
    [{ address: '8.8.8.8', family: 4 }, { address: 'fd00::1', family: 6 }],
    [{ address: '2606:4700:4700::1111', family: 6 }, { address: '169.254.169.254', family: 4 }],
    [{ address: '8.8.8.8', family: 4 }, { address: '::ffff:7f00:1', family: 6 }],
  ]) {
    await assert.rejects(resolveWith(records), { code: 'ERR_PROVIDER_ADDRESS_BLOCKED' });
    await assert.rejects(resolveWith(records, { family: 4 }), { code: 'ERR_PROVIDER_ADDRESS_BLOCKED' });
  }
});

test('lookup rejects empty, malformed, oversized and family-mismatched results', async () => {
  for (const records of [
    [], [{ address: '8.8.8.8', family: 6 }], [{ address: 'example.com', family: 4 }],
    [{ address: '2606:4700:4700::1111', family: 4 }],
    Array.from({ length: 257 }, () => ({ address: '8.8.8.8', family: 4 })),
  ]) await assert.rejects(resolveWith(records), { code: 'ERR_PROVIDER_ADDRESS_BLOCKED' });
});

test('lookup honors socket all/family shape only after validating the complete set', async () => {
  const records = [{ address: '8.8.8.8', family: 4 }, { address: '2606:4700:4700::1111', family: 6 }];
  assert.deepEqual(await resolveWith(records, {}), { addresses: '8.8.8.8', family: 4 });
  assert.deepEqual(await resolveWith(records, { family: 6 }), { addresses: '2606:4700:4700::1111', family: 6 });
  assert.deepEqual(await resolveWith(records, { all: true, family: 4 }), { addresses: [records[0]], family: undefined });
  await assert.rejects(resolveWith([records[0]], { family: 6 }), { code: 'ERR_PROVIDER_ADDRESS_BLOCKED' });
});

test('a later DNS rebind is validated again at the next socket lookup', async () => {
  let calls = 0;
  const hook = createPublicLookup(async () => ++calls === 1
    ? [{ address: '8.8.8.8', family: 4 }]
    : [{ address: '127.0.0.1', family: 4 }]);
  const run = () => new Promise((resolve, reject) => hook('seller.example', { all: true }, (error, addresses) => error ? reject(error) : resolve(addresses)));
  assert.deepEqual(await run(), [{ address: '8.8.8.8', family: 4 }]);
  await assert.rejects(run(), { code: 'ERR_PROVIDER_ADDRESS_BLOCKED' });
  assert.equal(calls, 2);
});

test('real dedicated undici Agent invokes the guarded lookup before opening a socket', async () => {
  let calls = 0;
  const resolver: ResolveProviderAddresses = async hostname => {
    assert.equal(hostname, 'blocked-provider.invalid');
    calls++;
    return [{ address: '127.0.0.1', family: 4 }];
  };
  const agent = createPublicProviderAgent(resolver);
  try {
    const options = { dispatcher: agent, signal: AbortSignal.timeout(1000), redirect: 'error' as const };
    await assert.rejects(undiciFetch('https://blocked-provider.invalid/v1/systemone', options), error => {
      assert(error instanceof TypeError);
      assert.equal((error.cause as NodeJS.ErrnoException).code, 'ERR_PROVIDER_ADDRESS_BLOCKED');
      return true;
    });
    assert.equal(calls, 1);
  } finally {
    await agent.destroy();
  }
});

test('restricted entrypoints reject URL forms which bypass DNS pinning', async () => {
  const input = { state: 'x', questions: { question: { type: 'noul' as const } } };
  for (const endpoint of [
    'http://provider.example/v1/systemone', 'https://provider.example:8443/v1/systemone',
    'https://127.0.0.1/v1/systemone', 'https://8.8.8.8/v1/systemone',
    'https://[::ffff:127.0.0.1]/v1/systemone', 'https://[2606:4700:4700::1111]/v1/systemone',
    'https://0x7f000001/v1/systemone', 'https://0177.0.0.1/v1/systemone',
    'https://user:secret@provider.example/v1/systemone', 'https://provider.example/v1/systemone#other',
  ]) {
    await assert.rejects(evaluateRestrictedProvider({ endpoint, apiKey: 'test-key', model: 'jev-1.13.0' }, input, 1000), error => error instanceof ProviderError && error.code === 'provider_configuration');
    assert.throws(() => restrictedProviderFetch(endpoint), error => error instanceof ProviderError && error.code === 'provider_configuration');
  }
});
