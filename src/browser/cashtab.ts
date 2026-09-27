import { CashtabConnect } from 'cashtab-connect';
import { decodeCashAddress, encodeCashAddress } from 'ecashaddrjs';

const NANOS_PER_ATOM = 10_000_000n;
const MINIMUM_PAYMENT_ATOMS = 546n;
const MAXIMUM_PAYMENT_ATOMS = 2_100_000_000_000_000n;
const TXID = /^[a-f0-9]{64}$/;
// This exact reason is emitted by the disabled-while-sending Reject button in
// cashtab/src/components/Send/SendXec.tsx. Other false responses may be errors.
const EXPLICIT_USER_REJECTION = 'User rejected the transaction';

export interface FundingRequest {
  address: string;
  amountXec: string;
  amountNanos: string;
  bip21: string;
  payUrl: string;
}

/** Cashtab accepts a string amount. Never round an on-chain amount through Number. */
export function parseFundingAmount(value: string): { amountXec: string; amountNanos: string } {
  const match = /^(0|[1-9]\d{0,13})(?:\.(\d{1,2}))?$/.exec(value.trim());
  if (!match) throw new Error('Enter XEC with at most two decimal places, without separators or scientific notation.');
  const atoms = BigInt(match[1]!) * 100n + BigInt((match[2] ?? '').padEnd(2, '0'));
  if (atoms < MINIMUM_PAYMENT_ATOMS) throw new Error('A top-up must be at least 5.46 XEC to meet the standard payment minimum.');
  if (atoms > MAXIMUM_PAYMENT_ATOMS) throw new Error('The top-up exceeds the maximum native XEC amount.');
  const fraction = (atoms % 100n).toString().padStart(2, '0').replace(/0+$/, '');
  return { amountXec: `${atoms / 100n}${fraction ? `.${fraction}` : ''}`, amountNanos: (atoms * NANOS_PER_ATOM).toString() };
}

/** Only a checksum-validated mainnet address may enter the official wallet link. */
export function createFundingRequest(address: string, amount: string): FundingRequest {
  if (!address.startsWith('ecash:') || address.length > 200) throw new Error('Cashtab payment links require a mainnet ecash: address. Use the manual address flow for another network.');
  let decoded;
  try { decoded = decodeCashAddress(address); } catch { throw new Error('The receiving address failed its eCash checksum.'); }
  if (decoded.prefix !== 'ecash' || !['p2pkh', 'p2sh'].includes(decoded.type) || decoded.hash.length !== 40) throw new Error('This eCash address type is not supported for a top-up.');
  const canonicalAddress = encodeCashAddress('ecash', decoded.type, decoded.hash);
  const parsed = parseFundingAmount(amount);
  const bip21 = `${canonicalAddress}?amount=${parsed.amountXec}`;
  const parameters = new URLSearchParams({ bip21, b: '1' });
  return { address: canonicalAddress, ...parsed, bip21, payUrl: `https://pay.e.cash/?${parameters.toString()}` };
}

export interface CashtabWalletPort {
  isExtensionAvailable(): Promise<boolean>;
  sendXec(address: string, amount: string): Promise<unknown>;
}
export type WalletFundingOutcome =
  | { kind: 'submitted'; txid: string }
  | { kind: 'declined'; reason: string }
  | { kind: 'unknown'; reason: string }
  | { kind: 'unavailable' }
  | { kind: 'busy' };

/**
 * One SDK instance and one send at a time: cashtab-connect has one transaction
 * listener slot. A callback is only a hint for server-side transaction checks.
 */
export class CashtabFundingClient {
  private active = false;
  private walletInstance?: CashtabWalletPort;
  constructor(wallet?: CashtabWalletPort) { this.walletInstance = wallet; }
  private wallet(): CashtabWalletPort { return this.walletInstance ??= new CashtabConnect(120_000); }
  async available(): Promise<boolean> {
    try { return await this.wallet().isExtensionAvailable() === true; } catch { return false; }
  }
  async send(request: FundingRequest): Promise<WalletFundingOutcome> {
    if (this.active) return { kind: 'busy' };
    // Reconstruct from the validated destination and exact amount. Never trust
    // a caller-supplied URL or BIP21 payload, even on an existing request object.
    const validated = createFundingRequest(request.address, request.amountXec);
    this.active = true;
    try {
      if (!await this.available()) return { kind: 'unavailable' };
      const response = await this.wallet().sendXec(validated.address, validated.amountXec);
      if (!response || typeof response !== 'object') return { kind: 'unknown', reason: 'The wallet did not return a transaction receipt. Check deposits before paying again.' };
      const result = response as Record<string, unknown>;
      if (result.success === false && result.reason === EXPLICIT_USER_REJECTION) return { kind: 'declined', reason: EXPLICIT_USER_REJECTION };
      if (result.success === true && typeof result.txid === 'string' && TXID.test(result.txid.toLowerCase())) return { kind: 'submitted', txid: result.txid.toLowerCase() };
      return { kind: 'unknown', reason: 'The wallet did not provide a valid transaction ID. Check deposits before paying again.' };
    } catch (error) {
      if (error instanceof Error && error.name === 'CashtabTransactionDeniedError' && error.message === EXPLICIT_USER_REJECTION) return { kind: 'declined', reason: EXPLICIT_USER_REJECTION };
      return { kind: 'unknown', reason: 'The wallet response was interrupted or timed out. The payment may have been sent. Check deposits before paying again.' };
    } finally { this.active = false; }
  }
}

