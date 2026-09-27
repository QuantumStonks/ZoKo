import { randomUUID } from 'node:crypto';
import type { Tx as IndexedTx } from 'chronik-client';
import { type Db, type Tx, lockWallets, transaction, transfer } from '../db.js';
import { ChronikGateway, ChronikHttpError, assertPlainXec } from './chronik.js';
import { type PaymentsConfig, networkCheckpoints } from './config.js';
import { DUST_ATOMS, NANOS_PER_ATOM, PaymentError, parseNanos, requireAtoms, txid, xecToNanos } from './money.js';
import { addressScript, canonicalAddress, decodeRawTransaction, scriptAddress, verifyChronikTransaction, verifyFee, verifyInputsUnchanged, verifyWithdrawalOutputs, type InputOutpoint, type DecodedTransaction } from './verification.js';
import { MAX_WALLET_INPUTS, ProgrammaticWallet, type WalletBranch, type WalletInput } from './wallet.js';

export { type PaymentsConfig, readPaymentsConfig } from './config.js';
export { paymentsMigration, paymentsUpgradeMigration } from './migration.js';
export { PaymentError } from './money.js';

const WORKER_LOCK = 701537613;
const OPEN_STATUSES = ['requested', 'preparing', 'signed', 'broadcast'];
const HISTORY_PAGE_SIZE = 100;
const HISTORY_PAGES_PER_SCAN = 5;
interface StoredInput extends InputOutpoint { sats: string; branch: WalletBranch; index: number }
interface AddressRow { address: string; branch: WalletBranch; derivation_index: number; account_id: string | null }
interface ChainTip { height: number; hash: string }
interface WalletIdentity { backend: 'programmatic'; version: 1; network: string; fingerprint: string; genesis: string }
interface WithdrawalRow {
  id: string; account_id: string; network: string; idempotency_key: string; address: string;
  amount_nanos: string; max_fee_nanos: string; fee_nanos: string | null; status: string;
  input_outpoints: StoredInput[]; change_address: string | null; funded_hex: string | null;
  signed_hex: string | null; txid: string | null; last_error: string | null; broadcast_attempts: number;
  created_at: Date; updated_at: Date; settled_at: Date | null;
}
export interface PaymentStatus {
  enabled: boolean; ready: boolean; network: string; backend: 'programmatic'; verification: 'hosted_chronik';
  confirmations: number; requireFinalized: boolean; lastCheckedAt: string | null;
  lastSyncedAt: string | null; lastError: string | null; chronikHeight?: number;
  depositsEnabled: boolean; withdrawalsEnabled: boolean; minWithdrawalNanos: string; maximumWithdrawalFeeNanos: string;
}
function publicWithdrawal(row: WithdrawalRow) {
  return {
    id: row.id, address: row.address, network: row.network, amountNanos: row.amount_nanos,
    maxFeeNanos: row.max_fee_nanos, feeNanos: row.fee_nanos,
    reservedNanos: ['settled', 'failed'].includes(row.status) ? '0' : (BigInt(row.amount_nanos) + BigInt(row.max_fee_nanos)).toString(),
    maximumDebitNanos: (BigInt(row.amount_nanos) + BigInt(row.max_fee_nanos)).toString(),
    status: row.status, txid: row.txid, lastError: row.last_error,
    createdAt: row.created_at, updatedAt: row.updated_at, settledAt: row.settled_at,
  };
}
async function inTransaction<T>(client: Tx, fn: (client: Tx) => Promise<T>): Promise<T> {
  await client.query('BEGIN');
  try { const result = await fn(client); await client.query('COMMIT'); return result; }
  catch (error) { try { await client.query('ROLLBACK'); } catch { /* Preserve original failure. */ } throw error; }
}
function errorCode(error: unknown): string { return error instanceof PaymentError ? error.code : 'payment_processing_error'; }
function contradictsCreditedEvidence(error: unknown): boolean {
  return error instanceof PaymentError && ['payment_source_mismatch', 'deposit_identity_conflict'].includes(error.code);
}
function natural(value: unknown, name: string): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) throw new PaymentError('invalid_chronik_response', `Chronik returned an invalid ${name}`);
  return value;
}
function isMissing(error: unknown): boolean { return error instanceof ChronikHttpError && error.httpStatus === 404; }

export class Payments {
  private readonly wallet: ProgrammaticWallet | undefined;
  private readonly gateways: ChronikGateway[];
  private gateway: ChronikGateway | undefined;
  private state: PaymentStatus;
  private checking: Promise<PaymentStatus> | undefined;

  constructor(private readonly db: Db, readonly config: PaymentsConfig) {
    this.wallet = config.walletSeedHex ? new ProgrammaticWallet(config.walletSeedHex, config.network) : undefined;
    this.gateways = config.chronikUrls.map(url => new ChronikGateway(url, config.httpTimeoutMs));
    this.state = {
      enabled: config.enabled, ready: !config.enabled, network: config.network,
      backend: 'programmatic', verification: 'hosted_chronik',
      confirmations: config.confirmations, requireFinalized: config.requireFinalized,
      lastCheckedAt: null, lastSyncedAt: null, lastError: null, depositsEnabled: false, withdrawalsEnabled: false,
      minWithdrawalNanos: (DUST_ATOMS * NANOS_PER_ATOM).toString(), maximumWithdrawalFeeNanos: config.maxFeeNanos,
    };
  }
  status(): PaymentStatus {
    return { ...this.state, depositsEnabled: this.config.enabled && this.state.ready, withdrawalsEnabled: this.config.enabled && this.state.ready };
  }
  private assertEnabled(): void {
    if (!this.config.enabled) throw new PaymentError('payments_disabled', 'On-chain payments are disabled by operator configuration', 503);
  }
  private get signer(): ProgrammaticWallet {
    if (!this.wallet) throw new PaymentError('wallet_not_configured', 'Configure the dedicated XEC_WALLET_SEED_HEX generated by npm run init');
    return this.wallet;
  }
  private get chronik(): ChronikGateway {
    if (!this.gateway) throw new PaymentError('payments_not_ready', 'Payment preflight has not selected a healthy Chronik endpoint');
    return this.gateway;
  }
  async preflight(): Promise<PaymentStatus> {
    if (!this.config.enabled) return this.status();
    if (this.checking) return this.checking;
    this.checking = this.check();
    try { return await this.checking; } finally { this.checking = undefined; }
  }
  private identity(): WalletIdentity {
    return { backend: 'programmatic', version: 1, network: this.config.network, fingerprint: this.signer.fingerprint, genesis: this.config.expectedGenesisHash };
  }
  private verifyIdentity(value: unknown): void {
    const existing = value as Partial<WalletIdentity> | null;
    if (!existing || existing.backend !== 'programmatic' || existing.version !== 1) {
      throw new PaymentError('node_wallet_migration_required', 'This ledger belongs to the previous node wallet. Follow the documented manual migration; its payment records cannot be rebound.');
    }
    const expected = this.identity();
    if (existing.network !== expected.network || existing.fingerprint !== expected.fingerprint || existing.genesis !== expected.genesis) {
      throw new PaymentError('wallet_binding_mismatch', 'The configured seed or network does not match this ledger\'s dedicated wallet');
    }
  }
  private async checkBinding(client: Db | Tx): Promise<void> {
    // One SQL snapshot prevents a concurrent first allocation from making a
    // previously absent binding look like an orphaned legacy address.
    const result = await client.query<{ identity: unknown; legacy: boolean }>(`SELECT
      (SELECT value FROM payments_state WHERE key='wallet-identity') AS identity,
      EXISTS(SELECT 1 FROM payments_state WHERE key LIKE 'wallet-cursor:%') OR
      EXISTS(SELECT 1 FROM accounts a WHERE a.deposit_address IS NOT NULL AND NOT EXISTS
        (SELECT 1 FROM payments_addresses p WHERE p.account_id=a.id AND p.address=a.deposit_address AND p.network=$1 AND p.branch=0)) OR
      (NOT EXISTS(SELECT 1 FROM payments_state WHERE key='wallet-identity') AND
        (EXISTS(SELECT 1 FROM payments_deposits) OR EXISTS(SELECT 1 FROM payments_withdrawals) OR
         EXISTS(SELECT 1 FROM payments_deposit_txs) OR EXISTS(SELECT 1 FROM payments_addresses))) AS legacy`, [this.config.network]);
    const row = result.rows[0];
    if (row?.identity) this.verifyIdentity(row.identity);
    if (row?.legacy) throw new PaymentError('node_wallet_migration_required', 'Existing payment records require the documented manual migration; automatic seed replacement is disabled');
  }

