import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, readFile, readdir, rm, stat, symlink, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { dirname, join, resolve, sep } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { promisify } from 'node:util';
import { crc32, inflateRawSync } from 'node:zlib';

const exec = promisify(execFile);
const project = fileURLToPath(new URL('../', import.meta.url));
const digest = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex');
interface BuiltPlugin { directory: string; archive: string; sha256: string; files: number; bytes: number }
const { buildPlugin } = await import(pathToFileURL(resolve(project, 'scripts/build-plugin.mjs')).href) as { buildPlugin: (options: { outputDirectory: string }) => Promise<BuiltPlugin> };

/** Independently inspect ZIP central/local records and CRCs using Node's zlib. */
function inspectArchive(archive: Buffer): Map<string, Buffer> {
  const end = archive.length - 22;
  assert.equal(archive.readUInt32LE(end), 0x06054b50, 'ZIP end record');
  assert.equal(archive.readUInt16LE(end + 4), 0, 'single-disk archive');
  assert.equal(archive.readUInt16LE(end + 6), 0);
  assert.equal(archive.readUInt16LE(end + 20), 0, 'no unverified trailing comment');
  const count = archive.readUInt16LE(end + 10);
  assert.equal(archive.readUInt16LE(end + 8), count);
  let cursor = archive.readUInt32LE(end + 16);
  assert.equal(cursor + archive.readUInt32LE(end + 12), end, 'central directory ends at EOCD');
  const files = new Map<string, Buffer>();
  for (let index = 0; index < count; index++) {
    assert.equal(archive.readUInt32LE(cursor), 0x02014b50, 'central entry');
    assert.equal(archive.readUInt16LE(cursor + 8), 0x800, 'unencrypted UTF-8');
    assert.equal(archive.readUInt16LE(cursor + 10), 8, 'standard deflate');
    assert.equal(archive.readUInt16LE(cursor + 12), 0, 'fixed time');
    assert.equal(archive.readUInt16LE(cursor + 14), 33, 'fixed date');
    assert.equal(archive.readUInt32LE(cursor + 38) >>> 16, 0o100644, 'regular file, not symlink');
    const nameLength = archive.readUInt16LE(cursor + 28);
    const name = archive.toString('utf8', cursor + 46, cursor + 46 + nameLength);
    assert.match(name, /^zoko\/[a-zA-Z0-9_./-]+$/);
    assert.ok(!name.split('/').includes('..') && !files.has(name), 'unique contained path');
    const local = archive.readUInt32LE(cursor + 42);
    assert.equal(archive.readUInt32LE(local), 0x04034b50, 'local entry');
    const localNameLength = archive.readUInt16LE(local + 26);
    assert.equal(archive.toString('utf8', local + 30, local + 30 + localNameLength), name);
    const start = local + 30 + localNameLength + archive.readUInt16LE(local + 28);
    const bytes = inflateRawSync(archive.subarray(start, start + archive.readUInt32LE(cursor + 20)));
    assert.equal(bytes.length, archive.readUInt32LE(cursor + 24), 'uncompressed length');
    assert.equal(crc32(bytes), archive.readUInt32LE(cursor + 16), 'CRC-32 integrity');
    files.set(name, bytes);
    cursor += 46 + nameLength + archive.readUInt16LE(cursor + 30) + archive.readUInt16LE(cursor + 32);
  }
  assert.equal(cursor, end, 'all central entries consumed');
  assert.deepEqual([...files.keys()], [...files.keys()].sort(), 'stable entry order');
  return files;
}