export interface DepositRecord {
  txid: string;
  vout: number;
  amountNanos: string;
  status: string;
  confirmations?: number;
  avalancheFinalized?: boolean;
  creditedAt?: string | null;
  createdAt?: string;
}
export interface FundingObservation {
  status: 'waiting' | 'pending' | 'credited' | 'review';
  creditedNanos: string;
  observedNanos: string;
  deposits: DepositRecord[];
  timedOut: boolean;
}
export const depositKey = (deposit: Pick<DepositRecord, 'txid' | 'vout'>): string => `${deposit.txid}:${deposit.vout}`;

/** Inputs come from authenticated Zoko deposit history, never wallet callbacks. */
export function observeDeposits(records: unknown, options: { txid?: string; baseline?: ReadonlySet<string> } = {}): FundingObservation {
  if (!Array.isArray(records)) throw new Error('The server returned an invalid deposit history.');
  if (options.txid !== undefined && !TXID.test(options.txid)) throw new Error('Invalid transaction ID for deposit verification.');
  const seen = new Set<string>();
  const candidates: DepositRecord[] = [];
  for (const value of records) {
    if (!value || typeof value !== 'object') throw new Error('The server returned an invalid deposit record.');
    const record = value as DepositRecord;
    if (!TXID.test(record.txid) || !Number.isInteger(record.vout) || record.vout < 0 || typeof record.amountNanos !== 'string' || !/^[1-9]\d{0,29}$/.test(record.amountNanos) || typeof record.status !== 'string') throw new Error('The server returned an invalid deposit record.');
    const key = depositKey(record);
    if (seen.has(key)) throw new Error('The server returned duplicate deposit outpoints.');
    seen.add(key);
    if (options.txid ? record.txid !== options.txid : options.baseline?.has(key)) continue;
    candidates.push(record);
  }
  const credited = candidates.filter((record) => record.status === 'credited' && typeof record.creditedAt === 'string' && Number.isFinite(Date.parse(record.creditedAt)));
  const sum = (rows: DepositRecord[]) => rows.reduce((total, record) => total + BigInt(record.amountNanos), 0n).toString();
  const review = candidates.some((record) => !['credited', 'pending'].includes(record.status) || (record.status === 'credited' && !credited.includes(record)));
  return {
    status: review ? 'review' : candidates.length === 0 ? 'waiting' : candidates.every((record) => record.status === 'credited') ? 'credited' : 'pending',
    creditedNanos: sum(credited), observedNanos: sum(candidates), deposits: candidates, timedOut: false,
  };
}

function pause(milliseconds: number, signal: AbortSignal): Promise<void> {
  signal.throwIfAborted();
  return new Promise((resolve, reject) => {
    const abort = () => { clearTimeout(timer); reject(signal.reason); };
    const timer = setTimeout(() => { signal.removeEventListener('abort', abort); resolve(); }, milliseconds);
    signal.addEventListener('abort', abort, { once: true });
  });
}

/** Bounded read-only reconciliation; this function never sends or credits funds. */
export async function pollFunding(options: {
  readDeposits: (signal: AbortSignal) => Promise<unknown>;
  onUpdate?: (observation: FundingObservation) => void;
  txid?: string;
  baseline?: ReadonlySet<string>;
  signal?: AbortSignal;
  maxWaitMs?: number;
  intervalMs?: number;
}): Promise<FundingObservation> {
  const maxWaitMs = options.maxWaitMs ?? 120_000;
  const intervalMs = options.intervalMs ?? 5_000;
  if (!Number.isSafeInteger(maxWaitMs) || maxWaitMs < 1 || maxWaitMs > 120_000 || !Number.isSafeInteger(intervalMs) || intervalMs < 1 || intervalMs > 30_000) throw new Error('Invalid funding polling duration.');
  const deadline = AbortSignal.timeout(maxWaitMs);
  const signal = options.signal ? AbortSignal.any([deadline, options.signal]) : deadline;
  let last = observeDeposits([], { txid: options.txid, baseline: options.baseline });
  let consecutiveFailures = 0;
  try {
    for (let attempt = 0; attempt < 25; attempt++) {
      signal.throwIfAborted();
      try {
        last = observeDeposits(await options.readDeposits(signal), { txid: options.txid, baseline: options.baseline });
        consecutiveFailures = 0;
        options.onUpdate?.(last);
        if (last.status === 'credited' || last.status === 'review') return last;
      } catch (error) {
        if (signal.aborted || ++consecutiveFailures >= 3) throw error;
      }
      await pause(intervalMs, signal);
    }
  } catch (error) {
    if (!deadline.aborted || options.signal?.aborted) throw error;
  }
  return { ...last, timedOut: true };
}

export const cashtabFunding = new CashtabFundingClient();
