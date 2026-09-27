/** XEC has two on-chain decimal places; the internal ledger uses nine. */
export const NANOS_PER_XEC = 1_000_000_000n;
export const NANOS_PER_ATOM = 10_000_000n;
export const DUST_ATOMS = 546n;
export const MAX_MONEY_NANOS = 21_000_000_000_000n * NANOS_PER_XEC;

export class PaymentError extends Error {
  constructor(public readonly code: string, message: string, public readonly statusCode = 503) {
    super(message);
    this.name = 'PaymentError';
  }
}

export function parseNanos(value: string, label = 'amountNanos', allowZero = false): bigint {
  if (typeof value !== 'string' || !/^(0|[1-9][0-9]{0,39})$/.test(value)) {
    throw new PaymentError('invalid_amount', `${label} must be a canonical decimal integer string`, 400);
  }
  const amount = BigInt(value);
  if (amount > MAX_MONEY_NANOS || amount < (allowZero ? 0n : 1n)) {
    throw new PaymentError('invalid_amount', `${label} is outside the supported monetary range`, 400);
  }
  return amount;
}

export function requireAtoms(nanos: bigint): bigint {
  if (nanos < 0n || nanos % NANOS_PER_ATOM !== 0n) {
    throw new PaymentError('subatomic_withdrawal', 'On-chain amounts must be multiples of 10000000 nanoXEC (0.01 XEC)', 400);
  }
  return nanos / NANOS_PER_ATOM;
}

/** RPC Amount arguments accept decimal strings. Never convert money through Number. */
export function nanosToXec(nanos: bigint): string {
  requireAtoms(nanos);
  return `${nanos / NANOS_PER_XEC}.${((nanos % NANOS_PER_XEC) / NANOS_PER_ATOM).toString().padStart(2, '0')}`;
}

/** Parse an exact RPC lexical decimal (including its optional sign). */
export function xecToNanos(value: unknown): bigint {
  if (typeof value !== 'string' || !/^-?(0|[1-9][0-9]{0,13})(\.[0-9]{1,2})?$/.test(value)) {
    throw new PaymentError('invalid_rpc_amount', 'Bitcoin ABC returned an invalid or inexact XEC amount');
  }
  const negative = value.startsWith('-');
  const [whole, fraction = ''] = (negative ? value.slice(1) : value).split('.');
  const amount = BigInt(whole!) * NANOS_PER_XEC + BigInt(fraction.padEnd(2, '0')) * NANOS_PER_ATOM;
  if (amount > MAX_MONEY_NANOS) throw new PaymentError('invalid_rpc_amount', 'Bitcoin ABC amount exceeds the XEC monetary range');
  return negative ? -amount : amount;
}

export function safeInteger(value: unknown, field: string): number {
  if (typeof value !== 'string' || !/^-?[0-9]+$/.test(value)) {
    throw new PaymentError('invalid_rpc_response', `Bitcoin ABC returned an invalid ${field}`);
  }
  const result = Number(value);
  if (!Number.isSafeInteger(result)) throw new PaymentError('invalid_rpc_response', `Bitcoin ABC ${field} is outside the safe integer range`);
  return result;
}

export function record(value: unknown, field: string): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new PaymentError('invalid_rpc_response', `Invalid ${field} response`);
  }
  return value as Record<string, unknown>;
}

export function txid(value: unknown): string {
  if (typeof value !== 'string' || !/^[0-9a-f]{64}$/.test(value)) {
    throw new PaymentError('invalid_txid', 'Transaction ID must be 64 lowercase hexadecimal characters', 400);
  }
  return value;
}

export function rawHex(value: unknown): string {
  if (typeof value !== 'string' || value.length < 20 || value.length > 200_000 || !/^(?:[0-9a-f]{2})+$/.test(value)) {
    throw new PaymentError('invalid_transaction', 'Bitcoin ABC returned invalid transaction bytes');
  }
  return value;
}
