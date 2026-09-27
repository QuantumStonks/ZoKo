import { readConfig } from './config.js';
import { createDb, auditLedger } from './db.js';
import { decrypt, validateEndpoint } from './security.js';
import { Payments } from './payments/index.js';
import { SCHEMA_VERSION } from './migration.js';

interface Check { name: string; status: 'pass' | 'fail' | 'warning'; message: string }

async function main(): Promise<void> {
  if (process.argv.includes('--help')) {
    console.log('Usage: npm run doctor\nRead-only configuration, PostgreSQL schema/ledger, account and seller ownership, stored seller credentials, endpoint policy, service wallet identity and hosted Chronik checks. No seller endpoints are called. No migrations, address assignments, signatures, inference or broadcasts are created.');
    return;
  }
  if (process.argv.length > 2) throw new Error('Unsupported doctor arguments; use --help.');
  const checks: Check[] = [];
  const add = (name: string, status: Check['status'], message: string) => checks.push({ name, status, message });
  let config;
  try {
    config = readConfig();
    add('configuration', 'pass', 'Required configuration and secret formats are valid.');
  } catch (error) {
    const legacy = error && typeof error === 'object' && 'code' in error && error.code === 'obsolete_node_configuration';
    add('configuration', 'fail', legacy
      ? 'Obsolete ABC_* configuration is present. Follow the legacy-wallet migration procedure in docs/ecash.md; preserve existing funded payment state and its original wallet.'
      : 'Invalid or missing configuration. Compare .env with .env.example and remove obsolete TYPESAFE_API_KEY, TYPESAFE_MODEL and ZOKO_JEV_PRICE_NANOS bootstrap settings; secrets were not printed.');
    console.log(JSON.stringify({ ok: false, checks }, null, 2));
    process.exitCode = 1;
    return;
  }
  if (!config.production) add('deployment', 'warning', 'NODE_ENV is not production; this configuration is for development.');
  add('business_model', 'pass', `Agent-to-agent marketplace; the platform retains ${config.platformFeeBps} basis points of each successful sale and the owning seller account receives the remainder. No platform inference service is provisioned.`);
  const db = createDb(config.databaseUrl);
  db.on('error', () => {});
  let databaseReady = false;
  try {
    const version = await db.query('SHOW server_version_num');
    if (Number(version.rows[0].server_version_num) < 160000) throw new Error('Unsupported PostgreSQL version');
    const migration = await db.query('SELECT max(version) AS version FROM zoko_migrations');
    if (migration.rows[0].version !== SCHEMA_VERSION) throw new Error('Unsupported schema version');
    databaseReady = true;
    add('database', 'pass', `PostgreSQL 16+ is reachable and schema version ${SCHEMA_VERSION} is installed.`);
    const ledger = await auditLedger(db) as { ok: boolean };
    add('ledger', ledger.ok ? 'pass' : 'fail', ledger.ok
      ? 'Wallet journal, decision budgets, and all decision/withdrawal reservations reconcile.'
      : 'Ledger reconciliation failed; keep the API stopped and investigate the audit.');
  } catch {
    add('database_setup', 'fail', 'Database, schema or ledger verification failed. Start once to apply migrations; verify DATABASE_URL and the installed release.');
  }
  if (databaseReady) {
    try {
      const accounts = await db.query('SELECT count(*)::integer AS total,count(*) FILTER (WHERE NOT disabled)::integer AS active FROM accounts');
      const account = accounts.rows[0];
      add('accounts', account.active > 0 ? 'pass' : 'warning', account.active > 0
        ? `${account.active} active agent account(s) out of ${account.total} total. Buyer and seller agents authenticate with their own account keys.`
        : 'No active agent accounts exist. Use the operator console or account API to issue buyer and seller keys.');
      const sellers = await db.query(`SELECT s.endpoint,s.api_key_encrypted,s.paused,s.payout_account_id,a.id AS owner_id,a.disabled AS owner_disabled
        FROM sellers s LEFT JOIN accounts a ON a.id=s.payout_account_id WHERE s.enabled`);
      let active = 0;
      for (const seller of sellers.rows) {
        if (!seller.payout_account_id || !seller.owner_id) throw new Error('Approved seller has no owning account');
        validateEndpoint(seller.endpoint, config.providerHosts);
        const key = decrypt(seller.api_key_encrypted, config.encryptionKey);
        if (!key || key.length > 4096 || /[^\x21-\x7e]/.test(key)) throw new Error('Invalid seller credential');
        if (!seller.paused && !seller.owner_disabled) active++;
      }
      if (sellers.rowCount) add('seller_configuration', 'pass', `${sellers.rowCount} approved offer(s) have owning accounts, decryptable credentials and endpoints permitted by the exact hostname allowlist.`);
      add('trading', active > 0 ? 'pass' : 'warning', active > 0
        ? `${active} approved, unpaused offer(s) have active seller owners. Actual endpoint availability and paid execution require a separate acceptance purchase.`
        : 'Trading is unavailable: no approved, unpaused offer has an active seller owner. The empty marketplace can remain healthy; allow a reviewed endpoint host, let its seller account publish an offer, then approve it.');
    } catch {
      add('seller_configuration', 'fail', 'Account ownership, stored seller credentials or endpoint policy failed verification. Check approval records, the exact hostname allowlist and the original encryption key.');
    }
  }
  try {
    if (!databaseReady) add('payments', 'fail', 'Wallet preflight requires an initialized database.');
    else {
      const payments = new Payments(db, config.payments);
      await payments.preflight();
      if (!config.payments.enabled) add('payments', 'fail', 'Payments are disabled. This is not a funded marketplace deployment.');
      else add('payments', 'pass', 'Dedicated service wallet identity, chain anchors, hosted tip freshness and token-index preflight passed. No address was assigned and no transaction was signed or broadcast.');
    }
  } catch (error) {
    const code = error && typeof error === 'object' && 'code' in error && typeof error.code === 'string' && /^[a-z_]{1,80}$/.test(error.code) ? error.code : 'payment_preflight_failed';
    add('payments', 'fail', code === 'node_wallet_migration_required'
      ? 'This database contains legacy node-wallet payment state. Preserve the original deployment and reconcile it using docs/ecash.md; a new service seed cannot convert its funds or pending payments.'
      : `Service wallet or hosted Chronik verification failed (${code}). Verify the original service seed, network, hosted endpoint and finality settings.`);
  }
  await db.end();
  const ok = checks.every(check => check.status !== 'fail');
  console.log(JSON.stringify({ ok, checks, scope: 'Read-only marketplace infrastructure checks, with no seller endpoint calls. Paid seller execution and on-chain deposit/withdrawal acceptance require explicit transactions.' }, null, 2));
  if (!ok) process.exitCode = 1;
}

main().catch(() => {
  console.error('Doctor failed before completion; no secrets were printed. Use --help to check invocation.');
  process.exitCode = 1;
});