  private async checkTokenIndex(gateway = this.chronik): Promise<void> {
    if (!this.config.tokenProbeTxid) throw new PaymentError('token_probe_required', 'Configure a known token genesis in XEC_TOKEN_PROBE_TXID for this network');
    const probeId = txid(this.config.tokenProbeTxid);
    const [metadata, indexed] = await Promise.all([gateway.client.token(probeId), gateway.tx(probeId)]);
    if (metadata.tokenId !== probeId || indexed.txid !== probeId || indexed.tokenStatus !== 'TOKEN_STATUS_NORMAL' ||
        !indexed.outputs.some(output => output.token?.tokenId === probeId) || indexed.tokenEntries.length === 0) {
      throw new PaymentError('token_index_unavailable', 'Chronik must positively identify the configured token genesis and its token-bearing outputs');
    }
  }
  private async tip(gateway = this.chronik): Promise<ChainTip> {
    const info = await gateway.client.blockchainInfo();
    const height = natural(info.tipHeight, 'tip height'), hash = txid(info.tipHash);
    const block = await gateway.client.block(height);
    if (block.blockInfo.height !== height || block.blockInfo.hash !== hash) throw new PaymentError('chronik_chain_mismatch', 'Chronik tip changed or is internally inconsistent');
    if (this.config.network !== 'regtest') {
      const timestamp = natural(block.blockInfo.timestamp, 'tip timestamp');
      const age = Math.floor(Date.now() / 1000) - timestamp;
      const maximumAge = this.config.network === 'mainnet' ? 2 * 60 * 60 : 24 * 60 * 60;
      if (age > maximumAge || age < -2 * 60 * 60) throw new PaymentError('chronik_stale', 'Chronik tip timestamp is stale or implausibly far in the future');
    }
    return { height, hash };
  }
  private async canonical(tip: ChainTip, gateway = this.chronik): Promise<boolean> {
    const block = await gateway.client.block(tip.height);
    if (block.blockInfo.height !== tip.height) throw new PaymentError('invalid_chronik_response', 'Chronik returned the wrong block height');
    return txid(block.blockInfo.hash) === tip.hash;
  }
  private async check(): Promise<PaymentStatus> {
    try {
      this.signer;
      if (!this.config.expectedGenesisHash) throw new PaymentError('genesis_required', 'Configure XEC_GENESIS_HASH for this network');
      await this.checkBinding(this.db);
      let selected: { gateway: ChronikGateway; tip: ChainTip } | undefined, selectionError: unknown;
      for (const gateway of this.gateways) {
        try {
          const genesis = await gateway.client.block(0);
          if (genesis.blockInfo.height !== 0 || genesis.blockInfo.hash !== this.config.expectedGenesisHash) throw new PaymentError('chronik_chain_mismatch', 'Chronik genesis does not match the configured network');
          if (this.config.network !== 'regtest') {
            const checkpoint = networkCheckpoints[this.config.network];
            const block = await gateway.client.block(checkpoint.height);
            if (block.blockInfo.height !== checkpoint.height || block.blockInfo.hash !== checkpoint.hash) throw new PaymentError('chronik_chain_mismatch', 'Chronik does not match the pinned eCash post-fork checkpoint');
          }
          const tip = await this.tip(gateway);
          if (this.config.network !== 'regtest' && tip.height < networkCheckpoints[this.config.network].height) throw new PaymentError('chronik_chain_mismatch', 'Chronik has not reached the eCash checkpoint');
          await this.checkTokenIndex(gateway);
          selected = { gateway, tip }; break;
        } catch (error) { selectionError = error; }
      }
      if (!selected) throw selectionError ?? new PaymentError('chronik_not_configured', 'No healthy Chronik endpoint is configured');
      this.gateway = selected.gateway;
      this.state = { ...this.state, ready: true, lastError: null, lastCheckedAt: new Date().toISOString(), chronikHeight: selected.tip.height };
      return this.status();
    } catch (error) {
      this.state = { ...this.state, ready: false, lastError: errorCode(error), lastCheckedAt: new Date().toISOString() };
      throw error;
    }
  }
  private async bindWallet(tx: Tx): Promise<void> {
    await this.checkBinding(tx);
    // All HD allocations use this same row lock, including the initial binding.
    await tx.query("INSERT INTO payments_state(key,value) VALUES ('wallet-identity',$1) ON CONFLICT(key) DO NOTHING", [JSON.stringify(this.identity())]);
    const bound = await tx.query<{ value: unknown }>("SELECT value FROM payments_state WHERE key='wallet-identity' FOR UPDATE");
    this.verifyIdentity(bound.rows[0]?.value);
  }
  private async allocateAddress(tx: Tx, branch: WalletBranch, accountId: string | null): Promise<AddressRow> {
    const key = `hd-next:${branch}`;
    const counter = await tx.query<{ value: { index: number } }>('SELECT value FROM payments_state WHERE key=$1', [key]);
    const index = counter.rows[0]?.value.index ?? 0;
    if (!Number.isSafeInteger(index) || index < 0 || index >= 0x7fffffff) throw new PaymentError('wallet_derivation_exhausted', 'Dedicated wallet address index is unavailable');
    const derived = this.signer.derive(branch, index);
    await tx.query('INSERT INTO payments_addresses(network,address,account_id,branch,derivation_index) VALUES($1,$2,$3,$4,$5)', [this.config.network, derived.address, accountId, branch, index]);
    await tx.query('INSERT INTO payments_address_scans(network,address) VALUES($1,$2)', [this.config.network, derived.address]);
    await tx.query('INSERT INTO payments_state(key,value) VALUES($1,$2) ON CONFLICT(key) DO UPDATE SET value=excluded.value,updated_at=now()', [key, JSON.stringify({ index: index + 1 })]);
    return { address: derived.address, branch, derivation_index: index, account_id: accountId };
  }
  private verifyAddress(row: AddressRow): string {
    const derived = this.signer.derive(row.branch, row.derivation_index);
    if (derived.address !== row.address) throw new PaymentError('wallet_address_mismatch', 'Stored address derivation does not match the dedicated wallet');
    return derived.outputScript;
  }
  async provisionAddress(accountId: string): Promise<string> {
    this.assertEnabled(); await this.preflight();
    return transaction(this.db, async tx => {
      await this.bindWallet(tx);
      const result = await tx.query<{ deposit_address: string | null; disabled: boolean }>('SELECT deposit_address,disabled FROM accounts WHERE id=$1 FOR UPDATE', [accountId]);
      const account = result.rows[0];
      if (!account) throw new PaymentError('account_not_found', 'Account does not exist', 404);
      if (account.disabled) throw new PaymentError('account_disabled', 'Account is disabled', 403);
      if (account.deposit_address) {
        const assigned = await tx.query<AddressRow>('SELECT * FROM payments_addresses WHERE network=$1 AND account_id=$2 AND address=$3 AND branch=0', [this.config.network, accountId, account.deposit_address]);
        if (!assigned.rows[0]) throw new PaymentError('wallet_address_mismatch', 'Assigned deposit address is not registered to this wallet');
        this.verifyAddress(assigned.rows[0]);
        return account.deposit_address;
      }
      const assigned = await this.allocateAddress(tx, 0, accountId);
      await tx.query('UPDATE accounts SET deposit_address=$2 WHERE id=$1', [accountId, assigned.address]);
      return assigned.address;
    });
  }

