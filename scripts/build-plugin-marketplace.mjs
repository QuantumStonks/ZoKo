import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { lstat, mkdir, mkdtemp, readFile, readdir, realpath, rename, rm, writeFile } from 'node:fs/promises';
import { dirname, isAbsolute, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { crc32, inflateRawSync } from 'node:zlib';

const project = fileURLToPath(new URL('../', import.meta.url));
const exec = promisify(execFile);
const hash = (bytes) => createHash('sha256').update(bytes).digest('hex');
const json = (value) => Buffer.from(`${JSON.stringify(value, null, 2)}\n`);
const format = 'zoko-plugin-marketplace/1';
const maxFile = 5 * 1024 * 1024, maxTotal = 40 * 1024 * 1024, maxFiles = 128;
const staticFile = /^(?:plugin\.json|\.codex-plugin\/plugin\.json|README\.md|LICENSE\.txt|assets\/[a-z0-9-]+\.(?:png|svg)|skills\/[a-z0-9-]+\/(?:SKILL\.md|agents\/openai\.yaml|references\/[a-z0-9-]+\.md))$/;
const packageFile = (name) => staticFile.test(name) || /^(?:integrity\.json|THIRD_PARTY_NOTICES\.txt|runtime\/(?:cli|client|protocol)\.mjs)$/.test(name);
const safeName = (name) => typeof name === 'string' && name.length <= 240 && name.split('/').every((part) => /^(?:[A-Za-z0-9_][A-Za-z0-9_.-]*|\.(?:agents|codex-plugin))$/.test(part));
const within = (root, path) => { const rel = relative(root, path); return !rel || rel !== '..' && !rel.startsWith(`..${sep}`) && !isAbsolute(rel); };
const exists = (path) => lstat(path).catch((error) => { if (error.code === 'ENOENT') return null; throw error; });

async function regularFile(path, limit = maxFile) {
  const info = await lstat(path);
  if (!info.isFile() || info.isSymbolicLink() || info.size > limit) throw new Error(`Expected a bounded regular file: ${path}`);
  const bytes = await readFile(path);
  if (bytes.length > limit) throw new Error(`File exceeds limit: ${path}`);
  return bytes;
}

async function readTree(root, allowed) {
  const info = await lstat(root);
  if (!info.isDirectory() || info.isSymbolicLink()) throw new Error('Tree root must be a regular directory, not a symlink.');
  const files = new Map();
  let total = 0, directories = 0;
  async function visit(directory, prefix = '') {
    if (++directories > maxFiles) throw new Error('Directory count exceeds limit.');
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const name = `${prefix}${entry.name}`;
      if (!safeName(name) || entry.isSymbolicLink()) throw new Error(`Unsafe or symlink path: ${name}`);
      const path = resolve(directory, entry.name);
      if (entry.isDirectory()) await visit(path, `${name}/`);
      else {
        if (!allowed(name)) throw new Error(`Unapproved file: ${name}`);
        const bytes = await regularFile(path);
        total += bytes.length;
        if (total > maxTotal || files.size >= maxFiles) throw new Error('Package size exceeds limit.');
        files.set(name, bytes);
      }
    }
  }
  await visit(root);
  return new Map([...files].sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0));
}

function verifyInventory(files, inventory, excluded) {
  if (!Array.isArray(inventory) || inventory.length !== files.size - 1) throw new Error('Integrity inventory does not cover every file.');
  const seen = new Set([excluded]);
  for (const item of inventory) {
    if (!item || !safeName(item.path) || seen.has(item.path)) throw new Error('Unsafe or duplicate integrity path.');
    seen.add(item.path);
    const bytes = files.get(item.path);
    if (!bytes || item.bytes !== bytes.length || item.sha256 !== hash(bytes)) throw new Error(`Integrity mismatch: ${item.path}`);
  }
  if (!files.has(excluded)) throw new Error(`Missing ${excluded}.`);
}

