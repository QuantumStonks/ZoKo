import { createHash } from 'node:crypto';
import {
  Address, ALL_BIP143, Ecc, HdNode, P2PKHSignatory, Script, Tx as EcashTx,
  TxBuilder, UnsignedTx, sha256d, toHex, toHexRev,
} from 'ecash-lib';
import { DUST_ATOMS, MAX_MONEY_NANOS, NANOS_PER_ATOM, PaymentError, txid } from './money.js';

export type WalletNetwork = 'mainnet' | 'testnet' | 'regtest';
export type WalletBranch = 0 | 1;

const PREFIXES = { mainnet: 'ecash', testnet: 'ectest', regtest: 'ecregtest' } as const;
const MAX_INDEX = 0x7fffffff;
const MAX_ATOMS = MAX_MONEY_NANOS / NANOS_PER_ATOM;
const MAX_TRANSACTION_BYTES = 100_000;
/** Bound work and the standard transaction size before deriving or signing keys. */
export const MAX_WALLET_INPUTS = 500;

export interface WalletAddress {
  address: string;
  outputScript: string;
  branch: WalletBranch;
  index: number;
}

export interface WalletInput {
  txid: string;
  vout: number;
  sats: bigint;
  branch: WalletBranch;
  index: number;
}

export interface WithdrawalBuildRequest {
  /** The caller must verify and durably reserve these exact outpoints first. */
  inputs: WalletInput[];
  recipientAddress: string;
  recipientSats: bigint;
  /** A newly allocated, durable branch-1 index. */
  changeIndex: number;
  feeRateSatsPerKb: bigint;
  maxFeeSats: bigint;
  maxFeeRateSatsPerKb: bigint;
}

export interface DecodedTransaction {
  hex: string;
  txid: string;
  inputs: Array<{ txid: string; vout: number }>;
  outputs: Array<{ outputScript: string; sats: bigint }>;
  size: number;
  version: number;
  lockTime: number;
}

export interface BuiltWithdrawal {
  hex: string;
  txid: string;
  feeSats: bigint;
  inputs: WalletInput[];
  outputs: Array<{ outputScript: string; sats: bigint }>;
  changeAddress: string;
}

function index(value: number, field: string): void {
  if (!Number.isInteger(value) || value < 0 || value > MAX_INDEX) {
    throw new PaymentError('invalid_derivation', `${field} must be an unhardened integer index`, 400);
  }
}

function atoms(value: bigint, field: string, minimum = 1n): void {
  if (typeof value !== 'bigint' || value < minimum || value > MAX_ATOMS) {
    throw new PaymentError('invalid_amount', `${field} must be an exact amount within the XEC monetary range`, 400);
  }
}

function sha256(bytes: Uint8Array): Buffer {
  return createHash('sha256').update(bytes).digest();
}

/**
 * Decode canonical raw bytes without trusting an indexer's JSON amounts or txid.
 * This checks encoding and monetary bounds, not chain inclusion or spendability.
 */