  async claimDeposit(accountId: string, id: string): Promise<unknown> {
    this.assertEnabled();
    txid(id);
    await this.preflight();
    const account = await this.db.query<{ deposit_address: string | null }>('SELECT deposit_address FROM accounts WHERE id=$1', [accountId]);
    if (!account.rows[0]?.deposit_address) throw new PaymentError('deposit_address_required', 'Create your assigned deposit address before making or claiming a deposit', 409);
    // A public txid is not authorization to operate on another customer's
    // deposit. Establish the claimant's matching output before queuing changes.
    const owned = await this.db.query('SELECT 1 FROM payments_deposits WHERE network=$1 AND txid=$2 AND account_id=$3 LIMIT 1', [this.config.network, id, accountId]);
    if (!owned.rowCount) {
      const indexed = await this.chronik.tx(id);
      const expectedScript = addressScript(account.rows[0].deposit_address, this.config.network);
      if (!indexed.outputs.some(output => output.outputScript === expectedScript)) throw new PaymentError('deposit_not_owned', 'This transaction has no output to your assigned deposit address', 404);
    }
    // Queue before fetching. A timeout cannot make this claim disappear permanently.
    const queued = await this.db.query<{ revision: string }>(`INSERT INTO payments_deposit_txs(network,txid) VALUES ($1,$2)
      ON CONFLICT(network,txid) DO UPDATE SET pending=true,next_check_at=now(),updated_at=GREATEST(clock_timestamp(),payments_deposit_txs.updated_at+interval '1 microsecond')
      RETURNING updated_at::text AS revision`, [this.config.network, id]);
    try {
      const complete = await this.observeDeposit(id);
      await this.db.query("UPDATE payments_deposit_txs SET pending=$3,last_error=NULL,next_check_at=now()+CASE WHEN $3 THEN interval '15 seconds' ELSE interval '10 minutes' END WHERE network=$1 AND txid=$2 AND updated_at=$4::timestamptz", [this.config.network, id, !complete, queued.rows[0]!.revision]);
    } catch (error) {
      if (contradictsCreditedEvidence(error)) await this.quarantineCredited(id);
      this.state = { ...this.state, ready: false, lastError: errorCode(error) };
      throw error;
    }
    const result = await this.db.query('SELECT txid,vout,amount_nanos AS "amountNanos",status,confirmations,avalanche_finalized AS "avalancheFinalized",credited_at AS "creditedAt" FROM payments_deposits WHERE network=$1 AND txid=$2 AND account_id=$3 ORDER BY vout', [this.config.network, id, accountId]);
    if (result.rows.length === 0) throw new PaymentError('deposit_not_owned', 'This transaction has no output to your assigned deposit address', 404);
    return { txid: id, deposits: result.rows };
  }

  private async evidence(id: string, gateway = this.chronik): Promise<{ indexed: IndexedTx; decoded: DecodedTransaction; raw: string; confirmations: number; finalized: boolean }> {
    const [indexed, raw] = await Promise.all([gateway.tx(id), gateway.client.rawTx(id)]);
    const decoded = decodeRawTransaction(raw.rawTx);
    if (decoded.txid !== id) throw new PaymentError('payment_source_mismatch', 'Raw transaction bytes do not match the requested transaction ID');
    verifyChronikTransaction(decoded, indexed);
    let confirmations = 0;
    if (indexed.block) {
      const height = natural(indexed.block.height, 'transaction block height');
      const blockHash = txid(indexed.block.hash);
      const snapshot = await this.tip(gateway);
      const block = await gateway.client.block(height);
      if (height > snapshot.height || block.blockInfo.height !== height || txid(block.blockInfo.hash) !== blockHash) {
        throw new PaymentError('payment_source_mismatch', 'Chronik transaction block does not match its canonical chain');
      }
      if (!await this.canonical(snapshot, gateway)) throw new PaymentError('chain_changed', 'Chain changed during payment verification; verification will retry');
      confirmations = snapshot.height - height + 1;
    }
    return { indexed, decoded, raw: raw.rawTx, confirmations, finalized: indexed.isFinal === true && confirmations > 0 };
  }