/** Accept only the bounded, single-disk ZIP emitted by build-plugin.mjs. Never extract unverified paths. */
function verifyArchive(archive, files) {
  const end = archive.length - 22;
  if (end < 0 || archive.readUInt32LE(end) !== 0x06054b50 || archive.readUInt16LE(end + 4) !== 0 || archive.readUInt16LE(end + 6) !== 0 || archive.readUInt16LE(end + 20) !== 0) throw new Error('Unsupported ZIP end record.');
  const count = archive.readUInt16LE(end + 10), start = archive.readUInt32LE(end + 16);
  if (count !== files.size || archive.readUInt16LE(end + 8) !== count || start + archive.readUInt32LE(end + 12) !== end) throw new Error('ZIP inventory or directory size mismatch.');
  let cursor = start, local = 0;
  const seen = new Set();
  for (let index = 0; index < count; index++) {
    if (cursor + 46 > end || archive.readUInt32LE(cursor) !== 0x02014b50) throw new Error('Invalid ZIP directory entry.');
    const compressed = archive.readUInt32LE(cursor + 20), size = archive.readUInt32LE(cursor + 24), length = archive.readUInt16LE(cursor + 28);
    const name = archive.subarray(cursor + 46, cursor + 46 + length).toString('utf8');
    const path = name.startsWith('zoko/') ? name.slice(5) : '';
    if (cursor + 46 + length > end || !safeName(path) || seen.has(path) || !files.has(path) || size > maxFile || archive.readUInt16LE(cursor + 8) !== 0x800 || archive.readUInt16LE(cursor + 10) !== 8 || archive.readUInt16LE(cursor + 30) !== 0 || archive.readUInt16LE(cursor + 32) !== 0 || archive.readUInt16LE(cursor + 34) !== 0 || archive.readUInt32LE(cursor + 38) !== ((0o100644 << 16) >>> 0) || archive.readUInt32LE(cursor + 42) !== local) throw new Error('Unsafe or unsupported ZIP entry.');
    seen.add(path);
    const dataStart = local + 30 + length, dataEnd = dataStart + compressed;
    if (dataEnd > start || local + 30 > start || archive.readUInt32LE(local) !== 0x04034b50 || archive.readUInt16LE(local + 6) !== 0x800 || archive.readUInt16LE(local + 8) !== 8 || archive.readUInt32LE(local + 14) !== archive.readUInt32LE(cursor + 16) || archive.readUInt32LE(local + 18) !== compressed || archive.readUInt32LE(local + 22) !== size || archive.readUInt16LE(local + 26) !== length || archive.readUInt16LE(local + 28) !== 0 || archive.subarray(local + 30, dataStart).toString('utf8') !== name) throw new Error('ZIP local record mismatch.');
    const bytes = inflateRawSync(archive.subarray(dataStart, dataEnd), { maxOutputLength: maxFile });
    if (bytes.length !== size || crc32(bytes) !== archive.readUInt32LE(cursor + 16) || !bytes.equals(files.get(path))) throw new Error(`ZIP content mismatch: ${path}`);
    local = dataEnd;
    cursor += 46 + length;
  }
  if (local !== start || cursor !== end) throw new Error('Unexpected bytes in ZIP.');
}

