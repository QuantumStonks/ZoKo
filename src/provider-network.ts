import { lookup } from 'node:dns/promises';
import type { LookupAddress } from 'node:dns';
import { BlockList, isIP, type LookupFunction } from 'node:net';
import { Agent, fetch as undiciFetch, type RequestInit as UndiciRequestInit } from 'undici';
import { evaluateProvider, ProviderError, type Provider, type ProviderResult } from './provider.js';
import type { DecisionInput } from './protocol.js';

// Registry snapshot checked 2026-09-27. These are intentionally conservative:
// special-purpose anycast and translation mechanisms are not provider destinations.
// https://www.iana.org/assignments/iana-ipv4-special-registry/
// https://www.iana.org/assignments/iana-ipv6-special-registry/
// https://www.iana.org/assignments/ipv6-unicast-address-assignments/
const ipv4Excluded = new BlockList();
for (const [address, prefix] of [
  ['0.0.0.0', 8], ['10.0.0.0', 8], ['100.64.0.0', 10], ['127.0.0.0', 8],
  ['169.254.0.0', 16], ['172.16.0.0', 12], ['192.0.0.0', 24], ['192.0.2.0', 24],
  ['192.31.196.0', 24], ['192.52.193.0', 24], ['192.88.99.0', 24], ['192.168.0.0', 16],
  ['192.175.48.0', 24], ['198.18.0.0', 15], ['198.51.100.0', 24], ['203.0.113.0', 24],
  ['224.0.0.0', 4], ['240.0.0.0', 4],
] as const) ipv4Excluded.addSubnet(address, prefix, 'ipv4');

// Allow only currently allocated RIR global-unicast prefixes. An allowlist also
// rejects unassigned/reserved space, IPv4-mapped/compatible addresses, NAT64,
// Teredo, 6to4, multicast, local scope, old 6bone, and future allocations.
const ipv6Allocated = new BlockList();
for (const [address, prefix] of [
  ['2001:200::', 23], ['2001:400::', 23], ['2001:600::', 23], ['2001:800::', 22],
  ['2001:c00::', 23], ['2001:e00::', 23], ['2001:1200::', 23], ['2001:1400::', 22],
  ['2001:1800::', 23], ['2001:1a00::', 23], ['2001:1c00::', 22], ['2001:2000::', 19],
  ['2001:4000::', 23], ['2001:4200::', 23], ['2001:4400::', 23], ['2001:4600::', 23],
  ['2001:4800::', 23], ['2001:4a00::', 23], ['2001:4c00::', 23], ['2001:5000::', 20],
  ['2001:8000::', 19], ['2001:a000::', 20], ['2001:b000::', 20], ['2003::', 18],
  ['2400::', 12], ['2410::', 12], ['2600::', 12], ['2610::', 23], ['2620::', 23],
  ['2630::', 12], ['2800::', 12], ['2a00::', 12], ['2a10::', 12], ['2c00::', 12],
] as const) ipv6Allocated.addSubnet(address, prefix, 'ipv6');
const ipv6Excluded = new BlockList();
ipv6Excluded.addSubnet('2001:db8::', 32, 'ipv6');
ipv6Excluded.addSubnet('2620:4f:8000::', 48, 'ipv6');

/** Public unicast address policy, using Node's IP parser rather than string prefixes. */
export function isPublicProviderAddress(address: string): boolean {
  if (typeof address !== 'string' || address.includes('%')) return false;
  const family = isIP(address);
  if (family === 4) return !ipv4Excluded.check(address, 'ipv4');
  return family === 6 && ipv6Allocated.check(address, 'ipv6') && !ipv6Excluded.check(address, 'ipv6');
}

export type ResolveProviderAddresses = (hostname: string) => Promise<readonly LookupAddress[]>;
const systemResolveAll: ResolveProviderAddresses = hostname => lookup(hostname, {
  all: true, family: 0, hints: 0, order: 'verbatim',
});

function lookupError(message: string, code = 'ERR_PROVIDER_ADDRESS_BLOCKED'): NodeJS.ErrnoException {
  return Object.assign(new Error(message), { code });
}

/**
 * This function is the socket's lookup, not a preflight DNS check. Every address
 * returned by the OS lookup must be public before any address reaches net/tls.
 * Family selection occurs only after validation of the complete resolved set.
 */