export function decodeTransaction(hex: string): DecodedTransaction {
  if (typeof hex !== 'string' || hex.length < 20 || hex.length > MAX_TRANSACTION_BYTES * 2 ||
      !/^(?:[0-9a-f]{2})+$/.test(hex)) {
    throw new PaymentError('invalid_transaction', 'Expected a bounded, lowercase raw transaction');
  }
  let decoded: EcashTx;
  try {
    decoded = EcashTx.fromHex(hex);
    // Tx.fromHex permits trailing data and non-minimal compact integers. A byte
    // round trip rejects both before any bytes are persisted or credited.
    if (decoded.toHex() !== hex || decoded.inputs.length === 0 || decoded.outputs.length === 0) {
      throw new Error('noncanonical');
    }
  } catch {
    throw new PaymentError('invalid_transaction', 'Transaction bytes are malformed or noncanonical');
  }
  const seen = new Set<string>();
  const inputs = decoded.inputs.map(input => {
    const inputTxid = typeof input.prevOut.txid === 'string' ? input.prevOut.txid : toHexRev(input.prevOut.txid);
    const key = `${inputTxid}:${input.prevOut.outIdx}`;
    if (seen.has(key)) throw new PaymentError('invalid_transaction', 'Transaction repeats an input outpoint');
    seen.add(key);
    return { txid: inputTxid, vout: input.prevOut.outIdx };
  });
  let outputSum = 0n;
  const outputs = decoded.outputs.map(output => {
    if (output.sats < 0n || output.sats > MAX_ATOMS) {
      throw new PaymentError('invalid_transaction', 'Transaction output exceeds the XEC monetary range');
    }
    outputSum += output.sats;
    return { outputScript: output.script.toHex(), sats: output.sats };
  });
  if (outputSum > MAX_ATOMS) throw new PaymentError('invalid_transaction', 'Transaction total exceeds the XEC monetary range');
  const bytes = Buffer.from(hex, 'hex');
  // Compute the ID independently from the transaction library after its exact
  // round trip, so it is explicitly a commitment to the supplied bytes.
  const computedTxid = Buffer.from(sha256(sha256(bytes))).reverse().toString('hex');
  if (decoded.txid() !== computedTxid) throw new PaymentError('invalid_transaction', 'Transaction ID verification failed');
  return {
    hex, txid: computedTxid, inputs, outputs, size: bytes.length,
    version: decoded.version, lockTime: decoded.locktime,
  };
}

/**
 * Dedicated service signer: m/44'/1899'/0'/branch/index. It has no network client,
 * coin selector, mutable address cursor, broadcast method, or automatic retry.
 * Allocation, chain verification, durable reservations and broadcast belong to
 * the payment service and its database transaction boundary.
 */
export class ProgrammaticWallet {
  readonly fingerprint: string;
  readonly network: WalletNetwork;
  #branches: [HdNode, HdNode];

  constructor(seedHex: string, network: WalletNetwork) {
    if (!Object.hasOwn(PREFIXES, network)) throw new PaymentError('configuration', 'Unsupported wallet network');
    if (typeof seedHex !== 'string' || !/^[0-9a-f]{64}$/.test(seedHex)) {
      throw new PaymentError('configuration', 'XEC_WALLET_SEED_HEX must contain exactly 32 random bytes as lowercase hexadecimal');
    }
    const seed = Buffer.from(seedHex, 'hex');
    // Reject obvious placeholders. No string test can prove entropy: setup must
    // generate the dedicated seed with crypto.randomBytes(32).
    if ([1, 2, 4, 8, 16].some(period => seed.every((byte, i) => byte === seed[i % period]))) {
      seed.fill(0);
      throw new PaymentError('configuration', 'XEC_WALLET_SEED_HEX is an obviously repeated, unsafe seed');
    }
    this.network = network;
    try {
      let account = HdNode.fromSeed(seed);
      for (const hardenedIndex of [44, 1899, 0]) {
        const parent = account;
        account = parent.deriveHardened(hardenedIndex);
        parent.seckey()?.fill(0);
        if (account.index() !== hardenedIndex + 0x80000000) throw new Error('derivation index changed');
      }
      this.fingerprint = createHash('sha256')
        .update(`zoko:xec:hd:v1:${network}:m/44'/1899'/0':`)
        .update(account.pubkey()).update(account.chainCode()).digest('hex');
      this.#branches = [account.derive(0), account.derive(1)];
      account.seckey()?.fill(0);
      if (this.#branches[0].index() !== 0 || this.#branches[1].index() !== 1) throw new Error('derivation index changed');
    } catch {
      throw new PaymentError('configuration', 'Unable to derive the dedicated signing wallet');
    } finally {
      seed.fill(0);
    }
  }

  #key(branch: WalletBranch, addressIndex: number): HdNode {
    if (branch !== 0 && branch !== 1) throw new PaymentError('invalid_derivation', 'Wallet branch must be 0 or 1', 400);
    index(addressIndex, 'Wallet address index');
    const key = this.#branches[branch].derive(addressIndex);
    // BIP32 skips an invalid child. Never silently alias two database indices to
    // that same child, even though such a collision is astronomically unlikely.
    if (key.index() !== addressIndex) {
      key.seckey()?.fill(0);
      throw new PaymentError('wallet_derivation', 'The allocated HD index cannot be used');
    }
    return key;
  }

