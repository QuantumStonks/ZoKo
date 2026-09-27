import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { chmod, copyFile, mkdtemp, mkdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

async function withSetup(run: (directory: string) => Promise<void>): Promise<void> {
  const directory = await mkdtemp(join(tmpdir(), 'zoko-setup-'));
  const repository = fileURLToPath(new URL(import.meta.url.includes('/dist/') ? '../../' : '../', import.meta.url));
  try {
    await mkdir(join(directory, 'scripts'));
    await copyFile(join(repository, 'scripts/init-env.mjs'), join(directory, 'scripts/init-env.mjs'));
    await copyFile(join(repository, '.env.example'), join(directory, '.env.example'));
    await run(directory);
  } finally { await rm(directory, { recursive: true, force: true }); }
}

function invoke(directory: string, ...args: string[]) {
  return spawnSync(process.execPath, [join(directory, 'scripts/init-env.mjs'), ...args], { encoding: 'utf8', timeout: 10_000 });
}
function setting(content: string, name: string): string {
  const line = content.split('\n').find(value => value.startsWith(`${name}=`));
  assert.ok(line, `${name} must be present`);
  return line.slice(name.length + 1);
}

test('setup generates an independent service wallet secret without exposing it and refuses replacement', async () => {
  await withSetup(async directory => {
    const result = invoke(directory);
    assert.equal(result.status, 0);
    const content = await readFile(join(directory, '.env'), 'utf8');
    const seed = setting(content, 'XEC_WALLET_SEED_HEX');
    assert.match(seed, /^[0-9a-f]{64}$/);
    assert.notEqual(seed, setting(content, 'POSTGRES_PASSWORD'));
    assert.notEqual(seed, Buffer.from(setting(content, 'ZOKO_ENCRYPTION_KEY'), 'base64').toString('hex'));
    assert.ok(!content.includes('GENERATE_'));
    assert.equal(setting(content, 'ZOKO_PROVIDER_HOSTS'), '');
    assert.equal(setting(content, 'ZOKO_PLATFORM_FEE_BPS'), '1000');
    assert.doesNotMatch(content, /^(?:TYPESAFE_|ZOKO_JEV_)/m);
    assert.match(result.stdout, /No platform inference credentials or default offers are required/);
    assert.ok(!result.stdout.includes(seed) && !result.stderr.includes(seed));
    if (process.platform !== 'win32') assert.equal((await stat(join(directory, '.env'))).mode & 0o777, 0o600);
    assert.equal(invoke(directory).status, 1);
    assert.equal(invoke(directory, '--add-wallet').status, 1);
    assert.equal(await readFile(join(directory, '.env'), 'utf8'), content);
  });
});

test('adding a missing service seed preserves all existing secrets and tightens file permissions', async () => {
  await withSetup(async directory => {
    const original = 'ZOKO_ADMIN_TOKEN=existing-admin-value\nZOKO_ENCRYPTION_KEY=existing-key\nPOSTGRES_PASSWORD=existing-password\nZOKO_PROVIDER_HOSTS=agent.example.com\nZOKO_PLATFORM_FEE_BPS=500\n';
    await writeFile(join(directory, '.env'), original, { mode: 0o644 });
    await chmod(join(directory, '.env'), 0o644);
    const result = invoke(directory, '--add-wallet');
    assert.equal(result.status, 0);
    const updated = await readFile(join(directory, '.env'), 'utf8');
    assert.ok(updated.startsWith(original));
    assert.match(setting(updated, 'XEC_WALLET_SEED_HEX'), /^[0-9a-f]{64}$/);
    assert.ok(!result.stdout.includes(setting(updated, 'XEC_WALLET_SEED_HEX')));
    if (process.platform !== 'win32') assert.equal((await stat(join(directory, '.env'))).mode & 0o777, 0o600);
  });
});

test('setup replaces only an explicit empty placeholder and rejects ambiguous or locked configuration', async () => {
  await withSetup(async directory => {
    await writeFile(join(directory, '.env'), 'ZOKO_ADMIN_TOKEN=preserved\nXEC_WALLET_SEED_HEX=GENERATE_WALLET_SEED\n');
    assert.equal(invoke(directory, '--add-wallet').status, 0);
    assert.equal(setting(await readFile(join(directory, '.env'), 'utf8'), 'ZOKO_ADMIN_TOKEN'), 'preserved');
    const ambiguous = 'XEC_WALLET_SEED_HEX=\nXEC_WALLET_SEED_HEX=\n';
    await writeFile(join(directory, '.env'), ambiguous);
    assert.equal(invoke(directory, '--add-wallet').status, 1);
    assert.equal(await readFile(join(directory, '.env'), 'utf8'), ambiguous);
    await writeFile(join(directory, '.env.init.lock'), '');
    assert.equal(invoke(directory, '--add-wallet').status, 1);
    assert.equal(await readFile(join(directory, '.env'), 'utf8'), ambiguous);
  });
});
