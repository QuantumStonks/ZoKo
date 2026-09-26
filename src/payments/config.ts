import { PaymentError, nanosToXec, parseNanos, xecToNanos } from './money.js';

export interface PaymentsConfig {
  enabled: boolean;
  network: 'mainnet' | 'testnet' | 'regtest';
  rpcUrl: string;
  rpcUsername: string;
  rpcPassword: string;
  walletName: string;
  chronikUrls: string[];
  confirmations: number;
  requireFinalized: boolean;
  maxFeeNanos: string;
  feeRateXecPerKb: string;
  maxFeeRateXecPerKb: string;
  rpcTimeoutMs?: number;
  tokenProbeTxid?: string;
}

export const networkPrefix = { mainnet: 'ecash', testnet: 'ectest', regtest: 'ecregtest' } as const;
export const rpcChain = { mainnet: 'main', testnet: 'test', regtest: 'regtest' } as const;

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
  // These endpoints intentionally may be private: they are operator configuration, never user-controlled.
  return url.href.replace(/\/$/, '');
}

export function readPaymentsConfig(env: NodeJS.ProcessEnv): PaymentsConfig {
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
  const walletName = env.ABC_RPC_WALLET || 'zoko';
  if (!/^[a-zA-Z0-9_.-]{1,100}$/.test(walletName)) throw new PaymentError('configuration', 'ABC_RPC_WALLET must be a simple dedicated wallet name');
  return {
    enabled,
    network: network as PaymentsConfig['network'],
    rpcUrl: trustedUrl(env.ABC_RPC_URL || 'http://127.0.0.1:8332', 'ABC_RPC_URL'),
    rpcUsername: env.ABC_RPC_USERNAME || '',
    rpcPassword: env.ABC_RPC_PASSWORD || '',
    walletName,
    chronikUrls: (env.CHRONIK_URLS || 'https://chronik.e.cash').split(',').map(url => trustedUrl(url.trim(), 'CHRONIK_URLS')),
    confirmations,
    requireFinalized: boolean(env.XEC_REQUIRE_FINALIZED, true, 'XEC_REQUIRE_FINALIZED'),
    maxFeeNanos,
    feeRateXecPerKb,
    maxFeeRateXecPerKb,
    rpcTimeoutMs: 15_000,
    tokenProbeTxid: env.XEC_TOKEN_PROBE_TXID || (network === 'mainnet' ? 'cdcdcdcdcdc9dda4c92bb1145aa84945c024346ea66fd4b699e344e45df2e145' : undefined),
  };
}