  private async observeDeposit(id: string): Promise<boolean> {
    const gateway = this.chronik;
    let evidence: Awaited<ReturnType<Payments['evidence']>>;
    try { evidence = await this.evidence(id, gateway); }
    catch (error) {
      // An indexer outage/404 is not evidence that a deposit was reversed. A
      // changed canonical block at its previously credited height is evidence.
      if (isMissing(error)) {
        const prior = await this.db.query<{ block_height: number; block_hash: string }>('SELECT DISTINCT block_height,block_hash FROM payments_deposits WHERE network=$1 AND txid=$2 AND credited_at IS NOT NULL AND block_height IS NOT NULL', [this.config.network, id]);
        for (const row of prior.rows) {
          if (!await this.canonical({ height: row.block_height, hash: row.block_hash }, gateway)) {
            await this.quarantineCredited(id, 0); return true;
          }
        }
      }
      throw error;
    }
    const { indexed, decoded, confirmations, finalized } = evidence;
    const outputAddresses = decoded.outputs.map(output => scriptAddress(output.script, this.config.network));
    const owners = await this.db.query<{ id: string; deposit_address: string }>(`SELECT a.id,a.deposit_address FROM accounts a
      JOIN payments_addresses p ON p.account_id=a.id AND p.address=a.deposit_address AND p.network=$2 AND p.branch=0
      WHERE a.deposit_address=ANY($1::text[])`, [outputAddresses.filter(address => address !== null), this.config.network]);
    const ownerMap = new Map(owners.rows.map(owner => [owner.deposit_address, owner.id]));
    let plain = true;
    try { assertPlainXec(indexed); } catch (error) {
      if (error instanceof PaymentError && error.code === 'unsupported_token_transaction') plain = false;
      else throw error;
    }
    const blockHash = indexed.block?.hash ?? null, blockHeight = indexed.block?.height ?? null;
    const minimum = Math.max(this.config.confirmations, decoded.coinbase ? 101 : 1);
    const eligible = plain && confirmations >= minimum && !!blockHash && (!this.config.requireFinalized || finalized);
    let pending = false;
    await transaction(this.db, async tx => {
      const accountIds = [...new Set(owners.rows.map(owner => owner.id))].sort();
      if (accountIds.length) {
        await tx.query('SELECT id FROM accounts WHERE id=ANY($1::uuid[]) ORDER BY id FOR UPDATE', [accountIds]);
        await lockWallets(tx, ['external', ...accountIds.map(accountId => `available:${accountId}`)]);
      }
      for (const output of decoded.outputs) {
        const address = outputAddresses[output.vout], accountId = address ? ownerMap.get(address) : undefined;
        if (!accountId || !address || output.nanos <= 0n) continue;
        await tx.query(`INSERT INTO payments_deposits(network,txid,vout,account_id,amount_nanos,address,status,confirmations,avalanche_finalized,block_hash,block_height)
          VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) ON CONFLICT(network,txid,vout) DO NOTHING`,
        [this.config.network, id, output.vout, accountId, output.nanos.toString(), address, plain ? 'pending' : 'unsupported', confirmations, finalized, blockHash, blockHeight]);
        const existing = await tx.query<{ account_id: string; amount_nanos: string; status: string; credited_at: Date | null; block_hash: string | null }>('SELECT account_id,amount_nanos,status,credited_at,block_hash FROM payments_deposits WHERE network=$1 AND txid=$2 AND vout=$3 FOR UPDATE', [this.config.network, id, output.vout]);
        const prior = existing.rows[0]!;
        if (prior.account_id !== accountId || BigInt(prior.amount_nanos) !== output.nanos) throw new PaymentError('deposit_identity_conflict', 'An existing deposit outpoint has inconsistent ownership or amount');
        if (prior.status === 'reorg_review') continue;
        if (prior.credited_at && (!eligible || prior.block_hash !== blockHash)) {
          await tx.query("UPDATE payments_deposits SET status='reorg_review',confirmations=$4,updated_at=now() WHERE network=$1 AND txid=$2 AND vout=$3", [this.config.network, id, output.vout, confirmations]);
          await tx.query('UPDATE accounts SET disabled=true WHERE id=$1', [accountId]);
          continue;
        }
        if (!prior.credited_at && eligible) {
          await transfer(tx, `deposit:${this.config.network}:${id}:${output.vout}`, 'external', `available:${accountId}`, output.nanos,
            { txid: id, vout: output.vout, network: this.config.network, confirmations, avalancheFinalized: finalized });
          await tx.query("UPDATE payments_deposits SET status='credited',credited_at=now(),confirmations=$4,avalanche_finalized=$5,block_hash=$6,block_height=$7,updated_at=now() WHERE network=$1 AND txid=$2 AND vout=$3", [this.config.network, id, output.vout, confirmations, finalized, blockHash, blockHeight]);
        } else {
          const status = prior.credited_at ? 'credited' : plain ? 'pending' : 'unsupported';
          await tx.query('UPDATE payments_deposits SET status=$4,confirmations=$5,avalanche_finalized=$6,block_hash=$7,block_height=$8,updated_at=now() WHERE network=$1 AND txid=$2 AND vout=$3', [this.config.network, id, output.vout, status, confirmations, finalized, blockHash, blockHeight]);
          if (status === 'pending') pending = true;
        }
      }
    });
    return !pending;
  }

  private async quarantineCredited(id: string, confirmations?: number): Promise<void> {
    await transaction(this.db, async tx => {
      const credited = await tx.query<{ account_id: string }>('SELECT DISTINCT account_id FROM payments_deposits WHERE network=$1 AND txid=$2 AND credited_at IS NOT NULL ORDER BY account_id', [this.config.network, id]);
      const ids = credited.rows.map(row => row.account_id);
      if (!ids.length) return;
      await tx.query('SELECT id FROM accounts WHERE id=ANY($1::uuid[]) ORDER BY id FOR UPDATE', [ids]);
      await tx.query('UPDATE accounts SET disabled=true WHERE id=ANY($1::uuid[])', [ids]);
      await tx.query("UPDATE payments_deposits SET status='reorg_review',confirmations=COALESCE($3,confirmations),updated_at=now() WHERE network=$1 AND txid=$2 AND credited_at IS NOT NULL", [this.config.network, id, confirmations ?? null]);
    });
  }

  async requestWithdrawal(accountId: string, address: string, amountNanos: string, idempotencyKey: string): Promise<unknown> {
    this.assertEnabled();
    const destination = canonicalAddress(address, this.config.network);
    const amount = parseNanos(amountNanos);
    if (requireAtoms(amount) < DUST_ATOMS) throw new PaymentError('dust_withdrawal', 'The minimum standard withdrawal is 5.46 XEC', 400);
    if (typeof idempotencyKey !== 'string' || !/^[\x21-\x7e]{1,128}$/.test(idempotencyKey)) throw new PaymentError('idempotency_key_required', 'Use a nonempty Idempotency-Key of at most 128 ASCII characters', 400);
    const maxFee = parseNanos(this.config.maxFeeNanos, 'maxFeeNanos');
    requireAtoms(maxFee);
    const replay = await this.db.query<WithdrawalRow>('SELECT * FROM payments_withdrawals WHERE account_id=$1 AND idempotency_key=$2', [accountId, idempotencyKey]);
    if (replay.rows[0]) {
      if (replay.rows[0].address !== destination || BigInt(replay.rows[0].amount_nanos) !== amount) throw new PaymentError('idempotency_conflict', 'Idempotency-Key was already used for a different withdrawal', 409);
      return publicWithdrawal(replay.rows[0]);
    }
    await this.preflight();
    return transaction(this.db, async tx => {
      await this.bindWallet(tx);
      const account = await tx.query<{ disabled: boolean }>('SELECT disabled FROM accounts WHERE id=$1 FOR UPDATE', [accountId]);
      if (!account.rows[0]) throw new PaymentError('account_not_found', 'Account does not exist', 404);
      const prior = await tx.query<WithdrawalRow>('SELECT * FROM payments_withdrawals WHERE account_id=$1 AND idempotency_key=$2', [accountId, idempotencyKey]);
      if (prior.rows[0]) {
        if (prior.rows[0].address !== destination || BigInt(prior.rows[0].amount_nanos) !== amount) throw new PaymentError('idempotency_conflict', 'Idempotency-Key was already used for a different withdrawal', 409);
        return publicWithdrawal(prior.rows[0]);
      }
      if (account.rows[0].disabled) throw new PaymentError('account_disabled', 'Account is disabled', 403);
      const id = randomUUID();
      await transfer(tx, `withdrawal-reserve:${id}`, `available:${accountId}`, `reserved:${accountId}`, amount + maxFee, { recipientAmountNanos: amount.toString(), maxFeeNanos: maxFee.toString(), address: destination });
      const created = await tx.query<WithdrawalRow>('INSERT INTO payments_withdrawals(id,account_id,network,idempotency_key,address,amount_nanos,max_fee_nanos) VALUES($1,$2,$3,$4,$5,$6,$7) RETURNING *', [id, accountId, this.config.network, idempotencyKey, destination, amount.toString(), maxFee.toString()]);
      return publicWithdrawal(created.rows[0]!);
    });
  }

