import { createHash } from 'node:crypto';
import { decodeCashAddress, encodeCashAddress, getOutputScriptFromAddress, getTypeAndHashFromOutputScript } from 'ecashaddrjs';
import type { Tx as ChronikTx } from 'chronik-client';
import { networkPrefix, type PaymentsConfig } from './config.js';
import { DUST_ATOMS, NANOS_PER_ATOM, PaymentError, rawHex, record, requireAtoms, safeInteger, txid, xecToNanos } from './money.js';

export interface InputOutpoint { txid: string; vout: number }
export interface DecodedTransaction {
  txid: string;
  coinbase: boolean;
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
  const bytes = Buffer.from(rawHex(hex), 'hex');
  return createHash('sha256').update(createHash('sha256').update(bytes).digest()).digest().reverse().toString('hex');
}

export function decodeRpcTransaction(value: unknown): DecodedTransaction {
  const data = record(value, 'decoded transaction');
  if (!Array.isArray(data.vin) || !Array.isArray(data.vout) || data.vin.length === 0 || data.vout.length === 0) {
    throw new PaymentError('invalid_transaction', 'Decoded transaction must contain inputs and outputs');
  }
  const coinbase = data.vin.length === 1 && typeof record(data.vin[0], 'transaction input').coinbase === 'string';
  const inputs = coinbase ? [] : data.vin.map(value => {
    const input = record(value, 'transaction input');
    const vout = safeInteger(input.vout, 'input index');
    if (vout < 0 || vout > 0xffff_ffff) throw new PaymentError('invalid_transaction', 'Invalid input index');
    return { txid: txid(input.txid), vout };
  });
  if (new Set(inputs.map(input => `${input.txid}:${input.vout}`)).size !== inputs.length) {
    throw new PaymentError('invalid_transaction', 'Transaction contains duplicate inputs');
  }
  const outputs = data.vout.map((value, index) => {
    const output = record(value, 'transaction output');
    const script = record(output.scriptPubKey, 'output script').hex;
    const vout = safeInteger(output.n, 'output index');
    if (typeof script !== 'string' || !/^(?:[0-9a-f]{2})*$/.test(script) || vout !== index) {
      throw new PaymentError('invalid_transaction', 'Invalid output script or index');
    }
    const nanos = xecToNanos(output.value);
    if (nanos < 0n) throw new PaymentError('invalid_transaction', 'Negative transaction output');
    return { vout, script, nanos };
  });
  return { txid: txid(data.txid), coinbase, inputs, outputs };
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
      (!decoded.coinbase && (decoded.inputs.length !== indexed.inputs.length || decoded.inputs.some((input, i) =>
        input.txid !== indexed.inputs[i]!.prevOut.txid || input.vout !== indexed.inputs[i]!.prevOut.outIdx))) ||
      decoded.outputs.length !== indexed.outputs.length ||
      decoded.outputs.some((output, i) => output.script !== indexed.outputs[i]!.outputScript ||
        output.nanos !== indexed.outputs[i]!.sats * NANOS_PER_ATOM)) {
    throw new PaymentError('payment_source_mismatch', 'Wallet and Chronik disagree on transaction outputs');
  }
}

export function verifyFee(inputTotal: bigint, outputTotal: bigint, reportedFee: bigint, budget: bigint, maxRate: bigint, sizeBytes: number): void {
  const fee = inputTotal - outputTotal;
  if (fee <= 0n || fee !== reportedFee || fee > budget || !Number.isSafeInteger(sizeBytes) || sizeBytes <= 0 ||
      fee * 1000n > maxRate * BigInt(sizeBytes)) {
    throw new PaymentError('payout_fee_limit', 'Withdrawal fee is invalid or exceeds the reserved fee budget/rate');
  }
}