export function createPublicLookup(resolveAll: ResolveProviderAddresses = systemResolveAll): LookupFunction {
  return (hostname, options, callback) => {
    const finish = async (): Promise<LookupAddress[]> => {
      if (!hostname || isIP(hostname) !== 0 || hostname.includes('%') || hostname.includes('[')) {
        throw lookupError('Provider lookup requires a DNS hostname');
      }
      const addresses = await resolveAll(hostname);
      if (!Array.isArray(addresses) || addresses.length === 0 || addresses.length > 256) {
        throw lookupError('Provider hostname returned an invalid address set');
      }
      for (const record of addresses) {
        if (!record || (record.family !== 4 && record.family !== 6)
          || isIP(record.address) !== record.family || !isPublicProviderAddress(record.address)) {
          throw lookupError('Provider hostname resolved to a prohibited address');
        }
      }
      const requestedFamily = options.family === 'IPv4' ? 4 : options.family === 'IPv6' ? 6 : options.family ?? 0;
      if (![0, 4, 6].includes(requestedFamily)) throw lookupError('Unsupported address family');
      const selected = addresses.filter(record => requestedFamily === 0 || record.family === requestedFamily)
        .map(record => ({ address: record.address, family: record.family }));
      if (selected.length === 0) throw lookupError('Provider has no address in the requested family', 'EAI_ADDRFAMILY');
      return selected;
    };
    void finish().then(
      addresses => {
        if (options.all) callback(null, addresses);
        else callback(null, addresses[0].address, addresses[0].family);
      },
      () => callback(lookupError('Provider name resolution failed or returned a prohibited address'), options.all ? [] : ''),
    );
  };
}

/** A dedicated direct connection pool, independent of global or environment proxies. */
export function createPublicProviderAgent(resolveAll: ResolveProviderAddresses = systemResolveAll): Agent {
  return new Agent({
    connections: 8,
    pipelining: 1,
    maxOrigins: 64,
    connect: {
      lookup: createPublicLookup(resolveAll),
      autoSelectFamily: true,
      rejectUnauthorized: true,
      timeout: 10_000,
    },
    headersTimeout: 60_000,
    bodyTimeout: 60_000,
    maxHeaderSize: 16_384,
  });
}

const providerAgent = createPublicProviderAgent();

function assertProviderUrl(resource: Parameters<typeof fetch>[0]): void {
  let url: URL;
  try {
    url = new URL(typeof resource === 'string' || resource instanceof URL ? resource : resource.url);
  } catch {
    throw new ProviderError('provider_configuration', 'Provider endpoint is not an absolute URL');
  }
  // IP literals skip Node's lookup hook. Disallow them, including URL-normalized
  // hexadecimal/octal IPv4 notation, to ensure all connections use the guard.
  const host = url.hostname.replace(/^\[|\]$/g, '');
  if (url.protocol !== 'https:' || (url.port !== '' && url.port !== '443') || !host
    || isIP(host) !== 0 || url.username || url.password || url.hash || host.includes('%')) {
    throw new ProviderError('provider_configuration', 'Provider requires a DNS hostname over HTTPS on port 443');
  }
}

/**
 * The caller must also enforce its exact hostname allowlist. This transport only
 * admits public DNS destinations, preserves TLS hostname verification, and pins
 * each new connection to the addresses returned by its guarded lookup callback.
 */
export const restrictedProviderFetch: typeof fetch = (resource, init) => {
  assertProviderUrl(resource);
  if (typeof resource !== 'string' && !(resource instanceof URL)) {
    throw new ProviderError('provider_configuration', 'Provider transport requires an explicit URL');
  }
  // Pair fetch and Agent from the same pinned undici release. Node's bundled
  // fetch can use an older dispatcher interface (Node 24 versus undici 8).
  const options = { ...init, dispatcher: providerAgent, redirect: 'error' as const };
  return undiciFetch(resource, options as UndiciRequestInit).then(response => response as unknown as Response);
};

export function evaluateRestrictedProvider(provider: Provider, input: DecisionInput, timeoutMs: number): Promise<ProviderResult> {
  return evaluateProvider(provider, input, timeoutMs, restrictedProviderFetch);
}

/** Call during graceful process shutdown, after stopping new decision requests. */
export function closeProviderConnections(): Promise<void> {
  return providerAgent.close();
}