  derive(branch: WalletBranch, addressIndex: number): WalletAddress {
    const key = this.#key(branch, addressIndex);
    try {
      return {
        address: Address.p2pkh(key.pkh(), PREFIXES[this.network]).toString(),
        outputScript: Script.p2pkh(key.pkh()).toHex(), branch, index: addressIndex,
      };
    } finally { key.seckey()?.fill(0); }
  }

  buildWithdrawal(request: WithdrawalBuildRequest): BuiltWithdrawal {
    if (!Array.isArray(request.inputs) || request.inputs.length === 0 || request.inputs.length > MAX_WALLET_INPUTS) {
      throw new PaymentError('invalid_inputs', `A withdrawal needs 1 to ${MAX_WALLET_INPUTS} reserved inputs`, 400);
    }
    atoms(request.recipientSats, 'Recipient amount', DUST_ATOMS);
    atoms(request.feeRateSatsPerKb, 'Fee rate');
    atoms(request.maxFeeRateSatsPerKb, 'Maximum fee rate');
    atoms(request.maxFeeSats, 'Maximum fee');
    if (request.feeRateSatsPerKb > request.maxFeeRateSatsPerKb) {
      throw new PaymentError('invalid_fee', 'The funding fee rate exceeds the configured maximum', 400);
    }
    let recipientScript: Script;
    try {
      if (typeof request.recipientAddress !== 'string' ||
          !request.recipientAddress.startsWith(`${PREFIXES[this.network]}:`)) throw new Error('network');
      const address = Address.fromCashAddress(request.recipientAddress);
      if (address.prefix !== PREFIXES[this.network] || !['p2pkh', 'p2sh'].includes(address.type) || address.hash.length !== 40) {
        throw new Error('unsupported');
      }
      recipientScript = address.toScript();
    } catch {
      throw new PaymentError('invalid_address', 'Recipient must be a supported explicit eCash address on the configured network', 400);
    }
    const change = this.derive(1, request.changeIndex);
    const changeScript = Script.fromAddress(change.address);
    const seen = new Set<string>();
    let inputSum = 0n;
    // Copy caller-owned input records before building. Never sort or substitute
    // them: database reservations and signed input order remain identical.
    const inputs = request.inputs.map(input => {
      txid(input.txid);
      if (!Number.isInteger(input.vout) || input.vout < 0 || input.vout > 0xffffffff) {
        throw new PaymentError('invalid_inputs', 'Reserved input output index is invalid', 400);
      }
      atoms(input.sats, 'Reserved input amount');
      index(input.index, 'Reserved input derivation index');
      if (input.branch !== 0 && input.branch !== 1) throw new PaymentError('invalid_derivation', 'Reserved input branch must be 0 or 1', 400);
      const outpoint = `${input.txid}:${input.vout}`;
      if (seen.has(outpoint)) throw new PaymentError('invalid_inputs', 'A withdrawal cannot spend an outpoint twice', 400);
      seen.add(outpoint);
      inputSum += input.sats;
      return { txid: input.txid, vout: input.vout, sats: input.sats, branch: input.branch, index: input.index };
    });
    if (inputSum > MAX_ATOMS) throw new PaymentError('invalid_inputs', 'Reserved input total exceeds the XEC monetary range', 400);
    if (inputSum <= request.recipientSats) throw new PaymentError('insufficient_liquidity', 'Reserved inputs cannot fund the recipient and network fee');

    const keys: HdNode[] = [];
    try {
      const builder = new TxBuilder({
        version: 2, locktime: 0,
        inputs: inputs.map(input => {
          const key = this.#key(input.branch, input.index);
          keys.push(key);
          const secret = key.seckey();
          if (!secret) throw new Error('missing signing key');
          return {
            input: {
              prevOut: { txid: input.txid, outIdx: input.vout }, sequence: 0xffffffff,
              signData: { sats: input.sats, outputScript: Script.p2pkh(key.pkh()) },
            },
            signatory: P2PKHSignatory(secret, key.pubkey(), ALL_BIP143),
          };
        }),
        outputs: [{ sats: request.recipientSats, script: recipientScript }, changeScript],
      });
      const signed = builder.sign({ feePerKb: request.feeRateSatsPerKb, dustSats: DUST_ATOMS });
      const decoded = decodeTransaction(signed.toHex());
      const feeSats = inputSum - decoded.outputs.reduce((sum, output) => sum + output.sats, 0n);
      const requiredFee = (BigInt(decoded.size) * request.feeRateSatsPerKb + 999n) / 1000n;
      const maximumRateFee = (BigInt(decoded.size) * request.maxFeeRateSatsPerKb + 999n) / 1000n;
      if (feeSats < requiredFee || feeSats > request.maxFeeSats ||
          feeSats > maximumRateFee) {
        throw new PaymentError('fee_limit', 'The signed transaction fee is outside the authorized fee limits');
      }
      if (decoded.version !== 2 || decoded.lockTime !== 0 || decoded.inputs.length !== inputs.length ||
          decoded.inputs.some((input, i) => input.txid !== inputs[i]!.txid || input.vout !== inputs[i]!.vout) ||
          decoded.outputs.length < 1 || decoded.outputs.length > 2 ||
          decoded.outputs[0]!.sats !== request.recipientSats || decoded.outputs[0]!.outputScript !== recipientScript.toHex() ||
          (decoded.outputs[1] !== undefined &&
            (decoded.outputs[1].outputScript !== change.outputScript || decoded.outputs[1].sats < DUST_ATOMS))) {
        throw new PaymentError('wallet_signing', 'Signed transaction differs from the authorized withdrawal');
      }
      // Parse the persisted form and verify each signature against its exact
      // input amount/script and all outputs, before returning anything to store.
      const parsed = EcashTx.fromHex(decoded.hex);
      for (let i = 0; i < parsed.inputs.length; i++) {
        parsed.inputs[i]!.signData = { sats: inputs[i]!.sats, outputScript: Script.p2pkh(keys[i]!.pkh()) };
      }
      const unsigned = UnsignedTx.fromTx(parsed);
      const ecc = new Ecc();
      for (let i = 0; i < parsed.inputs.length; i++) {
        const script = parsed.inputs[i]!.script!.bytecode;
        const publicKey = keys[i]!.pubkey();
        // Minimal pushes: 65-byte Schnorr+ALL|FORKID, then compressed public key.
        if (script.length !== 100 || script[0] !== 65 || script[65] !== 0x41 || script[66] !== 33 ||
            toHex(script.subarray(67)) !== toHex(publicKey)) throw new Error('noncanonical signature');
        const preimage = unsigned.inputAt(i).sigHashPreimage(ALL_BIP143);
        ecc.schnorrVerify(script.subarray(1, 65), sha256d(preimage.bytes), publicKey);
      }
      return {
        hex: decoded.hex, txid: decoded.txid, feeSats, inputs,
        outputs: decoded.outputs, changeAddress: change.address,
      };
    } catch (error) {
      if (error instanceof PaymentError) throw error;
      if (error instanceof Error && error.message.startsWith('Insufficient input sats')) {
        throw new PaymentError('insufficient_liquidity', 'Reserved inputs cannot cover the transaction network fee');
      }
      throw new PaymentError('wallet_signing', 'Unable to build and verify the reserved withdrawal');
    } finally {
      for (const key of keys) key.seckey()?.fill(0);
    }
  }
}