test('plugin archives are deterministic, contain only portable assets and run after independent extraction', async (t) => {
  const temporary = await mkdtemp(join(tmpdir(), 'zoko-plugin-'));
  t.after(() => rm(temporary, { recursive: true, force: true }));
  const first = await buildPlugin({ outputDirectory: join(temporary, 'first') });
  const second = await buildPlugin({ outputDirectory: join(temporary, 'second') });
  assert.equal(first.sha256, second.sha256);
  const archive = await readFile(first.archive);
  assert.equal(first.sha256, digest(archive));
  assert.equal((await readFile(`${first.archive}.sha256`, 'utf8')).split(' ')[0], first.sha256);
  const files = inspectArchive(archive);
  assert.equal(files.size, first.files);
  assert.ok(files.has('zoko/plugin.json') && files.has('zoko/.codex-plugin/plugin.json'));
  assert.ok(files.has('zoko/THIRD_PARTY_NOTICES.txt'));
  assert.match(files.get('zoko/LICENSE.txt')!.toString(), /All rights reserved/);
  assert.equal(JSON.parse(files.get('zoko/plugin.json')!.toString()).license, 'LicenseRef-Proprietary');
  for (const name of files.keys()) assert.doesNotMatch(name, /(?:node_modules|\.env|\.app\.json|mcp\.json|server\.mjs|wallet|\.map|\.pem|\.key)(?:$|\/)/);
  const integrity = JSON.parse(files.get('zoko/integrity.json')!.toString()) as { files: Array<{ path: string; bytes: number; sha256: string }>; inputs: Array<{ path: string; sha256: string }> };
  assert.equal(integrity.files.length, files.size - 1);
  for (const expected of integrity.files) {
    const bytes = files.get(`zoko/${expected.path}`);
    assert.ok(bytes, expected.path);
    assert.equal(bytes.length, expected.bytes);
    assert.equal(digest(bytes), expected.sha256, expected.path);
  }
  for (const input of integrity.inputs) {
    assert.match(input.path, /^(?:src\/(?:client|cli|protocol)\.ts|node_modules\/zod\/)/);
    assert.equal(digest(await readFile(join(project, input.path))), input.sha256);
  }
  const extract = join(temporary, 'extracted');
  for (const [name, bytes] of files) {
    const target = resolve(extract, name);
    assert.ok(target.startsWith(`${extract}${sep}`));
    await mkdir(dirname(target), { recursive: true });
    await writeFile(target, bytes);
  }
  const root = join(extract, 'zoko');
  const env = { ...process.env, NODE_PATH: '', NODE_OPTIONS: '', ZOKO_API_KEY: '', ZOKO_URL: '' };
  const help = await exec(process.execPath, [join(root, 'runtime/cli.mjs'), 'help'], { cwd: extract, env });
  assert.match(help.stdout, /quote --input/);
  assert.match(help.stdout, /execute --journal/);
  assert.match(help.stdout, /seller register/);
  assert.equal(help.stderr, '');
  const alias = join(temporary, 'plugin-alias');
  await symlink(root, alias, process.platform === 'win32' ? 'junction' : 'dir');
  for (const flags of [[], ['--preserve-symlinks-main']]) {
    const linkedHelp = await exec(process.execPath, [...flags, join(alias, 'runtime/cli.mjs'), 'help'], { cwd: extract, env });
    assert.equal(linkedHelp.stdout, help.stdout, 'CLI runs through a directory alias with either Node entrypoint resolution mode');
    assert.equal(linkedHelp.stderr, '');
  }
  const importer = join(temporary, 'import-cli.mjs');
  await writeFile(importer, `const cli = await import(${JSON.stringify(pathToFileURL(join(alias, 'runtime/cli.mjs')).href)}); console.log(typeof cli.main);\n`);
  const importedCli = await exec(process.execPath, [importer], { cwd: extract, env });
  assert.equal(importedCli.stdout.trim(), 'function', 'importing the CLI does not dispatch a command');
  assert.equal(importedCli.stderr, '');
  const projectAlias = join(temporary, 'source-alias');
  await symlink(project, projectAlias, process.platform === 'win32' ? 'junction' : 'dir');
  await assert.rejects(
    exec(process.execPath, [join(projectAlias, 'scripts/build-plugin.mjs'), 'unsupported-argument'], { cwd: temporary, env }),
    /Usage: node scripts\/build-plugin\.mjs/,
    'builder executes its argument guard through a directory alias instead of silently succeeding',
  );
  const imported = await exec(process.execPath, ['--input-type=module', '-e', `const client = await import(${JSON.stringify(pathToFileURL(join(root, 'runtime/client.mjs')).href)}); const protocol = await import(${JSON.stringify(pathToFileURL(join(root, 'runtime/protocol.mjs')).href)}); console.log(JSON.stringify({amount: client.formatXec(client.parseXec('12345678901234567890.000000001')), valid: protocol.DecisionInputSchema.safeParse({state:'observed task',questions:{answer:{type:'noul'}}}).success}));`], { cwd: extract, env });
  assert.deepEqual(JSON.parse(imported.stdout), { amount: '12345678901234567890.000000001', valid: true });
  assert.deepEqual((await readdir(root)).sort(), ['.codex-plugin', 'LICENSE.txt', 'README.md', 'THIRD_PARTY_NOTICES.txt', 'assets', 'integrity.json', 'plugin.json', 'runtime', 'skills'].sort());
});

