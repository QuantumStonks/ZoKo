import { decodeCashAddress, encodeCashAddress, getOutputScriptFromAddress, getTypeAndHashFromOutputScript } from 'ecashaddrjs';
import type { Tx as ChronikTx } from 'chronik-client';
import { networkPrefix, type PaymentsConfig } from './config.js';
import { DUST_ATOMS, NANOS_PER_ATOM, PaymentError, requireAtoms } from './money.js';
import { decodeTransaction } from './wallet.js';

export interface InputOutpoint { txid: string; vout: number }
export interface DecodedTransaction {
  txid: string;
  coinbase: boolean;
  size: number;
  version: number;
  lockTime: number;
  inputs: InputOutpoint[];
  outputs: { vout: number; script: string; nanos: bigint }[];
}

export function canonicalAddress(address: string, network: PaymentsConfig['network']): string {
  try {
    if (typeof address !== 'string' || address.length > 200 || !address.includes(':')) throw new Error();
    const decoded = decodeCashAddress(address);
    if (decoded.prefix !== networkPrefix[network] || !['p2pkh', 'p2sh'].includes(decoded.type) || decoded.hash.length !== 40) throw new Error();
    return encodeCashAddress(networkPrefix[network], decoded.type, decoded.hash);
  } catch { throw new PaymentError('invalid_address', `An explicit ${networkPrefix[network]}: P2PKH/P2SH address is required`, 400); }
}

export function addressScript(address: string, network: PaymentsConfig['network']): string {
  return getOutputScriptFromAddress(canonicalAddress(address, network));
}

export function scriptAddress(script: string, network: PaymentsConfig['network']): string | null {
  try {
    const { type, hash } = getTypeAndHashFromOutputScript(script);
    return canonicalAddress(encodeCashAddress(networkPrefix[network], type, hash), network);
  } catch { return null; }
}

export function transactionId(hex: string): string {
  return decodeTransaction(hex).txid;
}

export function decodeRawTransaction(hex: string): DecodedTransaction {
  const data = decodeTransaction(hex);
  const coinbase = data.inputs.length === 1 && data.inputs[0]!.txid === '0'.repeat(64) && data.inputs[0]!.vout === 0xffffffff;
  return {
    txid: data.txid, coinbase, inputs: data.inputs,
    size: data.size, version: data.version, lockTime: data.lockTime,
    outputs: data.outputs.map((output, vout) => ({ vout, script: output.outputScript, nanos: output.sats * NANOS_PER_ATOM })),
  };
}

export function verifyWithdrawalOutputs(
  decoded: DecodedTransaction,
  recipientScript: string,
  recipientNanos: bigint,
  changeScript: string,
): void {
  if (requireAtoms(recipientNanos) < DUST_ATOMS) throw new PaymentError('dust_withdrawal', 'Withdrawal is below the 5.46 XEC standard dust threshold', 400);
  if (recipientScript === changeScript) throw new PaymentError('invalid_change', 'Recipient and change scripts must be distinct');
  const recipients = decoded.outputs.filter(output => output.script === recipientScript);
  const changes = decoded.outputs.filter(output => output.script === changeScript);
  if (recipients.length !== 1 || recipients[0]!.nanos !== recipientNanos || changes.length > 1 ||
      decoded.outputs.length !== recipients.length + changes.length || changes.some(output => output.nanos <= 0n)) {
    throw new PaymentError('payout_output_mismatch', 'Wallet transaction does not exactly match the reserved withdrawal and allowed change');
  }
}

export function verifyInputsUnchanged(actual: InputOutpoint[], expected: InputOutpoint[]): void {
  const key = (input: InputOutpoint) => `${input.txid}:${input.vout}`;
  const expectedKeys = new Set(expected.map(key));
  const actualKeys = new Set(actual.map(key));
  if (actual.length !== expected.length || actualKeys.size !== actual.length || expectedKeys.size !== expected.length ||
      actual.some(input => !expectedKeys.has(key(input)))) {
    throw new PaymentError('payout_input_mismatch', 'Wallet transaction changed its durably reserved inputs');
  }
}

export function verifyChronikTransaction(decoded: DecodedTransaction, indexed: ChronikTx): void {
  if (decoded.txid !== indexed.txid || decoded.coinbase !== indexed.isCoinbase ||
      decoded.size !== indexed.size || decoded.version !== indexed.version || decoded.lockTime !== indexed.lockTime ||
      decoded.inputs.length !== indexed.inputs.length || decoded.inputs.some((input, i) =>
        input.txid !== indexed.inputs[i]!.prevOut.txid || input.vout !== indexed.inputs[i]!.prevOut.outIdx) ||
      decoded.outputs.length !== indexed.outputs.length ||
      decoded.outputs.some((output, i) => output.script !== indexed.outputs[i]!.outputScript ||
        typeof indexed.outputs[i]!.sats !== 'bigint' || output.nanos !== indexed.outputs[i]!.sats * NANOS_PER_ATOM)) {
    throw new PaymentError('payment_source_mismatch', 'Chronik transaction metadata does not match its locally decoded raw bytes');
  }
}

export function verifyFee(inputTotal: bigint, outputTotal: bigint, reportedFee: bigint, budget: bigint, maxRate: bigint, sizeBytes: number): void {
  const fee = inputTotal - outputTotal;
  if (fee <= 0n || fee !== reportedFee || fee > budget || !Number.isSafeInteger(sizeBytes) || sizeBytes <= 0 ||
      fee > ((maxRate / NANOS_PER_ATOM * BigInt(sizeBytes) + 999n) / 1000n) * NANOS_PER_ATOM) {
    throw new PaymentError('payout_fee_limit', 'Withdrawal fee is invalid or exceeds the reserved fee budget/rate');
  }
}