async function sourceProvenance(files, integrity) {
  for (const [name, bytes] of files) {
    if (staticFile.test(name) && !bytes.equals(await regularFile(resolve(project, 'plugins/zoko', name)))) throw new Error(`Built plugin differs from source: ${name}`);
  }
  if (!Array.isArray(integrity.inputs) || !integrity.inputs.length) throw new Error('Missing runtime input provenance.');
  const paths = new Set();
  for (const input of integrity.inputs) {
    if (!input || !safeName(input.path) || !/^(?:src\/(?:cli|client|protocol|agent-journal|provider|security)\.ts|node_modules\/zod\/.+)$/.test(input.path) || paths.has(input.path)) throw new Error('Invalid runtime input provenance.');
    paths.add(input.path);
    if (hash(await regularFile(resolve(project, input.path))) !== input.sha256) throw new Error(`Built runtime input differs from checkout: ${input.path}`);
  }
  for (const file of ['src/cli.ts', 'src/client.ts', 'src/protocol.ts']) if (!paths.has(file)) throw new Error(`Missing runtime input: ${file}`);
  const { stdout } = await exec('git', ['rev-parse', '--verify', 'HEAD'], { cwd: project });
  const sourceCommit = stdout.trim();
  if (!/^[0-9a-f]{40,64}$/.test(sourceCommit)) throw new Error('Cannot establish checkout commit.');
  const status = await exec('git', ['status', '--porcelain', '--untracked-files=all', '--', 'plugins/zoko', ...[...paths].filter(path => path.startsWith('src/')), 'scripts/build-plugin.mjs', 'scripts/build-plugin-marketplace.mjs', 'package.json', 'package-lock.json'], { cwd: project });
  return { sourceCommit, packageSourcesClean: status.stdout.trim() === '', packageMatchesCheckout: true };
}

async function canonicalDestination(path) {
  const info = await exists(path);
  if (info) {
    if (!info.isDirectory() || info.isSymbolicLink()) throw new Error('Export destination must be a regular directory, not a symlink.');
    return realpath(path);
  }
  const parent = dirname(path);
  if (parent === path) throw new Error('Cannot resolve export destination.');
  return resolve(await canonicalDestination(parent), path.slice(parent.length + (parent.endsWith(sep) ? 0 : 1)));
}

const installationReadme = (version) => Buffer.from([
  '# ZoKo marketplace export', '',
  `ZoKo version ${version}. You may download, install, and execute unmodified official plugin releases for your authorized work under plugins/zoko/LICENSE.txt, without requesting individual permission. Modification, redistribution, sublicensing, and sale rights remain reserved. Marketplace charges and service terms apply separately. Generating this directory does not publish it or establish global directory approval.`, '',
  'Use Node.js 24. Check that your Codex CLI exposes the documented commands with `codex plugin --help` and `codex plugin marketplace add --help`. Older CLI builds may not support plugin add/list or --json.', '',
  'Install from this directory:', '',
  '```sh', 'codex plugin marketplace add . --json', 'codex plugin add zoko@zoko --json', 'codex plugin list --available --json', '```', '',
  "The chosen official Git distribution ref is `codex/zoko-marketplace`. After that ref is published with this complete directory at its root, verify provenance and register it with `codex plugin marketplace add QuantumStonks/ZoKo --ref codex/zoko-marketplace --json` before adding zoko@zoko. Retain hidden directories when publishing. The development branch's raw plugins/zoko directory does not contain the bundled runtime.", '',
  'Inspect provenance.json for archive SHA-256, source commit, source cleanliness and every exported file hash. The plugin still requires a user-selected ZoKo marketplace and account. Installation does not provide a marketplace, funds or sellers.', '',
].join('\n'));

