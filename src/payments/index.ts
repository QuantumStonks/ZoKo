import { randomUUID } from 'node:crypto';
import type { Tx as IndexedTx } from 'chronik-client';
import { type Db, type Tx, lockWallets, transaction, transfer } from '../db.js';
import { ChronikGateway, ChronikHttpError, assertPlainXec } from './chronik.js';
import { type PaymentsConfig, rpcChain } from './config.js';
import { AbcRpc, RpcError } from './rpc.js';
import { DUST_ATOMS, NANOS_PER_ATOM, PaymentError, nanosToXec, parseNanos, rawHex, record, requireAtoms, safeInteger, txid, xecToNanos } from './money.js';
import { addressScript, canonicalAddress, decodeRpcTransaction, scriptAddress, transactionId, verifyChronikTransaction, verifyFee, verifyInputsUnchanged, verifyWithdrawalOutputs, type InputOutpoint } from './verification.js';

export { type PaymentsConfig, readPaymentsConfig } from './config.js';
export { paymentsMigration } from './migration.js';
export { PaymentError } from './money.js';

const WORKER_LOCK = 701537613;
const OPEN_STATUSES = ['requested', 'preparing', 'signed', 'broadcast'];

interface WithdrawalRow {
  id: string;
  account_id: string;
  network: string;
  idempotency_key: string;
  address: string;
  amount_nanos: string;
  max_fee_nanos: string;
  fee_nanos: string | null;
  status: string;
  input_outpoints: InputOutpoint[];
  change_address: string | null;
  funded_hex: string | null;
  signed_hex: string | null;
  txid: string | null;
  last_error: string | null;
  broadcast_attempts: number;
  created_at: Date;
  updated_at: Date;
  settled_at: Date | null;
}

interface PaymentStatus {
  enabled: boolean;
  ready: boolean;
  network: string;
  confirmations: number;
  requireFinalized: boolean;
  lastCheckedAt: string | null;
  lastSyncedAt: string | null;
  lastError: string | null;
  nodeHeight?: number;
  chronikHeight?: number;
  depositsEnabled: boolean;
  withdrawalsEnabled: boolean;
  minWithdrawalNanos: string;
  maximumWithdrawalFeeNanos: string;
}

interface WalletIdentity {
  network: string;
  walletName: string;
  identityAddress?: string;
  genesis?: string;
}

function publicWithdrawal(row: WithdrawalRow) {
  return {
    id: row.id,
    address: row.address,
    network: row.network,
    amountNanos: row.amount_nanos,
    maxFeeNanos: row.max_fee_nanos,
    feeNanos: row.fee_nanos,
    reservedNanos: ['settled', 'failed'].includes(row.status) ? '0' : (BigInt(row.amount_nanos) + BigInt(row.max_fee_nanos)).toString(),
    maximumDebitNanos: (BigInt(row.amount_nanos) + BigInt(row.max_fee_nanos)).toString(),
    status: row.status,
    txid: row.txid,
    lastError: row.last_error,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    settledAt: row.settled_at,
  };
}

async function inTransaction<T>(client: Tx, fn: (client: Tx) => Promise<T>): Promise<T> {
  await client.query('BEGIN');
  try {
    const result = await fn(client);
    await client.query('COMMIT');
    return result;
  } catch (error) {
    try { await client.query('ROLLBACK'); } catch { /* Preserve the original failure. */ }
    throw error;
  }
}

function errorCode(error: unknown): string {
  return error instanceof PaymentError ? error.code : 'payment_processing_error';
}

export class Payments {
  private readonly rpc: AbcRpc;
  private readonly gateways: ChronikGateway[];
  private gateway: ChronikGateway | undefined;
  private state: PaymentStatus;
  private checking: Promise<PaymentStatus> | undefined;

  constructor(private readonly db: Db, readonly config: PaymentsConfig) {
    this.rpc = new AbcRpc(config);
    this.gateways = config.chronikUrls.map(url => new ChronikGateway(url, config.rpcTimeoutMs));
    this.state = {
      enabled: config.enabled, ready: !config.enabled, network: config.network,
      confirmations: config.confirmations, requireFinalized: config.requireFinalized,
      lastCheckedAt: null, lastSyncedAt: null, lastError: null,
      depositsEnabled: false, withdrawalsEnabled: false,
      minWithdrawalNanos: (DUST_ATOMS * NANOS_PER_ATOM).toString(), maximumWithdrawalFeeNanos: config.maxFeeNanos,
    };
  }

