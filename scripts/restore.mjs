import { spawn } from 'node:child_process';
import { createReadStream } from 'node:fs';
import { open, readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const args = process.argv.slice(2);
if (args.length !== 2 || args[1] !== '--confirm-restore') {
  console.error('Usage: npm run restore -- /absolute/backup.dump --confirm-restore\nStops the API and replaces the PostgreSQL database from a verified backup. Restore the matching Bitcoin ABC wallet and run doctor before restarting the API.');
  process.exit(1);
}
const source = resolve(args[0]);
const expected = (await readFile(`${source}.sha256`, 'utf8')).trim().split(/\s+/)[0];
if (!/^[a-f0-9]{64}$/.test(expected ?? '')) throw new Error('Invalid backup checksum file.');
const checksum = createHash('sha256');
for await (const chunk of createReadStream(source)) checksum.update(chunk);
if (checksum.digest('hex') !== expected) throw new Error('Backup checksum mismatch; no changes were made.');
const root = fileURLToPath(new URL('../', import.meta.url));
const run = (arguments_, input = 'ignore') => new Promise((resolveRun, reject) => {
  const child = spawn('docker', arguments_, { cwd: root, stdio: [input, 'inherit', 'inherit'], shell: false });
  child.on('error', reject);
  child.on('exit', code => code === 0 ? resolveRun() : reject(new Error(`Docker command failed with code ${code}; API remains stopped.`)));
});
await run(['compose', 'stop', 'api']);
await run(['compose', 'up', '-d', '--wait', 'database']);
const input = await open(source, 'r');
try {
  await run(['compose', 'exec', '-T', 'database', 'sh', '-c', 'PGPASSWORD="$POSTGRES_PASSWORD" pg_restore --username=zoko --dbname=zoko --clean --if-exists --no-owner --no-privileges --single-transaction --exit-on-error'], input.fd);
} finally { await input.close(); }
console.log('Database restored. API remains stopped. Restore the matching dedicated wallet, run doctor, reconcile withdrawals, then explicitly start the API.');
