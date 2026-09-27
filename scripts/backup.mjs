import { spawn } from 'node:child_process';
import { createReadStream } from 'node:fs';
import { mkdir, open, rm, writeFile } from 'node:fs/promises';
import { createHash, randomUUID } from 'node:crypto';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

if (process.argv.length > 3 || process.argv.includes('--help')) {
  console.log('Usage: npm run backup -- [destination.dump]\nWrites a consistent PostgreSQL custom-format backup and SHA-256 checksum. Retain an encrypted backup of the original service wallet seed and encryption key separately; see docs/deployment.md.');
  process.exit(process.argv.includes('--help') ? 0 : 1);
}
const root = fileURLToPath(new URL('../', import.meta.url));
const destination = resolve(process.argv[2] ?? `${root}/backups/zoko-${new Date().toISOString().replaceAll(':', '-')}.dump`);
await mkdir(dirname(destination), { recursive: true, mode: 0o700 });
const temporary = `${destination}.${randomUUID()}.tmp`;
const file = await open(temporary, 'wx', 0o600);
try {
  await new Promise((resolveRun, reject) => {
    const child = spawn('docker', ['compose', 'exec', '-T', 'database', 'sh', '-c', 'PGPASSWORD="$POSTGRES_PASSWORD" pg_dump --username=zoko --dbname=zoko --format=custom --no-owner --no-privileges'], {
      cwd: root, stdio: ['ignore', file.fd, 'inherit'], shell: false,
    });
    child.on('error', reject);
    child.on('exit', code => code === 0 ? resolveRun() : reject(new Error(`pg_dump exited with code ${code}`)));
  });
  await file.sync();
  await file.close();
  const checksum = createHash('sha256');
  for await (const chunk of createReadStream(temporary)) checksum.update(chunk);
  // Publish by hard link so an existing backup is never overwritten.
  const { link } = await import('node:fs/promises');
  await link(temporary, destination);
  await rm(temporary);
  await writeFile(`${destination}.sha256`, `${checksum.digest('hex')}  ${destination.split(/[\\/]/).at(-1)}\n`, { flag: 'wx', mode: 0o600 });
  console.log(`Saved ${destination} and SHA-256 checksum. Copy both to encrypted off-host storage.`);
  console.log('This database backup does not contain the service wallet seed or provider encryption key. Retain their original values in the matching encrypted configuration backup.');
} catch (error) {
  await file.close().catch(() => {});
  await rm(temporary, { force: true });
  console.error(error instanceof Error ? error.message : 'Backup failed.');
  process.exitCode = 1;
}
