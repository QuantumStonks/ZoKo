import { randomBytes } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

const root = new URL('../', import.meta.url);
const template = await readFile(new URL('.env.example', root), 'utf8');
const password = randomBytes(32).toString('hex');
const content = template
  .replaceAll('GENERATE_POSTGRES_PASSWORD', password)
  .replaceAll('GENERATE_ADMIN_TOKEN', `zoko_admin_${randomBytes(32).toString('base64url')}`)
  .replaceAll('GENERATE_ENCRYPTION_KEY', randomBytes(32).toString('base64'));
try {
  await writeFile(new URL('.env', root), content, { flag: 'wx', mode: 0o600 });
  console.log(`Created ${fileURLToPath(new URL('.env', root))} with fresh secrets.`);
  console.log('Set your domain, Typesafe API key and dedicated Bitcoin ABC wallet credentials. Keep a secure backup of the encryption key.');
} catch (error) {
  if (error?.code === 'EEXIST') {
    console.error('.env already exists; its secrets were preserved. Edit that file to finish setup.');
    process.exitCode = 1;
  } else throw error;
}