test('emitted CLI stages a reviewed purchase and recovers its exact identity without another quote', async (t) => {
  const temporary = await mkdtemp(join(tmpdir(), 'zoko-plugin-contract-'));
  t.after(() => rm(temporary, { recursive: true, force: true }));
  const built = await buildPlugin({ outputDirectory: join(temporary, 'package') });
  const input = { state: { ticket: 'Customer reports an actual damaged parcel.' }, questions: { damage: { type: 'noul', instructions: 'Does the ticket report damage?' } } };
  const requestPath = join(temporary, 'request.json');
  const journalPath = join(temporary, 'purchase.json');
  const markerPath = `${journalPath}.attempt.json`;
  await writeFile(requestPath, JSON.stringify(input));
  const requests: Array<{ url: string; method: string; authorization?: string; key?: string; body: unknown }> = [];
  let identity = 'buyer-one';
  let journalExistedOnDispatch = false;
  let markerExistedOnDispatch = false;
  const quote = { id: 'quote-package-contract', sellerId: 'seller-one', priceNanos: '12500000', schemaHash: 'schema-hash', requestHash: 'request-hash', expiresAt: '2099-01-01T00:00:00.000Z', timeoutMs: 10000, minConfidence: 0.8 };
  const receipt = { id: 'decision-package-contract', status: 'succeeded', sellerId: quote.sellerId, priceNanos: quote.priceNanos, accepted: false, result: { model: 'seller-model-v1', answers: { damage: { type: 'noul', noul: 0.65 } }, usage: { input_tokens: 12, output_tokens: 1 } } };
  const server = createServer(async (req, res) => {
    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(Buffer.from(chunk));
    const content = Buffer.concat(chunks).toString();
    requests.push({ url: req.url!, method: req.method!, authorization: req.headers.authorization, key: req.headers['idempotency-key'] as string | undefined, body: content ? JSON.parse(content) : undefined });
    res.setHeader('Content-Type', 'application/json');
    if (req.url === '/.well-known/zoko.json') return void res.end(JSON.stringify({ protocol: 'zoko/v1', billing: { unit: 'nanoXEC' } }));
    if (req.url === '/v1/catalog') return void res.end(JSON.stringify({ sellers: [{ id: 'seller-one', priceNanos: quote.priceNanos }] }));
    if (req.url === '/v1/me') return void res.end(JSON.stringify({ account: { id: identity } }));
    if (req.url === '/v1/quotes') return void res.end(JSON.stringify(quote));
    if (req.url === '/v1/decisions') {
      journalExistedOnDispatch = (await stat(journalPath)).isFile();
      markerExistedOnDispatch = (await stat(markerPath)).isFile();
      return void res.end(JSON.stringify(receipt));
    }
    res.statusCode = 404; res.end(JSON.stringify({ error: 'Unexpected test route' }));
  });
  await new Promise<void>((done) => server.listen(0, '127.0.0.1', done));
  t.after(() => new Promise<void>((done, reject) => server.close((error) => error ? reject(error) : done())));
  const address = server.address();
  assert.ok(address && typeof address !== 'string');
  const env = { ...process.env, NODE_PATH: '', NODE_OPTIONS: '', ZOKO_URL: `http://127.0.0.1:${address.port}`, ZOKO_API_KEY: 'package-test-account-key' };
  const cli = (...args: string[]) => exec(process.execPath, [join(built.directory, 'runtime/cli.mjs'), ...args], { cwd: temporary, env });
  await cli('discover');
  await cli('catalog');
  assert.equal(requests[0]!.authorization, undefined, 'discovery never transmits a key');
  assert.equal(requests[1]!.authorization, undefined, 'catalog never transmits a key');
  const prepared = await cli('quote', '--input', requestPath, '--max-price', '0.02', '--confidence', '0.8', '--journal', journalPath, '--key', 'package-purchase-identity');
  assert.deepEqual(JSON.parse(prepared.stdout), quote);
  assert.equal(requests.filter((req) => req.url === '/v1/decisions').length, 0, 'quote cannot purchase');
  assert.equal(JSON.parse(prepared.stderr).dispatchMarker, markerPath);
  await assert.rejects(stat(markerPath), { code: 'ENOENT' }, 'quote creates no dispatch marker');
  const journalBytes = await readFile(journalPath);
  const journal = JSON.parse(journalBytes.toString());
  assert.equal(journal.accountId, 'buyer-one');
  assert.equal(journal.quoteId, quote.id);
  assert.deepEqual(journal.input, input);
  assert.ok(!journalBytes.includes(Buffer.from(env.ZOKO_API_KEY)), 'journal contains no credential');
  const executed = await cli('execute', '--journal', journalPath);
  assert.deepEqual(JSON.parse(executed.stdout), receipt);
  assert.ok(journalExistedOnDispatch, 'journal exists before dispatch');
  assert.ok(markerExistedOnDispatch, 'dispatch marker exists before dispatch');
  const markerBytes = await readFile(markerPath);
  const marker = JSON.parse(markerBytes.toString());
  assert.equal(marker.accountId, journal.accountId);
  assert.equal(marker.quoteId, journal.quoteId);
  assert.equal(marker.idempotencyKey, journal.idempotencyKey);
  assert.equal(marker.baseUrl, journal.baseUrl);
  assert.ok(!markerBytes.includes(Buffer.from(env.ZOKO_API_KEY)), 'marker contains no credential');
  const recovered = await cli('recover', '--journal', journalPath);
  assert.deepEqual(JSON.parse(recovered.stdout), receipt, 'low confidence does not trigger repurchase');
  assert.equal(requests.filter((req) => req.url === '/v1/quotes').length, 1);
  const purchases = requests.filter((req) => req.url === '/v1/decisions');
  assert.equal(purchases.length, 2);
  assert.deepEqual(purchases[0], purchases[1], 'original body, key and authorization are replayed');
  assert.equal(purchases[0]!.key, 'package-purchase-identity');
  assert.deepEqual(purchases[0]!.body, { quoteId: quote.id, ...input });
  assert.deepEqual(await readFile(journalPath), journalBytes, 'recovery preserves the original journal');
  assert.deepEqual(await readFile(markerPath), markerBytes, 'recovery preserves the original marker');
  identity = 'another-account';
  await assert.rejects(cli('recover', '--journal', journalPath), /different Zoko account/);
  assert.equal(requests.filter((req) => req.url === '/v1/decisions').length, 2, 'account mismatch cannot dispatch');
});