  status(): PaymentStatus {
    return { ...this.state, depositsEnabled: this.config.enabled && this.state.ready, withdrawalsEnabled: this.config.enabled && this.state.ready };
  }

  private assertEnabled(): void {
    if (!this.config.enabled) throw new PaymentError('payments_disabled', 'On-chain payments are disabled by operator configuration', 503);
  }

  private get chronik(): ChronikGateway {
    if (!this.gateway) throw new PaymentError('payments_not_ready', 'Payment preflight has not selected a healthy Chronik endpoint');
    return this.gateway;
  }

  async preflight(): Promise<PaymentStatus> {
    if (!this.config.enabled) return this.status();
    if (this.checking) return this.checking;
    this.checking = this.check();
    try { return await this.checking; }
    finally { this.checking = undefined; }
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

  private async check(): Promise<PaymentStatus> {
    try {
      if (!this.config.rpcUsername || !this.config.rpcPassword) throw new PaymentError('wallet_not_configured', 'Configure ABC_RPC_USERNAME and ABC_RPC_PASSWORD');
      const [currencyValue, chainValue, walletValue, networkValue] = await Promise.all([
        this.rpc.call('getcurrencyinfo'), this.rpc.call('getblockchaininfo'),
        this.rpc.call('getwalletinfo'), this.rpc.call('getnetworkinfo'),
      ]);
      const currency = record(currencyValue, 'currency');
      if (currency.ticker !== 'XEC' || safeInteger(currency.satoshisperunit, 'satoshis per unit') !== 100 || safeInteger(currency.decimals, 'currency decimals') !== 2) {
        throw new PaymentError('wrong_currency', 'Bitcoin ABC must use XEC with 100 atoms per unit and two decimal places (ecash=1)');
      }
      const chain = record(chainValue, 'blockchain');
      const height = safeInteger(chain.blocks, 'chain height');
      if (chain.chain !== rpcChain[this.config.network]) throw new PaymentError('wrong_network', 'Bitcoin ABC network does not match XEC_NETWORK');
      if (chain.initialblockdownload !== false || height < 0 || safeInteger(chain.headers, 'header height') - height > 1) {
        throw new PaymentError('node_syncing', 'Bitcoin ABC must finish blockchain synchronization');
      }
      const wallet = record(walletValue, 'wallet');
      if (wallet.walletname !== this.config.walletName || wallet.private_keys_enabled !== true || wallet.scanning !== false) {
        throw new PaymentError('wallet_not_ready', 'The configured dedicated signing wallet must be loaded and synchronized');
      }
      if (wallet.unlocked_until !== undefined && safeInteger(wallet.unlocked_until, 'wallet unlock time') <= Math.floor(Date.now() / 1000)) {
        throw new PaymentError('wallet_locked', 'The dedicated Bitcoin ABC wallet is locked; unlock it through your node administration process');
      }
      const network = record(networkValue, 'network');
      if (typeof network.subversion !== 'string' || !network.subversion.includes('Bitcoin ABC:')) {
        throw new PaymentError('unsupported_node', 'The configured RPC server must be Bitcoin ABC');
      }
      if (this.config.network !== 'regtest' && safeInteger(network.connections, 'peer count') <= 0) throw new PaymentError('node_offline', 'Bitcoin ABC has no network peers');
      if (this.config.requireFinalized) {
        const avalanche = record(await this.rpc.call('getavalancheinfo'), 'Avalanche');
        if (avalanche.ready_to_poll !== true) throw new PaymentError('avalanche_not_ready', 'Bitcoin ABC must establish its Avalanche polling quorum');
      }
      const genesis = txid(await this.rpc.call('getblockhash', [0]));
      const binding = await this.db.query<{ value: WalletIdentity }>("SELECT value FROM payments_state WHERE key='wallet-identity'");
      if (binding.rows[0] && (binding.rows[0].value.network !== this.config.network || binding.rows[0].value.walletName !== this.config.walletName)) {
        throw new PaymentError('wallet_binding_mismatch', 'This ledger is already bound to a different network or dedicated wallet');
      }
      if (binding.rows[0]) {
        const identity = binding.rows[0].value;
        if (!identity.identityAddress || identity.genesis !== genesis) throw new PaymentError('wallet_identity_incomplete', 'The stored wallet identity is incomplete or belongs to another chain');
        const ownership = record(await this.rpc.call('getaddressinfo', [identity.identityAddress]), 'wallet identity');
        if (ownership.ismine !== true) throw new PaymentError('wallet_binding_mismatch', 'Bitcoin ABC does not control this ledger\'s dedicated wallet identity address');
      }
      let selected: { gateway: ChronikGateway; height: number } | undefined;
      let selectionError: unknown;
      for (const gateway of this.gateways) {
        try {
          const [info, indexedGenesis] = await Promise.all([gateway.client.blockchainInfo(), gateway.client.block(0)]);
          if (indexedGenesis.blockInfo.hash !== genesis || !Number.isSafeInteger(info.tipHeight) || info.tipHeight < 0 || Math.abs(height - info.tipHeight) > 2) {
            throw new PaymentError('chronik_chain_mismatch', 'Chronik network or synchronization does not match Bitcoin ABC');
          }
          const canonicalTip = txid(await this.rpc.call('getblockhash', [info.tipHeight]));
          if (canonicalTip !== info.tipHash) throw new PaymentError('chronik_chain_mismatch', 'Chronik and Bitcoin ABC disagree on the canonical chain');
          await this.checkTokenIndex(gateway);
          selected = { gateway, height: info.tipHeight };
          break;
        } catch (error) { selectionError = error; }
      }
      if (!selected) throw selectionError ?? new PaymentError('chronik_not_configured', 'No Chronik endpoint is configured');
      this.gateway = selected.gateway;
      this.state = { ...this.state, ready: true, lastError: null, lastCheckedAt: new Date().toISOString(), nodeHeight: height, chronikHeight: selected.height };
      return this.status();
    } catch (error) {
      this.state = { ...this.state, ready: false, lastError: errorCode(error), lastCheckedAt: new Date().toISOString() };
      throw error;
    }
  }

  private async bindWallet(tx: Tx): Promise<void> {
    await tx.query("INSERT INTO payments_state(key,value) VALUES ('wallet-identity',$1) ON CONFLICT (key) DO NOTHING", [JSON.stringify({ network: this.config.network, walletName: this.config.walletName })]);
    const result = await tx.query<{ value: WalletIdentity }>("SELECT value FROM payments_state WHERE key='wallet-identity' FOR UPDATE");
    if (result.rows[0]?.value.network !== this.config.network || result.rows[0]?.value.walletName !== this.config.walletName) {
      throw new PaymentError('wallet_binding_mismatch', 'This ledger is bound to another wallet');
    }
    if (!result.rows[0].value.identityAddress) {
      const identityAddress = canonicalAddress(String(await this.rpc.call('getnewaddress', ['zoko:identity'])), this.config.network);
      const ownership = record(await this.rpc.call('getaddressinfo', [identityAddress]), 'wallet identity');
      if (ownership.ismine !== true) throw new PaymentError('wallet_binding_mismatch', 'Bitcoin ABC does not own the new ledger identity address');
      const genesis = txid(await this.rpc.call('getblockhash', [0]));
      await tx.query("UPDATE payments_state SET value=$1,updated_at=now() WHERE key='wallet-identity'", [JSON.stringify({ network: this.config.network, walletName: this.config.walletName, identityAddress, genesis })]);
    }
  }

  async provisionAddress(accountId: string): Promise<string> {
    this.assertEnabled();
    await this.preflight();
    return transaction(this.db, async tx => {
      await this.bindWallet(tx);
      const result = await tx.query<{ deposit_address: string | null; disabled: boolean }>('SELECT deposit_address,disabled FROM accounts WHERE id=$1 FOR UPDATE', [accountId]);
      const account = result.rows[0];
      if (!account) throw new PaymentError('account_not_found', 'Account does not exist', 404);
      if (account.disabled) throw new PaymentError('account_disabled', 'Account is disabled', 403);
      if (account.deposit_address) {
        const ownership = record(await this.rpc.call('getaddressinfo', [account.deposit_address]), 'deposit address ownership');
        if (ownership.ismine !== true) throw new PaymentError('wallet_address_mismatch', 'The configured wallet no longer controls the assigned deposit address');
        return account.deposit_address;
      }
      const address = canonicalAddress(String(await this.rpc.call('getnewaddress', [`zoko:${accountId}`])), this.config.network);
      const details = record(await this.rpc.call('getaddressinfo', [address]), 'address');
      if (details.ismine !== true) throw new PaymentError('wallet_address_mismatch', 'The dedicated wallet did not prove ownership of its new address');
      await tx.query('UPDATE accounts SET deposit_address=$2 WHERE id=$1', [accountId, address]);
      return address;
    });
  }

  async claimDeposit(accountId: string, id: string): Promise<unknown> {
    this.assertEnabled();
    txid(id);
    await this.preflight();
    const account = await this.db.query<{ deposit_address: string | null }>('SELECT deposit_address FROM accounts WHERE id=$1', [accountId]);
    if (!account.rows[0]?.deposit_address) throw new PaymentError('deposit_address_required', 'Create your assigned deposit address before making or claiming a deposit', 409);
    // Queue before fetching. A timeout cannot make this claim disappear permanently.
    await this.db.query('INSERT INTO payments_deposit_txs(network,txid) VALUES ($1,$2) ON CONFLICT(network,txid) DO UPDATE SET pending=true,next_check_at=now()', [this.config.network, id]);
    try { await this.observeDeposit(id); }
    catch (error) { await this.quarantineCredited(id); throw error; }
    const result = await this.db.query('SELECT txid,vout,amount_nanos AS "amountNanos",status,confirmations,avalanche_finalized AS "avalancheFinalized",credited_at AS "creditedAt" FROM payments_deposits WHERE network=$1 AND txid=$2 AND account_id=$3 ORDER BY vout', [this.config.network, id, accountId]);
    if (result.rows.length === 0) throw new PaymentError('deposit_not_owned', 'This transaction has no output to your assigned deposit address', 404);
    return { txid: id, deposits: result.rows };
  }

  private async observeDeposit(id: string): Promise<boolean> {
    const wallet = record(await this.rpc.call('gettransaction', [id, true, true]), 'wallet transaction');
    const raw = rawHex(wallet.hex);
    if (transactionId(raw) !== id) throw new PaymentError('payment_source_mismatch', 'Wallet transaction bytes do not match the requested ID');
    const decoded = decodeRpcTransaction(wallet.decoded ?? await this.rpc.call('decoderawtransaction', [raw]));
    const confirmations = safeInteger(wallet.confirmations, 'confirmations');
    let indexed: IndexedTx;
    try { indexed = await this.chronik.tx(id); }
    catch (error) {
      if (error instanceof ChronikHttpError && error.httpStatus === 404 && confirmations < 0) {
        await this.quarantineCredited(id, confirmations);
        return true;
      }
      throw error;
    }
    verifyChronikTransaction(decoded, indexed);
    const outputAddresses = decoded.outputs.map(output => scriptAddress(output.script, this.config.network));
    const owners = await this.db.query<{ id: string; deposit_address: string }>('SELECT id,deposit_address FROM accounts WHERE deposit_address = ANY($1::text[])', [outputAddresses.filter(address => address !== null)]);
    const ownerMap = new Map(owners.rows.map(owner => [owner.deposit_address, owner.id]));
    let plain = true;
    try { assertPlainXec(indexed); } catch (error) {
      if (error instanceof PaymentError && error.code === 'unsupported_token_transaction') plain = false;
      else throw error;
    }
    const blockHash = typeof wallet.blockhash === 'string' ? txid(wallet.blockhash) : null;
    if (confirmations > 0) {
      if (!indexed.block || indexed.block.hash !== blockHash || txid(await this.rpc.call('getblockhash', [indexed.block.height])) !== blockHash) {
        throw new PaymentError('payment_source_mismatch', 'Wallet and Chronik disagree on the deposit block');
      }
    }
    let finalized = false;
    if (this.config.requireFinalized && confirmations > 0 && indexed.isFinal) {
      finalized = await this.rpc.call('isfinaltransaction', [id, blockHash]) === true;
    }
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
        const address = outputAddresses[output.vout];
        const accountId = address ? ownerMap.get(address) : undefined;
        if (!accountId || !address || output.nanos <= 0n) continue;
        await tx.query(`INSERT INTO payments_deposits(network,txid,vout,account_id,amount_nanos,address,status,confirmations,avalanche_finalized,block_hash)
          VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) ON CONFLICT(network,txid,vout) DO NOTHING`,
        [this.config.network, id, output.vout, accountId, output.nanos.toString(), address, plain ? 'pending' : 'unsupported', confirmations, finalized, blockHash]);
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
          await tx.query("UPDATE payments_deposits SET status='credited',credited_at=now(),confirmations=$4,avalanche_finalized=$5,block_hash=$6,updated_at=now() WHERE network=$1 AND txid=$2 AND vout=$3", [this.config.network, id, output.vout, confirmations, finalized, blockHash]);
        } else {
          const status = prior.credited_at ? 'credited' : plain ? 'pending' : 'unsupported';
          await tx.query('UPDATE payments_deposits SET status=$4,confirmations=$5,avalanche_finalized=$6,block_hash=$7,updated_at=now() WHERE network=$1 AND txid=$2 AND vout=$3', [this.config.network, id, output.vout, status, confirmations, finalized, blockHash]);
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
      const pending = await client.query<{ txid: string }>('SELECT txid FROM payments_deposit_txs WHERE network=$1 AND pending AND next_check_at<=now() ORDER BY next_check_at,created_at LIMIT 100', [this.config.network]);
      for (const row of pending.rows) {
        try {
          const complete = await this.observeDeposit(row.txid);
          await client.query("UPDATE payments_deposit_txs SET pending=$3,next_check_at=now()+interval '15 seconds',last_error=NULL,updated_at=now() WHERE network=$1 AND txid=$2", [this.config.network, row.txid, !complete]);
        } catch (error) {
          await this.quarantineCredited(row.txid);
          await client.query("UPDATE payments_deposit_txs SET next_check_at=now()+interval '30 seconds',last_error=$3,updated_at=now() WHERE network=$1 AND txid=$2", [this.config.network, row.txid, errorCode(error)]);
        }
      }
      await this.restoreInputLocks(client);
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

  private async syncWalletHistory(client: Tx): Promise<void> {
    const key = `wallet-cursor:${this.config.network}:${this.config.walletName}`;
    const cursor = await client.query<{ value: { blockHash: string } }>('SELECT value FROM payments_state WHERE key=$1', [key]);
    const result = record(await this.rpc.call('listsinceblock', [cursor.rows[0]?.value.blockHash ?? null, 1, true, true]), 'wallet history');
    if (!Array.isArray(result.transactions) || !Array.isArray(result.removed)) throw new PaymentError('invalid_wallet_history', 'Bitcoin ABC must return complete wallet history and removed transaction information');
    const ids = [...new Set([...result.transactions, ...result.removed].map(value => txid(record(value, 'wallet history entry').txid)))];
    const lastblock = txid(result.lastblock);
    // The cursor and all discovered IDs commit together. Verification can be retried later.
    await inTransaction(client, async tx => {
      if (ids.length) await tx.query('INSERT INTO payments_deposit_txs(network,txid) SELECT $1,unnest($2::text[]) ON CONFLICT(network,txid) DO UPDATE SET pending=true,next_check_at=now(),updated_at=now()', [this.config.network, ids]);
      await tx.query('INSERT INTO payments_state(key,value) VALUES($1,$2) ON CONFLICT(key) DO UPDATE SET value=excluded.value,updated_at=now()', [key, JSON.stringify({ blockHash: lastblock })]);
    });
  }

  private async restoreInputLocks(client: Tx): Promise<void> {
    const pending = await client.query<WithdrawalRow>("SELECT * FROM payments_withdrawals WHERE network=$1 AND status IN ('preparing','signed','broadcast','manual_review')", [this.config.network]);
    const existing = await this.rpc.call('listlockunspent');
    if (!Array.isArray(existing)) throw new PaymentError('invalid_rpc_response', 'Bitcoin ABC returned invalid locked inputs');
    const locked = new Set(existing.map(value => {
      const input = record(value, 'locked input');
      return `${txid(input.txid)}:${safeInteger(input.vout, 'locked output index')}`;
    }));
    for (const withdrawal of pending.rows) {
      for (const input of withdrawal.input_outpoints) {
        if (locked.has(`${input.txid}:${input.vout}`)) continue;
        // Inputs already consumed by an accepted payout are not lockable and need no lock.
        if (await this.rpc.call('gettxout', [input.txid, input.vout, true]) === null) continue;
        if (await this.rpc.call('lockunspent', [false, [input]]) !== true) throw new PaymentError('utxo_lock_failed', 'Could not restore pending withdrawal input locks');
        locked.add(`${input.txid}:${input.vout}`);
      }
    }
  }

  private async selectInputs(client: Tx, needed: bigint): Promise<InputOutpoint[]> {
    const reserved = await client.query<{ input_outpoints: InputOutpoint[] }>("SELECT input_outpoints FROM payments_withdrawals WHERE status IN ('preparing','signed','broadcast','manual_review')");
    const excluded = new Set(reserved.rows.flatMap(row => row.input_outpoints.map(input => `${input.txid}:${input.vout}`)));
    const result = await this.rpc.call('listunspent', [this.config.confirmations, 9_999_999, [], false, { maximumCount: 1000 }]);
    if (!Array.isArray(result)) throw new PaymentError('invalid_rpc_response', 'Bitcoin ABC returned invalid spendable outputs');
    const coins = result.map(value => record(value, 'unspent output')).filter(value => value.spendable === true && value.solvable === true && value.safe === true)
      .map(value => ({ txid: txid(value.txid), vout: safeInteger(value.vout, 'unspent output index'), nanos: xecToNanos(value.amount) }))
      .filter(coin => coin.nanos > 0n && !excluded.has(`${coin.txid}:${coin.vout}`))
      .sort((a, b) => a.nanos === b.nanos ? `${a.txid}:${a.vout}`.localeCompare(`${b.txid}:${b.vout}`) : a.nanos > b.nanos ? -1 : 1);
    const chosen: InputOutpoint[] = [];
    const checked = new Map<string, IndexedTx>();
    let total = 0n;
    for (const coin of coins) {
      let indexed = checked.get(coin.txid);
      if (!indexed) { indexed = await this.chronik.tx(coin.txid); checked.set(coin.txid, indexed); }
      // Ignore unsolicited token-bearing coins, including zero-quantity mint batons.
      try { assertPlainXec(indexed); } catch (error) {
        if (error instanceof PaymentError && error.code === 'unsupported_token_transaction') continue;
        throw error;
      }
      const output = indexed.outputs[coin.vout];
      if (!output || output.spentBy || output.sats * NANOS_PER_ATOM !== coin.nanos || !indexed.block) continue;
      if (this.config.requireFinalized && !indexed.isFinal) continue;
      chosen.push({ txid: coin.txid, vout: coin.vout });
      total += coin.nanos;
      if (total >= needed) return chosen;
      if (chosen.length >= 200) break;
    }
    throw new PaymentError('insufficient_onchain_liquidity', 'The dedicated wallet lacks sufficient confirmed plain-XEC inputs within the transaction size bound');
  }

  private async buildWithdrawal(client: Tx, row: WithdrawalRow): Promise<WithdrawalRow> {
    const account = await client.query<{ disabled: boolean }>('SELECT disabled FROM accounts WHERE id=$1', [row.account_id]);
    if (!account.rows[0] || account.rows[0].disabled) throw new PaymentError('account_disabled', 'Account is disabled; no unsigned withdrawal may be broadcast', 403);
    await this.checkTokenIndex();
    if (row.signed_hex || row.txid) throw new PaymentError('payout_state_conflict', 'A persisted signed payment can never be rebuilt');
    let inputs = row.input_outpoints;
    let changeAddress = row.change_address;
    if (row.status === 'requested') {
      inputs = await this.selectInputs(client, BigInt(row.amount_nanos) + BigInt(row.max_fee_nanos));
      changeAddress = canonicalAddress(String(await this.rpc.call('getrawchangeaddress')), this.config.network);
      const changeInfo = record(await this.rpc.call('getaddressinfo', [changeAddress]), 'change address');
      if (changeInfo.ismine !== true) throw new PaymentError('invalid_change', 'Dedicated wallet does not own the proposed change address');
      await client.query("UPDATE payments_withdrawals SET status='preparing',input_outpoints=$2,change_address=$3,updated_at=now() WHERE id=$1 AND signed_hex IS NULL", [row.id, JSON.stringify(inputs), changeAddress]);
    }
    if (!changeAddress || inputs.length === 0) throw new PaymentError('payout_state_conflict', 'Preparing withdrawal has no reserved inputs/change');
    const raw = rawHex(await this.rpc.call('createrawtransaction', [inputs, { [row.address]: nanosToXec(BigInt(row.amount_nanos)) }]));
    const funded = record(await this.rpc.call('fundrawtransaction', [raw, {
      add_inputs: false, include_unsafe: false, lockUnspents: true,
      changeAddress, feeRate: this.config.feeRateXecPerKb,
    }]), 'funded transaction');
    const fundedHex = rawHex(funded.hex);
    const fundedFee = xecToNanos(funded.fee);
    const decodedFunded = decodeRpcTransaction(await this.rpc.call('decoderawtransaction', [fundedHex]));
    verifyInputsUnchanged(decodedFunded.inputs, inputs);
    verifyWithdrawalOutputs(decodedFunded, addressScript(row.address, this.config.network), BigInt(row.amount_nanos), addressScript(changeAddress, this.config.network));
    const inputTotal = await this.verifyPlainInputs(inputs);
    if (fundedFee <= 0n || fundedFee > BigInt(row.max_fee_nanos)) throw new PaymentError('payout_fee_limit', 'Funding exceeded the reserved network fee budget');
    await client.query('UPDATE payments_withdrawals SET funded_hex=$2,fee_nanos=$3,updated_at=now() WHERE id=$1 AND signed_hex IS NULL', [row.id, fundedHex, fundedFee.toString()]);
    const signed = record(await this.rpc.call('signrawtransactionwithwallet', [fundedHex, [], 'ALL|FORKID']), 'signed transaction');
    if (signed.complete !== true) throw new PaymentError('incomplete_signature', 'Bitcoin ABC did not completely sign the withdrawal');
    const signedHex = rawHex(signed.hex);
    const decoded = decodeRpcTransaction(await this.rpc.call('decoderawtransaction', [signedHex]));
    if (transactionId(signedHex) !== decoded.txid) throw new PaymentError('payout_txid_mismatch', 'Signed transaction bytes do not match their decoded ID');
    verifyInputsUnchanged(decoded.inputs, inputs);
    verifyWithdrawalOutputs(decoded, addressScript(row.address, this.config.network), BigInt(row.amount_nanos), addressScript(changeAddress, this.config.network));
    verifyFee(inputTotal, decoded.outputs.reduce((sum, output) => sum + output.nanos, 0n), fundedFee, BigInt(row.max_fee_nanos), xecToNanos(this.config.maxFeeRateXecPerKb), signedHex.length / 2);
    assertPlainXec(await this.chronik.client.validateRawTx(signedHex));
    const acceptance = await this.rpc.call('testmempoolaccept', [[signedHex], this.config.maxFeeRateXecPerKb]);
    if (!Array.isArray(acceptance) || acceptance.length !== 1 || record(acceptance[0], 'mempool acceptance').allowed !== true) {
      throw new PaymentError('payout_preflight_rejected', 'Bitcoin ABC rejected the fully signed withdrawal during preflight');
    }
    // Critical durability boundary: no broadcast call exists before this committed write.
    return inTransaction(client, async tx => {
      const permission = await tx.query<{ disabled: boolean }>('SELECT disabled FROM accounts WHERE id=$1 FOR UPDATE', [row.account_id]);
      if (!permission.rows[0] || permission.rows[0].disabled) throw new PaymentError('account_disabled', 'Account was disabled while the withdrawal was being prepared', 403);
      const saved = await tx.query<WithdrawalRow>("UPDATE payments_withdrawals SET signed_hex=$2,txid=$3,status='signed',last_error=NULL,updated_at=now() WHERE id=$1 AND signed_hex IS NULL RETURNING *", [row.id, signedHex, decoded.txid]);
      if (!saved.rows[0]) throw new PaymentError('payout_state_conflict', 'Withdrawal already acquired signed transaction bytes');
      return saved.rows[0];
    });
  }

  private async verifyPlainInputs(inputs: InputOutpoint[]): Promise<bigint> {
    const checked = new Map<string, IndexedTx>();
    let total = 0n;
    for (const input of inputs) {
      let indexed = checked.get(input.txid);
      if (!indexed) { indexed = await this.chronik.tx(input.txid); checked.set(input.txid, indexed); }
      assertPlainXec(indexed);
      const output = indexed.outputs[input.vout];
      if (!output || output.token !== undefined) throw new PaymentError('payout_input_missing', 'Withdrawal input is missing or token-bearing');
      total += output.sats * NANOS_PER_ATOM;
    }
    return total;
  }

  private async processWithdrawal(client: Tx, initial: WithdrawalRow): Promise<void> {
    let row = initial;
    try {
      if (!row.signed_hex) row = await this.buildWithdrawal(client, row);
      if (!row.signed_hex || !row.txid) throw new PaymentError('payout_state_conflict', 'Withdrawal has no persisted signed bytes');
      // Reconcile before any rebroadcast, including after a process/node restart.
      let wallet: Record<string, unknown> | null = null;
      try { wallet = record(await this.rpc.call('gettransaction', [row.txid, true, true]), 'withdrawal transaction'); }
      catch (error) { if (!(error instanceof RpcError && error.rpcCode === -5)) throw error; }
      if (wallet) {
        const confirmations = safeInteger(wallet.confirmations, 'withdrawal confirmations');
        if (confirmations < 0 || wallet.abandoned === true || (Array.isArray(wallet.walletconflicts) && wallet.walletconflicts.length > 0)) {
          await client.query("UPDATE payments_withdrawals SET status='manual_review',last_error='onchain_conflict',updated_at=now() WHERE id=$1", [row.id]);
          return;
        }
        if (rawHex(wallet.hex) !== row.signed_hex) throw new PaymentError('payout_bytes_mismatch', 'Wallet withdrawal does not match the persisted signed bytes');
        let indexed: IndexedTx | undefined;
        try { indexed = await this.chronik.tx(row.txid); } catch (error) {
          if (!(error instanceof ChronikHttpError && error.httpStatus === 404 && confirmations === 0)) throw error;
        }
        if (indexed) {
          assertPlainXec(indexed);
          const decoded = decodeRpcTransaction(wallet.decoded ?? await this.rpc.call('decoderawtransaction', [rawHex(wallet.hex)]));
          verifyChronikTransaction(decoded, indexed);
        }
        if (confirmations >= this.config.confirmations && indexed?.block && wallet.blockhash === indexed.block.hash &&
            txid(await this.rpc.call('getblockhash', [indexed.block.height])) === indexed.block.hash &&
            (!this.config.requireFinalized || (indexed.isFinal && await this.rpc.call('isfinaltransaction', [row.txid, indexed.block.hash]) === true))) {
          await this.settleWithdrawal(client, row);
          return;
        }
        if (confirmations > 0) {
          await client.query("UPDATE payments_withdrawals SET status='broadcast',last_error=NULL,updated_at=now() WHERE id=$1 AND status IN ('signed','broadcast')", [row.id]);
          return;
        }
        // A known wallet transaction can be evicted from mempool: same-byte rebroadcast remains safe.
      }
      const permission = await client.query<{ disabled: boolean }>('SELECT disabled FROM accounts WHERE id=$1', [row.account_id]);
      if (!permission.rows[0] || permission.rows[0].disabled) {
        await client.query("UPDATE payments_withdrawals SET status='manual_review',last_error='account_disabled',updated_at=now() WHERE id=$1", [row.id]);
        return;
      }
      await this.checkTokenIndex();
      await this.verifyPlainInputs(row.input_outpoints);
      assertPlainXec(await this.chronik.client.validateRawTx(row.signed_hex));
      await client.query('UPDATE payments_withdrawals SET broadcast_attempts=broadcast_attempts+1,updated_at=now() WHERE id=$1', [row.id]);
      // Keep the account row locked while attempting the external send. The
      // signed bytes and attempt counter are already durable before this begins.
      await inTransaction(client, async tx => {
        const permission = await tx.query<{ disabled: boolean }>('SELECT disabled FROM accounts WHERE id=$1 FOR UPDATE', [row.account_id]);
        if (!permission.rows[0] || permission.rows[0].disabled) {
          await tx.query("UPDATE payments_withdrawals SET status='manual_review',last_error='account_disabled',updated_at=now() WHERE id=$1", [row.id]);
          return;
        }
        const sentId = txid(await this.rpc.call('sendrawtransaction', [row.signed_hex, this.config.maxFeeRateXecPerKb]));
        if (sentId !== row.txid) throw new PaymentError('payout_txid_mismatch', 'Bitcoin ABC broadcast returned an unexpected transaction ID');
        await tx.query("UPDATE payments_withdrawals SET status='broadcast',last_error=NULL,updated_at=now() WHERE id=$1 AND status IN ('signed','broadcast')", [row.id]);
      });
    } catch (error) {
      // A failed/unknown broadcast can NEVER refund or recreate a signed payment.
      const current = await client.query<WithdrawalRow>('SELECT * FROM payments_withdrawals WHERE id=$1', [row.id]);
      if (!current.rows[0]) throw error;
      if (current.rows[0].signed_hex) {
        await client.query('UPDATE payments_withdrawals SET last_error=$2,updated_at=now() WHERE id=$1', [row.id, errorCode(error)]);
      } else {
        await this.failUnsignedWithdrawal(client, current.rows[0], errorCode(error));
      }
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
    let unlock: InputOutpoint[] = [];
    await inTransaction(client, async tx => {
      const result = await tx.query<WithdrawalRow>('SELECT * FROM payments_withdrawals WHERE id=$1 FOR UPDATE', [row.id]);
      const latest = result.rows[0]!;
      if (latest.signed_hex || latest.status === 'settled' || latest.status === 'failed') return;
      await lockWallets(tx, [`available:${latest.account_id}`, `reserved:${latest.account_id}`]);
      await transfer(tx, `withdrawal-failed-refund:${latest.id}`, `reserved:${latest.account_id}`, `available:${latest.account_id}`, BigInt(latest.amount_nanos) + BigInt(latest.max_fee_nanos), { code });
      await tx.query("UPDATE payments_withdrawals SET status='failed',last_error=$2,updated_at=now() WHERE id=$1", [latest.id, code]);
      unlock = latest.input_outpoints;
    });
    // Only unlock inputs for a transaction that never crossed the durable signing boundary.
    for (const input of unlock) {
      try { await this.rpc.call('lockunspent', [true, [input]]); } catch { /* Safe orphan locks reduce liquidity; never reuse a signed reservation. */ }
    }
  }
}