  async listWithdrawals(accountId: string): Promise<unknown> {
    const result = await this.db.query<WithdrawalRow>('SELECT * FROM payments_withdrawals WHERE account_id=$1 ORDER BY created_at DESC LIMIT 100', [accountId]);
    return result.rows.map(publicWithdrawal);
  }

  async sync(): Promise<void> {
    if (!this.config.enabled) return;
    await this.preflight();
    const client = await this.db.connect();
    let locked = false;
    try {
      const lock = await client.query<{ locked: boolean }>('SELECT pg_try_advisory_lock($1) AS locked', [WORKER_LOCK]);
      locked = lock.rows[0]?.locked === true;
      if (!locked) return;
      await this.syncWalletHistory(client);
      const pending = await client.query<{ txid: string; revision: string }>('SELECT txid,updated_at::text AS revision FROM payments_deposit_txs WHERE network=$1 AND pending AND next_check_at<=now() ORDER BY next_check_at,created_at LIMIT 100', [this.config.network]);
      for (const row of pending.rows) {
        try {
          const complete = await this.observeDeposit(row.txid);
          await client.query("UPDATE payments_deposit_txs SET pending=$3,next_check_at=now()+CASE WHEN $3 THEN interval '15 seconds' ELSE interval '10 minutes' END,last_error=NULL WHERE network=$1 AND txid=$2 AND updated_at=$4::timestamptz", [this.config.network, row.txid, !complete, row.revision]);
        } catch (error) {
          if (contradictsCreditedEvidence(error)) await this.quarantineCredited(row.txid);
          await client.query("UPDATE payments_deposit_txs SET next_check_at=now()+interval '30 seconds',last_error=$3 WHERE network=$1 AND txid=$2 AND updated_at=$4::timestamptz", [this.config.network, row.txid, errorCode(error), row.revision]);
        }
      }
      const unresolvedCredits = await client.query<{ unresolved: boolean }>(`SELECT EXISTS(
        SELECT 1 FROM payments_deposit_txs t JOIN payments_deposits d ON d.network=t.network AND d.txid=t.txid
        WHERE t.network=$1 AND t.pending AND d.status='credited') AS unresolved`, [this.config.network]);
      if (unresolvedCredits.rows[0]?.unresolved) throw new PaymentError('credited_deposit_unverified', 'Outgoing payments wait until previously credited deposits have been reverified');
      await this.assertAcceptedChain(client);
      const withdrawals = await client.query<WithdrawalRow>('SELECT * FROM payments_withdrawals WHERE network=$1 AND status=ANY($2::text[]) ORDER BY created_at LIMIT 10', [this.config.network, OPEN_STATUSES]);
      for (const withdrawal of withdrawals.rows) await this.processWithdrawal(client, withdrawal);
      this.state = { ...this.state, lastSyncedAt: new Date().toISOString() };
    } catch (error) {
      this.state = { ...this.state, ready: false, lastError: errorCode(error) };
      throw error;
    } finally {
      if (locked) {
        try { await client.query('SELECT pg_advisory_unlock($1)', [WORKER_LOCK]); } catch { /* Connection teardown also releases it. */ }
      }
      client.release();
    }
  }

  private async queueTxs(client: Tx, ids: string[]): Promise<void> {
    if (!ids.length) return;
    await client.query(`INSERT INTO payments_deposit_txs(network,txid) SELECT $1,unnest($2::text[])
      ON CONFLICT(network,txid) DO UPDATE SET pending=true,
      next_check_at=CASE WHEN payments_deposit_txs.pending THEN payments_deposit_txs.next_check_at ELSE now() END,
      updated_at=GREATEST(clock_timestamp(),payments_deposit_txs.updated_at+interval '1 microsecond')`, [this.config.network, [...new Set(ids.map(txid))]]);
  }

  private async syncWalletHistory(client: Tx): Promise<void> {
    const gateway = this.chronik, snapshot = await this.tip(gateway);
    const key = `chain-anchor:${this.config.network}`;
    const previous = await client.query<{ value: ChainTip }>('SELECT value FROM payments_state WHERE key=$1', [key]);
    if (previous.rows[0] && previous.rows[0].value.height > snapshot.height) throw new PaymentError('chronik_behind', 'Chronik is behind the last accepted chain tip');
    const reorganized = previous.rows[0] ? !await this.canonical(previous.rows[0].value, gateway) : false;
    await inTransaction(client, async tx => {
      if (reorganized) {
        await tx.query('UPDATE payments_address_scans SET confirmed_offset=0,anchor_height=NULL,anchor_hash=NULL,next_scan_at=now() WHERE network=$1', [this.config.network]);
        const known = await tx.query<{ txid: string }>('SELECT DISTINCT txid FROM payments_deposits WHERE network=$1', [this.config.network]);
        await this.queueTxs(tx, known.rows.map(row => row.txid));
      }
      await tx.query('INSERT INTO payments_state(key,value) VALUES($1,$2) ON CONFLICT(key) DO UPDATE SET value=excluded.value,updated_at=now()', [key, JSON.stringify(snapshot)]);
      // Recheck credited transactions even after their outputs have been spent.
      // The durable due time provides a round-robin rather than a tip-only view.
      const recheck = await tx.query<{ txid: string }>(`SELECT t.txid FROM payments_deposit_txs t WHERE t.network=$1 AND NOT t.pending AND t.next_check_at<=now()
        AND EXISTS(SELECT 1 FROM payments_deposits d WHERE d.network=t.network AND d.txid=t.txid AND d.status='credited')
        ORDER BY t.next_check_at,t.txid LIMIT 100 FOR UPDATE`, [this.config.network]);
      await this.queueTxs(tx, recheck.rows.map(row => row.txid));
    });
    const addresses = await client.query<AddressRow & { confirmed_offset: string; anchor_height: number | null; anchor_hash: string | null }>(`SELECT p.*,s.confirmed_offset,s.anchor_height,s.anchor_hash
      FROM payments_addresses p JOIN payments_address_scans s USING(network,address)
      WHERE p.network=$1 AND s.next_scan_at<=now() ORDER BY s.next_scan_at,s.last_scanned_at NULLS FIRST,p.address LIMIT 50`, [this.config.network]);
    let scanError: unknown;
    const deadline = Date.now() + 30_000;
    for (const row of addresses.rows) {
      if (Date.now() > deadline) break;
      try { await this.scanAddress(client, row, snapshot, gateway, deadline); }
      catch (error) {
        scanError = error;
        await client.query("UPDATE payments_address_scans SET last_error=$3,next_scan_at=now()+interval '15 seconds' WHERE network=$1 AND address=$2", [this.config.network, row.address, errorCode(error)]);
      }
    }
    if (scanError) throw scanError;
  }