export async function buildPluginMarketplace({ packageDirectory = resolve(project, 'dist/plugins/zoko'), outputDirectory = resolve(project, 'dist/plugin-marketplace') } = {}) {
  const files = await readTree(resolve(packageDirectory), packageFile);
  const source = await realpath(packageDirectory);
  const integrity = JSON.parse(files.get('integrity.json')?.toString() ?? 'null');
  const manifest = JSON.parse(files.get('plugin.json')?.toString() ?? 'null');
  const compatibility = JSON.parse(files.get('.codex-plugin/plugin.json')?.toString() ?? 'null');
  const packageJson = JSON.parse(await readFile(resolve(project, 'package.json'), 'utf8'));
  if (integrity?.format !== 'zoko-plugin-integrity/1' || integrity.name !== 'zoko' || integrity.version !== packageJson.version || manifest?.name !== 'zoko' || manifest.version !== integrity.version || compatibility?.name !== 'zoko' || compatibility.version !== integrity.version) throw new Error('Plugin identity/version mismatch.');
  verifyInventory(files, integrity.files, 'integrity.json');
  for (const name of ['runtime/cli.mjs', 'runtime/client.mjs', 'runtime/protocol.mjs', 'LICENSE.txt', 'THIRD_PARTY_NOTICES.txt']) if (!files.has(name)) throw new Error(`Incomplete built plugin: ${name}`);
  const archiveName = `zoko-${manifest.version}.zip`, archivePath = resolve(dirname(source), archiveName);
  const archive = await regularFile(archivePath, maxTotal), archiveSha256 = hash(archive);
  if ((await regularFile(`${archivePath}.sha256`)).toString().trim() !== `${archiveSha256}  ${archiveName}`) throw new Error('Archive SHA-256 sidecar mismatch.');
  verifyArchive(archive, files);
  const provenance = await sourceProvenance(files, integrity);
  const output = await canonicalDestination(resolve(outputDirectory));
  for (const protectedPath of [source, await realpath(resolve(project, 'plugins/zoko')), dirname(source)]) {
    if (within(protectedPath, output) || within(output, protectedPath)) throw new Error('Export destination overlaps package or plugin source.');
  }
  const exported = new Map([...files].map(([name, bytes]) => [`plugins/zoko/${name}`, bytes]));
  exported.set('.agents/plugins/marketplace.json', json({ name: 'zoko', interface: { displayName: 'ZoKo' }, plugins: [{ name: 'zoko', source: { source: 'local', path: './plugins/zoko' }, policy: { installation: 'AVAILABLE', authentication: 'ON_INSTALL' }, category: 'Developer Tools' }] }));
  exported.set('README.md', installationReadme(manifest.version));
  const inventory = [...exported].sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0).map(([path, bytes]) => ({ path, bytes: bytes.length, sha256: hash(bytes) }));
  exported.set('provenance.json', json({ format, name: 'zoko', version: manifest.version, archive: { name: archiveName, bytes: archive.length, sha256: archiveSha256 }, ...provenance, files: inventory }));
  const parent = dirname(output);
  await mkdir(parent, { recursive: true });
  const stage = await mkdtemp(resolve(parent, '.zoko-marketplace-'));
  let backup;
  try {
    for (const [name, bytes] of exported) {
      const target = resolve(stage, name);
      await mkdir(dirname(target), { recursive: true });
      await writeFile(target, bytes, { mode: 0o644, flag: 'wx' });
    }
    if (await exists(output)) {
      const oldFiles = await readTree(output, (name) => name === 'provenance.json' || name === 'README.md' || name === '.agents/plugins/marketplace.json' || name.startsWith('plugins/zoko/') && packageFile(name.slice(13)));
      const old = JSON.parse(oldFiles.get('provenance.json')?.toString() ?? 'null');
      if (old?.format !== format || old.name !== 'zoko') throw new Error('Refusing to replace an unrecognized export.');
      verifyInventory(oldFiles, old.files, 'provenance.json');
      backup = `${stage}-previous`;
      await rename(output, backup);
    }
    await rename(stage, output);
    if (backup) await rm(backup, { recursive: true });
  } catch (error) {
    if (backup && !(await exists(output))) await rename(backup, output);
    throw error;
  } finally {
    await rm(stage, { recursive: true, force: true });
  }
  return { directory: output, version: manifest.version, archiveSha256, ...provenance, pluginFiles: files.size, files: exported.size, provenanceSha256: hash(exported.get('provenance.json')), marketplaceSha256: hash(exported.get('.agents/plugins/marketplace.json')) };
}

const entryPath = process.argv[1] ? await realpath(process.argv[1]).catch(() => undefined) : undefined;
if (entryPath && entryPath === await realpath(fileURLToPath(import.meta.url))) {
  if (process.argv.length > 2) throw new Error('Usage: node scripts/build-plugin-marketplace.mjs');
  process.stdout.write(`${JSON.stringify(await buildPluginMarketplace(), null, 2)}\n`);
}
