import { randomBytes } from 'node:crypto';
import { lstat, open, readFile, rename, rm } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

const root = new URL('../', import.meta.url);
async function syncDirectory() {
  let directory;
  try {
    directory = await open(root, 'r');
    await directory.sync();
  } catch (error) {
    // Windows does not expose directory fsync through the portable Node API.
    if (process.platform !== 'win32' || !['EINVAL', 'ENOTSUP', 'EISDIR', 'EPERM', 'EACCES'].includes(error?.code)) throw error;
  } finally { await directory?.close(); }
}
const envPath = new URL('.env', root);
const args = process.argv.slice(2);
if (args.length > 1 || (args.length === 1 && !['--add-wallet', '--help'].includes(args[0]))) {
  console.error('Usage: npm run init [-- --add-wallet]');
  process.exit(1);
}
if (args[0] === '--help') {
  console.log('npm run init: create a new .env with independent random service secrets.\nnpm run init -- --add-wallet: add a missing service wallet seed to an existing .env without replacing any configured secret.\nBack up the service seed, database and encryption key together before funding. Existing populated legacy payment databases require the migration procedure in docs/ecash.md.');
  process.exit(0);
}

// An exclusive lock prevents concurrent setup commands from replacing a newly
// generated wallet seed. A crash leaves the lock for explicit operator review.
const lockPath = new URL('.env.init.lock', root);
let lock;
try {
  lock = await open(lockPath, 'wx', 0o600);
} catch (error) {
  if (error?.code === 'EEXIST') {
    console.error('Another setup operation holds .env.init.lock. If it was interrupted, verify no setup process is active before removing that lock.');
    process.exit(1);
  }
  throw error;
}
let temporary;
try {
  if (args[0] === '--add-wallet') {
    const stat = await lstat(envPath);
    if (!stat.isFile() || stat.isSymbolicLink()) throw new Error('Existing .env must be a regular file.');
    const content = await readFile(envPath, 'utf8');
    const matches = [...content.matchAll(/^\s*(?:export\s+)?XEC_WALLET_SEED_HEX\s*=([^\r\n]*)/gm)];
    if (matches.length > 1) throw new Error('Multiple wallet seed settings found. Resolve the duplicate configuration before setup.');
    if (matches[0] && !['', "''", '""', 'GENERATE_WALLET_SEED', "'GENERATE_WALLET_SEED'", '"GENERATE_WALLET_SEED"'].includes(matches[0][1].trim())) {
      throw new Error('A service wallet seed is already configured; it was preserved.');
    }
    const setting = `XEC_WALLET_SEED_HEX=${randomBytes(32).toString('hex')}`;
    const updated = matches[0]
      ? content.slice(0, matches[0].index) + setting + content.slice(matches[0].index + matches[0][0].length)
      : `${content}${content.endsWith('\n') ? '' : '\n'}${setting}\n`;
    temporary = new URL(`.env.init.${randomBytes(12).toString('hex')}.tmp`, root);
    const file = await open(temporary, 'wx', 0o600);
    try { await file.writeFile(updated, 'utf8'); await file.sync(); }
    finally { await file.close(); }
    await rename(temporary, envPath);
    temporary = undefined;
    await syncDirectory();
    console.log('Added a new dedicated service wallet seed to .env; all existing secrets were preserved.');
    console.log('Back up .env with the database before funding. A legacy funded payment database cannot be converted by changing its seed. See docs/ecash.md.');
  } else {
    const template = await readFile(new URL('.env.example', root), 'utf8');
    const password = randomBytes(32).toString('hex');
    const content = template
      .replaceAll('GENERATE_POSTGRES_PASSWORD', password)
      .replaceAll('GENERATE_ADMIN_TOKEN', `zoko_admin_${randomBytes(32).toString('base64url')}`)
      .replaceAll('GENERATE_ENCRYPTION_KEY', randomBytes(32).toString('base64'))
      .replaceAll('GENERATE_WALLET_SEED', randomBytes(32).toString('hex'));
    const file = await open(envPath, 'wx', 0o600);
    try { await file.writeFile(content, 'utf8'); await file.sync(); }
    finally { await file.close(); }
    await syncDirectory();
    console.log(`Created ${fileURLToPath(envPath)} with fresh independent service secrets.`);
    console.log('Set your domain and Typesafe API key. Back up the generated service wallet seed, database and encryption key before funding. Use your personal Cashtab wallet only to send to a deposit address.');
  }
} catch (error) {
  if (error?.code === 'EEXIST') console.error('.env already exists; its secrets were preserved. Use --add-wallet only to add a missing service seed.');
  else if (error?.code === 'ENOENT') console.error('Required setup file is missing. Run npm run init for a new deployment.');
  else console.error(error instanceof Error ? error.message : 'Setup failed.');
  process.exitCode = 1;
} finally {
  if (temporary) await rm(temporary, { force: true });
  await lock.close();
  await rm(lockPath, { force: true });
  await syncDirectory();
}