  private async scanAddress(client: Tx, row: AddressRow & { confirmed_offset: string; anchor_height: number | null; anchor_hash: string | null }, snapshot: ChainTip, gateway: ChronikGateway, deadline: number): Promise<void> {
    this.verifyAddress(row);
    let offset = Number(row.confirmed_offset);
    if (!Number.isSafeInteger(offset) || offset < 0) throw new PaymentError('invalid_history_cursor', 'Stored address scan offset is invalid');
    if (row.anchor_height !== null && row.anchor_hash !== null) {
      if (row.anchor_height > snapshot.height) throw new PaymentError('chronik_behind', 'Chronik is behind the address scan checkpoint');
      if (!await this.canonical({ height: row.anchor_height, hash: row.anchor_hash }, gateway)) {
        offset = 0;
        await inTransaction(client, async tx => {
          const known = await tx.query<{ txid: string }>('SELECT DISTINCT txid FROM payments_deposits WHERE network=$1 AND address=$2', [this.config.network, row.address]);
          await this.queueTxs(tx, known.rows.map(item => item.txid));
          await tx.query('UPDATE payments_address_scans SET confirmed_offset=0,anchor_height=NULL,anchor_hash=NULL WHERE network=$1 AND address=$2', [this.config.network, row.address]);
        });
      }
    }
    const script = gateway.client.address(row.address);
    const unconfirmed = await script.unconfirmedTxs();
    if (natural(unconfirmed.numTxs, 'unconfirmed transaction count') !== unconfirmed.txs.length ||
        unconfirmed.txs.some(item => item.block !== undefined) || new Set(unconfirmed.txs.map(item => item.txid)).size !== unconfirmed.txs.length) {
      throw new PaymentError('invalid_wallet_history', 'Chronik returned an incomplete unconfirmed address history');
    }
    await this.queueTxs(client, unconfirmed.txs.map(item => item.txid));
    let lastHeight = -1;
    const seen = new Set<string>();
    for (let scanned = 0; scanned < HISTORY_PAGES_PER_SCAN; scanned++) {
      const page = Math.floor(offset / HISTORY_PAGE_SIZE);
      const history = await script.confirmedTxs(page, HISTORY_PAGE_SIZE);
      const total = natural(history.numTxs, 'confirmed transaction count');
      const pages = natural(history.numPages, 'history page count');
      const start = page * HISTORY_PAGE_SIZE;
      if (total < offset || pages !== Math.ceil(total / HISTORY_PAGE_SIZE) ||
          history.txs.length !== Math.max(0, Math.min(HISTORY_PAGE_SIZE, total - start))) {
        throw new PaymentError('invalid_wallet_history', 'Chronik history pagination shrank or omitted entries; scan checkpoint was preserved');
      }
      let next = offset;
      for (let i = 0; i < history.txs.length; i++) {
        const item = history.txs[i]!;
        const id = txid(item.txid), height = natural(item.block?.height, 'confirmed history height');
        if (height < lastHeight || seen.has(id)) throw new PaymentError('invalid_wallet_history', 'Confirmed history is not in chronological blockchain order');
        seen.add(id); lastHeight = height;
        if (start + i >= offset && height <= snapshot.height) next = start + i + 1;
      }
      if (!await this.canonical(snapshot, gateway)) throw new PaymentError('chain_changed', 'Chain changed during address history scanning');
      const complete = next >= total;
      // Commit only a complete response page and its queued IDs together. A
      // failure fetching the next page cannot skip any unobserved transaction.
      await inTransaction(client, async tx => {
        await this.queueTxs(tx, history.txs.filter((_item, i) => start + i >= offset).map(item => item.txid));
        await tx.query(`UPDATE payments_address_scans SET confirmed_offset=$3,anchor_height=$4,anchor_hash=$5,last_scanned_at=now(),last_error=NULL,
          next_scan_at=now()+CASE WHEN $6 THEN interval '15 seconds' ELSE interval '0 seconds' END WHERE network=$1 AND address=$2`, [this.config.network, row.address, next, snapshot.height, snapshot.hash, complete]);
      });
      if (complete || next === offset || next < start + history.txs.length || Date.now() > deadline) break;
      offset = next;
    }
  }

  private async assertAcceptedChain(client: Tx, gateway = this.chronik): Promise<void> {
    const prior = await client.query<{ value: ChainTip }>('SELECT value FROM payments_state WHERE key=$1', [`chain-anchor:${this.config.network}`]);
    if (!prior.rows[0]) return;
    const snapshot = await this.tip(gateway);
    if (prior.rows[0].value.height > snapshot.height) throw new PaymentError('chronik_behind', 'Chronik is behind the previously accepted chain');
    if (!await this.canonical(prior.rows[0].value, gateway)) throw new PaymentError('chain_changed', 'Outgoing payments wait for deposit revalidation after a chain change');
  }

  private async selectInputs(client: Tx, needed: bigint, gateway = this.chronik): Promise<StoredInput[]> {
    const reserved = await client.query<{ input_outpoints: StoredInput[] }>("SELECT input_outpoints FROM payments_withdrawals WHERE status IN ('preparing','signed','broadcast','manual_review')");
    const excluded = new Set(reserved.rows.flatMap(row => row.input_outpoints.map(input => `${input.txid}:${input.vout}`)));
    const addresses = await client.query<AddressRow>('SELECT * FROM payments_addresses WHERE network=$1 ORDER BY branch DESC,derivation_index DESC', [this.config.network]);
    const selected: StoredInput[] = [], seen = new Set<string>();
    let total = 0n;
    for (const address of addresses.rows) {
      const expectedScript = this.verifyAddress(address);
      const result = await gateway.client.address(address.address).utxos();
      if (result.outputScript !== expectedScript) throw new PaymentError('payment_source_mismatch', 'Chronik returned UTXOs for a different wallet script');
      const coins = [...result.utxos].sort((a, b) => a.sats > b.sats ? -1 : a.sats < b.sats ? 1 : a.outpoint.txid.localeCompare(b.outpoint.txid));
      for (const coin of coins) {
        const id = txid(coin.outpoint.txid), vout = natural(coin.outpoint.outIdx, 'UTXO output index'), key = `${id}:${vout}`;
        if (seen.has(key)) throw new PaymentError('payment_source_mismatch', 'Chronik repeated an unspent wallet output');
        seen.add(key);
        if (excluded.has(key) || coin.token !== undefined || coin.blockHeight < 0 || typeof coin.sats !== 'bigint' || coin.sats <= 0n) continue;
        const proof = await this.evidence(id, gateway);
        try { assertPlainXec(proof.indexed); } catch (error) {
          if (error instanceof PaymentError && error.code === 'unsupported_token_transaction') continue;
          throw error;
        }
        const output = proof.indexed.outputs[vout];
        if (!output || output.outputScript !== expectedScript || output.sats !== coin.sats ||
            proof.indexed.block?.height !== coin.blockHeight || proof.decoded.coinbase !== coin.isCoinbase ||
            proof.finalized !== coin.isFinal) throw new PaymentError('payment_source_mismatch', 'Chronik UTXO metadata disagrees with the verified parent transaction');
        if (output.spentBy || proof.confirmations < Math.max(this.config.confirmations, proof.decoded.coinbase ? 101 : 1) ||
            (this.config.requireFinalized && !proof.finalized)) continue;
        selected.push({ txid: id, vout, sats: coin.sats.toString(), branch: address.branch, index: address.derivation_index });
        total += coin.sats * NANOS_PER_ATOM;
        if (total >= needed) return selected;
        if (selected.length >= MAX_WALLET_INPUTS) throw new PaymentError('wallet_fragmented', 'Withdrawal requires too many inputs; the dedicated wallet needs operator consolidation');
      }
    }
    throw new PaymentError('wallet_insufficient_liquidity', 'The dedicated wallet has insufficient mature, verified native XEC for this withdrawal');
  }

