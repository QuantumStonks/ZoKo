import { readConfig } from './config.js';
import { createDb, auditLedger } from './db.js';
import { decrypt, validateEndpoint } from './security.js';
import { Payments } from './payments/index.js';
import { restrictedProviderFetch, closeProviderConnections } from './provider-network.js';

interface Check { name: string; status: 'pass' | 'fail' | 'warning'; message: string }

/** Authenticated metadata read only: never invokes paid inference. */
async function checkTypesafe(apiKey: string): Promise<string[]> {
  const response = await restrictedProviderFetch('https://api.typesafe.ai/v1/models', {
    headers: { Authorization: `Bearer ${apiKey}`, Accept: 'application/json' },
    redirect: 'error', signal: AbortSignal.timeout(10_000),
  });
  if (!response.ok) {
    await response.body?.cancel();
    throw new Error(`Typesafe metadata endpoint returned HTTP ${response.status}.`);
  }
  if (!response.body) throw new Error('Typesafe returned no metadata.');
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let bytes = 0;
  try {
    for (;;) {
      const next = await reader.read();
      if (next.done) break;
      bytes += next.value.length;
      if (bytes > 262_144) throw new Error('Typesafe metadata exceeded the response limit.');
      chunks.push(next.value);
    }
  } finally {
    await reader.cancel().catch(() => {});
    reader.releaseLock();
  }
  const payload: unknown = JSON.parse(Buffer.concat(chunks).toString('utf8'));
  if (!payload || typeof payload !== 'object' || !('models' in payload) || !Array.isArray(payload.models)) throw new Error('Typesafe returned an unexpected model metadata schema.');
  const names = payload.models.map((model: unknown) => {
    if (!model || typeof model !== 'object' || !('name' in model) || typeof model.name !== 'string') throw new Error('Typesafe returned an invalid model entry.');
    return model.name;
  });
  if (names.length === 0) throw new Error('Typesafe model metadata is empty.');
  return names;
}

async function main(): Promise<void> {
  if (process.argv.includes('--help')) {
    console.log('Usage: npm run doctor\nRead-only configuration, PostgreSQL schema/ledger, wallet preflight, and provider metadata checks. No migrations, inference, deposits or payouts are created.');
    return;
  }
  if (process.argv.length > 2) throw new Error('Unsupported doctor arguments; use --help.');
  const checks: Check[] = [];
  const add = (name: string, status: Check['status'], message: string) => checks.push({ name, status, message });
  let config;
  try {
    config = readConfig();
    add('configuration', 'pass', 'Required configuration and secret formats are valid.');
  } catch {
    add('configuration', 'fail', 'Invalid or missing configuration. Compare .env with .env.example; secrets were not printed.');
    console.log(JSON.stringify({ ok: false, checks }, null, 2));
    process.exitCode = 1;
    return;
  }
  if (!config.production) add('deployment', 'warning', 'NODE_ENV is not production; this configuration is for development.');
  const db = createDb(config.databaseUrl);
  db.on('error', () => {});
  let databaseReady = false;
  let typesafeCredential: string | undefined = config.jevApiKey;
  try {
    const version = await db.query('SHOW server_version_num');
    if (Number(version.rows[0].server_version_num) < 160000) throw new Error('Unsupported PostgreSQL version');
    const migration = await db.query('SELECT max(version) AS version FROM zoko_migrations');
    if (migration.rows[0].version !== 1) throw new Error('Unsupported schema version');
    databaseReady = true;
    add('database', 'pass', 'PostgreSQL 16+ is reachable and schema version 1 is installed.');
    const ledger = await auditLedger(db) as { ok: boolean };
    add('ledger', ledger.ok ? 'pass' : 'fail', ledger.ok
      ? 'Wallet journal, decision budgets, and all decision/withdrawal reservations reconcile.'
      : 'Ledger reconciliation failed; keep the API stopped and investigate the audit.');
    const sellers = await db.query('SELECT endpoint,api_key_encrypted,model FROM sellers WHERE enabled=true');
    if (!sellers.rowCount) add('sellers', 'fail', 'No enabled seller is registered. Start the service with TYPESAFE_API_KEY configured or register a real seller as admin.');
    else {
      for (const seller of sellers.rows) {
        const endpoint = validateEndpoint(seller.endpoint, config.providerHosts);
        const key = decrypt(seller.api_key_encrypted, config.encryptionKey);
        if (!key) throw new Error('Empty seller credential');
        if (new URL(endpoint).hostname === 'api.typesafe.ai') typesafeCredential = key;
      }
      add('sellers', 'pass', `${sellers.rowCount} enabled seller credential envelope(s) decrypt and endpoints meet the allowlist.`);
    }
  } catch {
    add('database_setup', 'fail', 'Database, schema, or stored seller verification failed. Start once to apply migrations; verify DATABASE_URL and the original encryption key.');
  }
  try {
    if (!databaseReady) add('payments', 'fail', 'Wallet preflight requires an initialized database.');
    else {
      const payments = new Payments(db, config.payments);
      await payments.preflight();
      if (!config.payments.enabled) add('payments', 'fail', 'Payments are disabled. This is not a funded marketplace deployment.');
      else add('payments', 'pass', 'Dedicated wallet and chain preflight passed. No payment was created.');
    }
  } catch {
    add('payments', 'fail', 'Wallet or chain preflight failed. Verify Bitcoin ABC credentials, dedicated wallet, Chronik, network and finality settings.');
  }
  if (typesafeCredential) {
    try {
      const models = await checkTypesafe(typesafeCredential);
      add('typesafe', 'pass', `Authenticated model metadata is reachable (${models.length} published aliases). Pinned model names may be absent from this alias list; no paid inference was performed.`);
    } catch {
      add('typesafe', 'fail', 'Typesafe authenticated model metadata failed. Check the credential and outbound HTTPS connectivity.');
    }
  } else add('typesafe', 'warning', 'No Typesafe credential was available for a metadata check. Custom providers require their own acceptance test.');
  await db.end();
  await closeProviderConnections();
  const ok = checks.every(check => check.status !== 'fail');
  console.log(JSON.stringify({ ok, checks, scope: 'Read-only infrastructure checks. Paid inference and on-chain deposit/withdrawal acceptance require explicit transactions.' }, null, 2));
  if (!ok) process.exitCode = 1;
}

main().catch(() => {
  console.error('Doctor failed before completion; no secrets were printed. Use --help to check invocation.');
  process.exitCode = 1;
});
