import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { randomBytes, randomUUID } from 'node:crypto';
import { setTimeout as pause } from 'node:timers/promises';

const databaseUrl = process.env.TEST_DATABASE_URL;
if (!databaseUrl || new URL(databaseUrl).pathname !== '/zoko_test') {
  throw new Error('Runtime smoke requires TEST_DATABASE_URL pointing at the disposable zoko_test database.');
}
const container = `zoko-smoke-${randomUUID()}`;
const admin = randomBytes(32).toString('hex');
const baseUrl = 'http://127.0.0.1:3100';
const environment = {
  ...process.env,
  DATABASE_URL: databaseUrl,
  ZOKO_ADMIN_TOKEN: admin,
  ZOKO_ENCRYPTION_KEY: randomBytes(32).toString('base64'),
  ZOKO_PUBLIC_URL: 'https://zoko.invalid',
  ZOKO_PAYMENTS_ENABLED: 'false',
  PORT: '3100',
};
const docker = (args, { log = false } = {}) => new Promise((resolve, reject) => {
  const child = spawn('docker', args, { env: environment, shell: false });
  const output = [];
  child.stdout.on('data', chunk => { if (log) process.stdout.write(chunk); else output.push(chunk); });
  child.stderr.on('data', chunk => { if (log) process.stderr.write(chunk); });
  child.on('error', reject);
  child.on('exit', code => code === 0 ? resolve(Buffer.concat(output).toString('utf8').trim()) : reject(new Error(`docker ${args[0]} exited with code ${code}`)));
});
const request = (path, options = {}) => fetch(`${baseUrl}${path}`, { ...options, signal: AbortSignal.timeout(5_000) });
try {
  await docker(['run', '--detach', '--init', '--name', container, '--network', 'host', '--read-only', '--tmpfs', '/tmp:size=32m,noexec,nosuid', '--cap-drop', 'ALL', '--security-opt', 'no-new-privileges',
    ...['DATABASE_URL', 'ZOKO_ADMIN_TOKEN', 'ZOKO_ENCRYPTION_KEY', 'ZOKO_PUBLIC_URL', 'ZOKO_PAYMENTS_ENABLED', 'PORT'].flatMap(name => ['--env', name]), 'zoko:ci']);
  const until = Date.now() + 60_000;
  let live = false;
  while (Date.now() < until) {
    try { if ((await request('/health/live')).ok) { live = true; break; } } catch { /* startup is still in progress */ }
    await pause(300);
  }
  assert.ok(live, 'The production image did not become live within 60 seconds.');
  assert.equal(await docker(['inspect', '--format', '{{.Config.User}}', container]), 'node', 'The runtime must be unprivileged.');
  assert.equal(await docker(['inspect', '--format', '{{.HostConfig.ReadonlyRootfs}}', container]), 'true', 'The runtime filesystem must be read-only.');
  const page = await request('/');
  assert.equal(page.status, 200, 'The built image must serve the console.');
  assert.match(await page.text(), /Zoko/i);
  assert.equal((await request('/health/ready')).status, 503, 'Missing sellers must keep readiness false.');
  assert.equal((await request('/v1/me')).status, 401, 'Buyer data requires authentication.');
  const created = await request('/v1/admin/accounts', {
    method: 'POST', headers: { authorization: `Bearer ${admin}`, 'content-type': 'application/json' },
    body: JSON.stringify({ name: 'Container acceptance', dailyLimitNanos: '100000000000', maxPriceNanos: '100000000000' }),
  });
  assert.equal(created.status, 201, 'Admin must be able to create an account in the built image.');
  const account = await created.json();
  assert.equal(typeof account.apiKey, 'string');
  const me = await request('/v1/me', { headers: { authorization: `Bearer ${account.apiKey}` } });
  assert.equal(me.status, 200);
  const balance = await me.json();
  assert.equal(balance.balanceNanos, '0');
  assert.equal(balance.reservedNanos, '0');
  const audit = await request('/v1/admin/audit', { headers: { authorization: `Bearer ${admin}` } });
  assert.equal(audit.status, 200);
  assert.equal((await audit.json()).ok, true, 'The new account must preserve the journal invariant.');
  console.log('Runtime smoke passed: unprivileged read-only image, PostgreSQL startup, console, fail-closed readiness, authentication, account creation and ledger audit. No provider call or payment occurred.');
} catch (error) {
  await docker(['logs', '--tail', '80', container], { log: true }).catch(() => {});
  throw error;
} finally {
  await docker(['rm', '--force', container]).catch(() => {});
}