  private walletInputs(inputs: StoredInput[]): WalletInput[] {
    if (!Array.isArray(inputs) || inputs.length === 0 || inputs.length > MAX_WALLET_INPUTS) throw new PaymentError('payout_state_conflict', 'Withdrawal input reservation is invalid');
    verifyInputsUnchanged(inputs, inputs);
    return inputs.map(input => {
      if (typeof input.sats !== 'string' || !/^[1-9][0-9]{0,18}$/.test(input.sats) ||
          (input.branch !== 0 && input.branch !== 1) || !Number.isSafeInteger(input.index) || input.index < 0 || input.index >= 0x7fffffff ||
          !Number.isSafeInteger(input.vout) || input.vout < 0 || input.vout > 0xffffffff) throw new PaymentError('payout_state_conflict', 'Withdrawal input reservation is invalid');
      return { ...input, txid: txid(input.txid), sats: BigInt(input.sats) };
    });
  }

  private async verifyPlainInputs(inputs: StoredInput[], ownTxid?: string, gateway = this.chronik): Promise<bigint> {
    const checked = new Map<string, Awaited<ReturnType<Payments['evidence']>>>();
    let total = 0n;
    for (const input of this.walletInputs(inputs)) {
      let proof = checked.get(input.txid);
      if (!proof) { proof = await this.evidence(input.txid, gateway); checked.set(input.txid, proof); }
      assertPlainXec(proof.indexed);
      const output = proof.indexed.outputs[input.vout], derived = this.signer.derive(input.branch, input.index);
      if (!output || output.token !== undefined || output.sats !== input.sats || output.outputScript !== derived.outputScript) {
        throw new PaymentError('payout_input_mismatch', 'Reserved input does not match its locally derived wallet script and exact amount');
      }
      if (output.spentBy && output.spentBy.txid !== ownTxid) throw new PaymentError('onchain_conflict', 'A reserved withdrawal input was spent by another transaction');
      if (proof.confirmations < Math.max(this.config.confirmations, proof.decoded.coinbase ? 101 : 1) || (this.config.requireFinalized && !proof.finalized)) {
        throw new PaymentError('payout_input_unconfirmed', 'Reserved withdrawal input no longer meets the confirmation/finality policy');
      }
      total += input.sats * NANOS_PER_ATOM;
    }
    return total;
  }

  private async buildWithdrawal(client: Tx, row: WithdrawalRow, gateway = this.chronik): Promise<WithdrawalRow> {
    const account = await client.query<{ disabled: boolean }>('SELECT disabled FROM accounts WHERE id=$1', [row.account_id]);
    if (!account.rows[0] || account.rows[0].disabled) throw new PaymentError('account_disabled', 'Account is disabled; no unsigned withdrawal may be broadcast', 403);
    await this.checkTokenIndex(gateway);
    if (row.signed_hex || row.txid) throw new PaymentError('payout_state_conflict', 'A persisted signed payment can never be rebuilt');
    let inputs = row.input_outpoints, changeAddress = row.change_address;
    if (row.status === 'requested') {
      inputs = await this.selectInputs(client, BigInt(row.amount_nanos) + BigInt(row.max_fee_nanos), gateway);
      const prepared = await inTransaction(client, async tx => {
        await this.bindWallet(tx);
        const permission = await tx.query<{ disabled: boolean }>('SELECT disabled FROM accounts WHERE id=$1 FOR UPDATE', [row.account_id]);
        if (!permission.rows[0] || permission.rows[0].disabled) throw new PaymentError('account_disabled', 'Account is disabled', 403);
        const change = await this.allocateAddress(tx, 1, null);
        const saved = await tx.query<WithdrawalRow>("UPDATE payments_withdrawals SET status='preparing',input_outpoints=$2,change_address=$3,updated_at=now() WHERE id=$1 AND status='requested' AND signed_hex IS NULL RETURNING *", [row.id, JSON.stringify(inputs), change.address]);
        if (!saved.rows[0]) throw new PaymentError('payout_state_conflict', 'Withdrawal has already been prepared');
        return saved.rows[0];
      });
      row = prepared; changeAddress = row.change_address;
    }
    if (row.status !== 'preparing' || !changeAddress || inputs.length === 0) throw new PaymentError('payout_state_conflict', 'Preparing withdrawal has no reserved inputs/change');
    const change = await client.query<AddressRow>('SELECT * FROM payments_addresses WHERE network=$1 AND address=$2 AND branch=1 AND account_id IS NULL', [this.config.network, changeAddress]);
    if (!change.rows[0]) throw new PaymentError('invalid_change', 'Withdrawal change has no dedicated derivation reservation');
    const changeScript = this.verifyAddress(change.rows[0]);
    const inputTotal = await this.verifyPlainInputs(inputs, undefined, gateway);
    const built = this.signer.buildWithdrawal({
      inputs: this.walletInputs(inputs), recipientAddress: row.address, recipientSats: requireAtoms(BigInt(row.amount_nanos)),
      changeIndex: change.rows[0].derivation_index, feeRateSatsPerKb: requireAtoms(xecToNanos(this.config.feeRateXecPerKb)),
      maxFeeSats: requireAtoms(BigInt(row.max_fee_nanos)), maxFeeRateSatsPerKb: requireAtoms(xecToNanos(this.config.maxFeeRateXecPerKb)),
    });
    const decoded = decodeRawTransaction(built.hex), fee = built.feeSats * NANOS_PER_ATOM;
    if (decoded.txid !== built.txid || built.changeAddress !== changeAddress) throw new PaymentError('payout_state_conflict', 'Signed withdrawal does not match its durable change reservation');
    verifyInputsUnchanged(decoded.inputs, inputs);
    verifyWithdrawalOutputs(decoded, addressScript(row.address, this.config.network), BigInt(row.amount_nanos), changeScript);
    verifyFee(inputTotal, decoded.outputs.reduce((sum, output) => sum + output.nanos, 0n), fee, BigInt(row.max_fee_nanos), xecToNanos(this.config.maxFeeRateXecPerKb), decoded.size);
    // Critical durability boundary: no signed bytes leave this process before
    // this commit, including remote validation (the recipient could broadcast).
    return inTransaction(client, async tx => {
      const permission = await tx.query<{ disabled: boolean }>('SELECT disabled FROM accounts WHERE id=$1 FOR UPDATE', [row.account_id]);
      if (!permission.rows[0] || permission.rows[0].disabled) throw new PaymentError('account_disabled', 'Account was disabled while the withdrawal was being prepared', 403);
      const saved = await tx.query<WithdrawalRow>("UPDATE payments_withdrawals SET signed_hex=$2,txid=$3,fee_nanos=$4,status='signed',last_error=NULL,updated_at=now() WHERE id=$1 AND signed_hex IS NULL AND status='preparing' RETURNING *", [row.id, built.hex, decoded.txid, fee.toString()]);
      if (!saved.rows[0]) throw new PaymentError('payout_state_conflict', 'Withdrawal already acquired signed transaction bytes');
      return saved.rows[0];
    });
  }

