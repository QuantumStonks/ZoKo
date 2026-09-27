import { PaymentError, nanosToXec, parseNanos, xecToNanos } from './money.js';

export interface PaymentsConfig {
  enabled: boolean;
  network: 'mainnet' | 'testnet' | 'regtest';
  walletSeedHex: string;
  chronikUrls: string[];
  confirmations: number;
  requireFinalized: boolean;
  maxFeeNanos: string;
  feeRateXecPerKb: string;
  maxFeeRateXecPerKb: string;
  httpTimeoutMs?: number;
  tokenProbeTxid?: string;
  expectedGenesisHash: string;
}

export const networkPrefix = { mainnet: 'ecash', testnet: 'ectest', regtest: 'ecregtest' } as const;
// Bitcoin ABC's post-fork assumeutxo checkpoints distinguish XEC from BTC/BCH,
// whose mainnet genesis is shared. Regtest requires an explicit genesis instead.
export const networkCheckpoints = {
  mainnet: { height: 896800, hash: '0000000000000000297efb200794348b44bff4bfb31716cf64dc45bac0a251ea' },
  testnet: { height: 1661000, hash: '000000000000c7d18ee9b71a1ab4d8d21aa9d7587bf260e93df029ccb392d403' },
} as const;
export const MAINNET_GENESIS = '000000000019d6689c085ae165831e934ff763ae46a2a6c172b3f1b60a8ce26f';

function boolean(value: string | undefined, fallback: boolean, name: string): boolean {
  if (value === undefined || value === '') return fallback;
  if (value === 'true') return true;
  if (value === 'false') return false;
  throw new PaymentError('configuration', `${name} must be true or false`);
}

export function trustedUrl(value: string, name: string): string {
  let url: URL;
  try { url = new URL(value); } catch { throw new PaymentError('configuration', `${name} must be an absolute HTTP(S) URL`); }
  if (!['https:', 'http:'].includes(url.protocol) || url.username || url.password || url.search || url.hash) {
    throw new PaymentError('configuration', `${name} must be an HTTP(S) endpoint without URL credentials, query, or fragment`);
  }
  // Operators may explicitly configure a private hosted indexer; never accept a buyer-supplied URL.
  return url.href.replace(/\/$/, '');
}

export function readPaymentsConfig(env: NodeJS.ProcessEnv): PaymentsConfig {
  if (Object.keys(env).some(name => name.startsWith('ABC_') && env[name])) {
    throw new PaymentError('obsolete_node_configuration', 'ABC_* settings are no longer supported. Follow the documented wallet migration; do not reuse or silently replace an existing funded ledger.');
  }
  const network = env.XEC_NETWORK || 'mainnet';
  if (!['mainnet', 'testnet', 'regtest'].includes(network)) throw new PaymentError('configuration', 'XEC_NETWORK must be mainnet, testnet, or regtest');
  const confirmations = Number(env.XEC_CONFIRMATIONS || '6');
  if (!Number.isInteger(confirmations) || confirmations < 1 || confirmations > 1000) {
    throw new PaymentError('configuration', 'XEC_CONFIRMATIONS must be an integer from 1 to 1000');
  }
  const maxFeeNanos = env.XEC_MAX_FEE_NANOS || '100000000000';
  nanosToXec(parseNanos(maxFeeNanos, 'XEC_MAX_FEE_NANOS'));
  const feeRateXecPerKb = env.XEC_FEE_RATE || '10.00';
  const maxFeeRateXecPerKb = env.XEC_MAX_FEE_RATE || '100.00';
  if (xecToNanos(feeRateXecPerKb) <= 0n || xecToNanos(maxFeeRateXecPerKb) < xecToNanos(feeRateXecPerKb)) {
    throw new PaymentError('configuration', 'XEC fee rates must be positive exact XEC decimals and max rate must cover the funding rate');
  }
  const enabled = boolean(env.ZOKO_PAYMENTS_ENABLED, true, 'ZOKO_PAYMENTS_ENABLED');
  const walletSeedHex = env.XEC_WALLET_SEED_HEX || '';
  if (walletSeedHex && !/^[0-9a-f]{64}$/.test(walletSeedHex)) throw new PaymentError('configuration', 'XEC_WALLET_SEED_HEX must be 64 lowercase hexadecimal characters from a dedicated random 32-byte wallet seed');
  const expectedGenesisHash = env.XEC_GENESIS_HASH || (network === 'mainnet' ? MAINNET_GENESIS : '');
  if (expectedGenesisHash && !/^[0-9a-f]{64}$/.test(expectedGenesisHash)) throw new PaymentError('configuration', 'XEC_GENESIS_HASH must be a 64-character lowercase block hash');
  const chronikUrls = (env.CHRONIK_URLS || 'https://chronik.e.cash,https://chronik-native2.fabien.cash').split(',').map(url => trustedUrl(url.trim(), 'CHRONIK_URLS'));
  if (chronikUrls.length > 8 || new Set(chronikUrls).size !== chronikUrls.length) throw new PaymentError('configuration', 'CHRONIK_URLS must contain one to eight distinct endpoints');
  if (env.NODE_ENV === 'production' && network !== 'regtest' && chronikUrls.some(url => !url.startsWith('https://'))) {
    throw new PaymentError('configuration', 'Production mainnet/testnet Chronik endpoints require HTTPS');
  }
  return {
    enabled,
    network: network as PaymentsConfig['network'],
    walletSeedHex,
    chronikUrls,
    confirmations,
    requireFinalized: boolean(env.XEC_REQUIRE_FINALIZED, true, 'XEC_REQUIRE_FINALIZED'),
    maxFeeNanos,
    feeRateXecPerKb,
    maxFeeRateXecPerKb,
    httpTimeoutMs: 15_000,
    tokenProbeTxid: env.XEC_TOKEN_PROBE_TXID || (network === 'mainnet' ? 'cdcdcdcdcdc9dda4c92bb1145aa84945c024346ea66fd4b699e344e45df2e145' : undefined),
    expectedGenesisHash,
  };
}