  private async processWithdrawal(client: Tx, initial: WithdrawalRow): Promise<void> {
    let row = initial;
    const gateway = this.chronik;
    try {
      await this.assertAcceptedChain(client, gateway);
      if (!row.signed_hex) row = await this.buildWithdrawal(client, row, gateway);
      if (!row.signed_hex || !row.txid) throw new PaymentError('payout_state_conflict', 'Withdrawal has no persisted signed bytes');
      // Reconcile before any same-byte rebroadcast, including after a restart.
      let known: Awaited<ReturnType<Payments['evidence']>> | undefined;
      try { known = await this.evidence(row.txid, gateway); } catch (error) { if (!isMissing(error)) throw error; }
      if (known) {
        if (known.raw !== row.signed_hex) throw new PaymentError('payout_bytes_mismatch', 'Chronik withdrawal bytes do not match the durably signed payment');
        assertPlainXec(known.indexed);
        if (known.confirmations >= this.config.confirmations && (!this.config.requireFinalized || known.finalized)) {
          await this.settleWithdrawal(client, row); return;
        }
      }
      const permission = await client.query<{ disabled: boolean }>('SELECT disabled FROM accounts WHERE id=$1', [row.account_id]);
      if (!permission.rows[0] || permission.rows[0].disabled) {
        await client.query("UPDATE payments_withdrawals SET status='manual_review',last_error='account_disabled',updated_at=now() WHERE id=$1", [row.id]); return;
      }
      if (known) {
        await client.query("UPDATE payments_withdrawals SET status='broadcast',last_error=NULL,updated_at=now() WHERE id=$1 AND status IN ('signed','broadcast')", [row.id]); return;
      }
      await this.checkTokenIndex(gateway);
      await this.verifyPlainInputs(row.input_outpoints, row.txid, gateway);
      const decoded = decodeRawTransaction(row.signed_hex);
      if (decoded.txid !== row.txid) throw new PaymentError('payout_bytes_mismatch', 'Persisted withdrawal bytes do not match the stored transaction ID');
      await this.assertAcceptedChain(client, gateway);
      await client.query('UPDATE payments_withdrawals SET broadcast_attempts=broadcast_attempts+1,updated_at=now() WHERE id=$1', [row.id]);
      // The signed bytes and attempt count are durable before the external send.
      // Holding the account lock prevents a concurrent disable from authorizing it.
      await inTransaction(client, async tx => {
        const permission = await tx.query<{ disabled: boolean }>('SELECT disabled FROM accounts WHERE id=$1 FOR UPDATE', [row.account_id]);
        if (!permission.rows[0] || permission.rows[0].disabled) {
          await tx.query("UPDATE payments_withdrawals SET status='manual_review',last_error='account_disabled',updated_at=now() WHERE id=$1", [row.id]); return;
        }
        // Validation also exposes spendable bytes. It belongs behind the same
        // durable signing and account-permission boundary as broadcast.
        const validated = await gateway.client.validateRawTx(row.signed_hex!);
        verifyChronikTransaction(decoded, validated); assertPlainXec(validated);
        const sent = await gateway.client.broadcastTx(row.signed_hex!, false);
        if (txid(sent.txid) !== row.txid) throw new PaymentError('payout_txid_mismatch', 'Chronik broadcast returned an unexpected transaction ID');
        await tx.query("UPDATE payments_withdrawals SET status='broadcast',last_error=NULL,updated_at=now() WHERE id=$1 AND status IN ('signed','broadcast')", [row.id]);
      });
    } catch (error) {
      const current = await client.query<WithdrawalRow>('SELECT * FROM payments_withdrawals WHERE id=$1', [row.id]);
      if (!current.rows[0]) throw error;
      if (current.rows[0].signed_hex) {
        const review = error instanceof PaymentError && ['onchain_conflict','payout_bytes_mismatch','payout_input_mismatch','payment_source_mismatch'].includes(error.code);
        await client.query("UPDATE payments_withdrawals SET status=CASE WHEN $3 THEN 'manual_review' ELSE status END,last_error=$2,updated_at=now() WHERE id=$1", [row.id, errorCode(error), review]);
      } else {
        await this.failUnsignedWithdrawal(client, current.rows[0], errorCode(error));
      }
      this.state = { ...this.state, lastError: errorCode(error) };
      if (error instanceof PaymentError && ['chain_changed','chronik_behind','chronik_stale'].includes(error.code)) throw error;
    }
  }

  private async settleWithdrawal(client: Tx, row: WithdrawalRow): Promise<void> {
    await inTransaction(client, async tx => {
      const selected = await tx.query<WithdrawalRow>('SELECT * FROM payments_withdrawals WHERE id=$1 FOR UPDATE', [row.id]);
      const latest = selected.rows[0]!;
      if (latest.status === 'settled') return;
      if (!latest.signed_hex || latest.fee_nanos === null || latest.txid !== row.txid) throw new PaymentError('payout_state_conflict', 'Cannot settle an unproven withdrawal');
      const amount = BigInt(latest.amount_nanos);
      const fee = BigInt(latest.fee_nanos);
      const surplus = BigInt(latest.max_fee_nanos) - fee;
      await lockWallets(tx, [`available:${latest.account_id}`, `reserved:${latest.account_id}`, 'external']);
      await transfer(tx, `withdrawal-settlement:${latest.id}`, `reserved:${latest.account_id}`, 'external', amount + fee,
        { txid: latest.txid, recipientAmountNanos: amount.toString(), feeNanos: fee.toString(), network: latest.network });
      if (surplus > 0n) await transfer(tx, `withdrawal-fee-refund:${latest.id}`, `reserved:${latest.account_id}`, `available:${latest.account_id}`, surplus);
      await tx.query("UPDATE payments_withdrawals SET status='settled',last_error=NULL,settled_at=now(),updated_at=now() WHERE id=$1", [latest.id]);
    });
  }

  private async failUnsignedWithdrawal(client: Tx, row: WithdrawalRow, code: string): Promise<void> {
    await inTransaction(client, async tx => {
      const result = await tx.query<WithdrawalRow>('SELECT * FROM payments_withdrawals WHERE id=$1 FOR UPDATE', [row.id]);
      const latest = result.rows[0]!;
      if (latest.signed_hex || latest.status === 'settled' || latest.status === 'failed') return;
      await lockWallets(tx, [`available:${latest.account_id}`, `reserved:${latest.account_id}`]);
      await transfer(tx, `withdrawal-failed-refund:${latest.id}`, `reserved:${latest.account_id}`, `available:${latest.account_id}`, BigInt(latest.amount_nanos) + BigInt(latest.max_fee_nanos), { code });
      await tx.query("UPDATE payments_withdrawals SET status='failed',last_error=$2,updated_at=now() WHERE id=$1", [latest.id, code]);
    });
  }
}
