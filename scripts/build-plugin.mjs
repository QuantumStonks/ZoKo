import { build, version as esbuildVersion } from 'esbuild';
import { createHash } from 'node:crypto';
import { isBuiltin } from 'node:module';
import { lstat, mkdir, mkdtemp, readFile, readdir, realpath, rename, rm, writeFile } from 'node:fs/promises';
import { dirname, isAbsolute, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { deflateRawSync } from 'node:zlib';

const project = fileURLToPath(new URL('../', import.meta.url));
const hash = (bytes) => createHash('sha256').update(bytes).digest('hex');
const json = (value) => Buffer.from(`${JSON.stringify(value, null, 2)}\n`);
const requiredSkills = ['buy-decision', 'connect-marketplace', 'sell-decisions'];
const semanticVersion = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-(?:0|[1-9]\d*|\d*[A-Za-z-][0-9A-Za-z-]*)(?:\.(?:0|[1-9]\d*|\d*[A-Za-z-][0-9A-Za-z-]*))*)?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/;
const staticFile = /^(?:plugin\.json|\.codex-plugin\/plugin\.json|README\.md|LICENSE\.txt|assets\/[a-z0-9-]+\.(?:png|svg)|skills\/[a-z0-9-]+\/(?:SKILL\.md|agents\/openai\.yaml|references\/[a-z0-9-]+\.md))$/;
const canonical = (value) => JSON.stringify(value, (_, item) => item && typeof item === 'object' && !Array.isArray(item)
  ? Object.fromEntries(Object.entries(item).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0)) : item);

function contained(root, path) {
  const rel = relative(root, path);
  if (!rel || rel === '..' || rel.startsWith(`..${sep}`) || isAbsolute(rel)) throw new Error(`Path is not a contained child: ${path}`);
  return path;
}

async function readStaticFiles(directory, prefix = '') {
  const files = new Map();
  for (const entry of (await readdir(directory, { withFileTypes: true })).sort((a, b) => a.name < b.name ? -1 : a.name > b.name ? 1 : 0)) {
    const path = resolve(directory, entry.name);
    const name = `${prefix}${entry.name}`;
    if (entry.isSymbolicLink()) throw new Error(`Plugin cannot contain a symlink: ${name}`);
    if (entry.isDirectory()) {
      for (const [child, bytes] of await readStaticFiles(path, `${name}/`)) files.set(child, bytes);
    } else {
      if (!entry.isFile() || !staticFile.test(name)) throw new Error(`Unapproved file in plugin source: ${name}`);
      const bytes = await readFile(path);
      if (bytes.byteLength > 5 * 1024 * 1024) throw new Error(`Plugin file exceeds 5 MiB: ${name}`);
      files.set(name, bytes);
    }
  }
  return files;
}

function object(value, name) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(`${name} must be an object.`);
  return value;
}

function validateManifest(files, version) {
  const portable = object(JSON.parse(files.get('plugin.json')?.toString() ?? 'null'), 'plugin.json');
  const compat = object(JSON.parse(files.get('.codex-plugin/plugin.json')?.toString() ?? 'null'), 'compatibility manifest');
  if (portable.$schema !== 'https://agent-plugins.org/schemas/1.0.0/plugin.schema.json') throw new Error('Portable plugin schema is missing.');
  if (portable.name !== 'zoko' || portable.version !== version || !semanticVersion.test(version)) throw new Error('Plugin identity/version must match package.json and strict semver.');
  if (portable.license !== 'LicenseRef-Proprietary' || !files.has('LICENSE.txt')) throw new Error('The proprietary license and notice are required.');
  const allowed = new Set(['$schema', 'name', 'version', 'description', 'author', 'homepage', 'repository', 'license', 'keywords', 'extensions']);
  for (const key of Object.keys(portable)) if (!allowed.has(key)) throw new Error(`Unsupported portable manifest field: ${key}`);
  for (const key of ['name', 'version', 'description', 'author', 'homepage', 'repository', 'license', 'keywords']) {
    if (canonical(portable[key]) !== canonical(compat[key])) throw new Error(`Manifests disagree on ${key}.`);
  }
  const openai = object(portable.extensions?.['com.openai'], 'OpenAI extension');
  if (openai.apps != null || compat.apps != null || compat.mcpServers != null) throw new Error('The skills package must not declare app or MCP dependencies.');
  const ui = object(openai.interface, 'Plugin interface');
  if (typeof portable.author?.name !== 'string' || !portable.author.name.trim()) throw new Error('A supported project author attribution is required.');
  // Legacy clients do not accept the newer supportURL or dark composer/color fields.
  const legacyInterface = Object.fromEntries(Object.entries(ui).filter(([key]) => !['supportURL', 'composerIconDark', 'brandColorDark'].includes(key)));
  if (canonical(legacyInterface) !== canonical(compat.interface)) throw new Error('Portable and compatibility presentation differ.');
  if (compat.skills !== './skills/') throw new Error('Compatibility skills path must be ./skills/.');
  for (const key of ['displayName', 'shortDescription', 'longDescription', 'developerName', 'category']) {
    if (typeof ui[key] !== 'string' || !ui[key].trim()) throw new Error(`Missing listing field ${key}.`);
  }
  if (ui.displayName.length > 30 || ui.shortDescription.length > 30 || ui.longDescription.length > 4000) throw new Error('Plugin listing exceeds field length limits.');
  const prompts = typeof ui.defaultPrompt === 'string' ? [ui.defaultPrompt] : ui.defaultPrompt;
  if (!Array.isArray(prompts) || prompts.length < 1 || prompts.length > 3 || prompts.some((p) => typeof p !== 'string' || !p.trim() || p.length > 128 || /[\r\n]/.test(p)) || new Set(prompts.map((p) => p.trim().replace(/\s+/g, ' '))).size !== prompts.length) throw new Error('Provide 1–3 short unique default prompts.');
  for (const field of ['logo', 'composerIcon', 'logoDark', 'composerIconDark']) {
    if (ui[field] === undefined && field.endsWith('Dark')) continue;
    if (typeof ui[field] !== 'string' || !/^\.\/assets\/[a-z0-9-]+\.png$/.test(ui[field])) throw new Error(`${field} must reference a contained PNG asset.`);
    const png = files.get(ui[field].slice(2));
    if (!png || png.length < 24 || !png.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))) throw new Error(`Missing or invalid PNG ${ui[field]}.`);
    const width = png.readUInt32BE(16), height = png.readUInt32BE(20);
    if (width !== height || width < (field.startsWith('logo') ? 256 : 48) || width > 4096) throw new Error(`Invalid icon dimensions: ${ui[field]}.`);
  }
  for (const field of ['websiteURL', 'supportURL', 'privacyPolicyURL', 'termsOfServiceURL']) {
    if (ui[field] === undefined) continue;
    const url = new URL(ui[field]);
    if (url.protocol !== 'https:' || url.username || url.password || ui[field].length > 1024) throw new Error(`Invalid listing URL: ${field}.`);
  }
  for (const [name, content] of files) {
    if (!name.endsWith('.md')) continue;
    const text = content.toString();
    if (text.includes('[TODO:')) throw new Error(`Unfinished placeholder in ${name}.`);
    for (const match of text.matchAll(/\]\(([^)\s]+)\)/g)) {
      const link = match[1];
      if (/^(?:https?:|#)/.test(link)) continue;
      const target = relative(project, resolve(project, dirname(name), link.split('#')[0])).split(sep).join('/');
      if (!files.has(target)) throw new Error(`Broken internal link in ${name}: ${link}`);
    }
  }
  for (const skill of requiredSkills) {
    const text = files.get(`skills/${skill}/SKILL.md`)?.toString().replace(/\r\n/g, '\n');
    if (!text || !text.startsWith(`---\nname: ${skill}\n`) || !/^description: .{40,}\n/m.test(text)) throw new Error(`Invalid skill frontmatter: ${skill}`);
    if (!files.has(`skills/${skill}/agents/openai.yaml`)) throw new Error(`Missing skill discovery metadata: ${skill}`);
  }
  return portable;
}

const crcTable = Uint32Array.from({ length: 256 }, (_, index) => {
  let value = index;
  for (let bit = 0; bit < 8; bit++) value = value & 1 ? 0xedb88320 ^ (value >>> 1) : value >>> 1;
  return value >>> 0;
});
function crc32(bytes) {
  let value = 0xffffffff;
  for (const byte of bytes) value = crcTable[(value ^ byte) & 0xff] ^ (value >>> 8);
  return (value ^ 0xffffffff) >>> 0;
}

/** A bounded, standard ZIP with fixed dates, POSIX permissions and sorted UTF-8 paths. */
function zip(files) {
  const local = [], central = [];
  let offset = 0;
  if (files.size > 65535) throw new Error('Plugin exceeds classic ZIP entry limit.');
  for (const [name, bytes] of [...files].sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0)) {
    const filename = Buffer.from(`zoko/${name}`, 'utf8');
    const compressed = deflateRawSync(bytes, { level: 9 });
    if (filename.length > 65535 || bytes.length > 0xffffffff || compressed.length > 0xffffffff) throw new Error('Plugin exceeds classic ZIP size limit.');
    const crc = crc32(bytes);
    const header = Buffer.alloc(30);
    header.writeUInt32LE(0x04034b50, 0);
    header.writeUInt16LE(20, 4); header.writeUInt16LE(0x800, 6); header.writeUInt16LE(8, 8);
    header.writeUInt16LE(33, 12); // 1980-01-01, 00:00:00
    header.writeUInt32LE(crc, 14); header.writeUInt32LE(compressed.length, 18); header.writeUInt32LE(bytes.length, 22); header.writeUInt16LE(filename.length, 26);
    local.push(header, filename, compressed);
    const entry = Buffer.alloc(46);
    entry.writeUInt32LE(0x02014b50, 0); entry.writeUInt16LE(0x0314, 4); entry.writeUInt16LE(20, 6);
    entry.writeUInt16LE(0x800, 8); entry.writeUInt16LE(8, 10); entry.writeUInt16LE(33, 14);
    entry.writeUInt32LE(crc, 16); entry.writeUInt32LE(compressed.length, 20); entry.writeUInt32LE(bytes.length, 24); entry.writeUInt16LE(filename.length, 28);
    entry.writeUInt32LE((0o100644 << 16) >>> 0, 38); entry.writeUInt32LE(offset, 42);
    central.push(entry, filename);
    offset += header.length + filename.length + compressed.length;
    if (offset > 0xffffffff) throw new Error('Plugin exceeds classic ZIP offset limit.');
  }
  const directory = Buffer.concat(central);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0); end.writeUInt16LE(files.size, 8); end.writeUInt16LE(files.size, 10);
  end.writeUInt32LE(directory.length, 12); end.writeUInt32LE(offset, 16);
  return Buffer.concat([...local, directory, end]);
}

export async function buildPlugin({ outputDirectory = resolve(project, 'dist/plugins') } = {}) {
  let output = resolve(outputDirectory);
  const source = await realpath(resolve(project, 'plugins/zoko'));
  if (output === source || relative(source, output).split(sep)[0] !== '..' && !isAbsolute(relative(source, output))) throw new Error('Build output must be outside plugin source.');
  const files = await readStaticFiles(source);
  const packageJson = JSON.parse(await readFile(resolve(project, 'package.json'), 'utf8'));
  const manifest = validateManifest(files, packageJson.version);
  const compiled = await build({
    absWorkingDir: project,
    entryPoints: { cli: 'src/cli.ts', client: 'src/client.ts', protocol: 'src/protocol.ts' },
    outdir: 'runtime', outExtension: { '.js': '.mjs' }, bundle: true, write: false,
    format: 'esm', platform: 'node', target: ['node24'], minify: true,
    sourcemap: false, legalComments: 'inline', metafile: true, logLevel: 'silent',
  });
  for (const result of Object.values(compiled.metafile.outputs)) {
    if (result.imports.some((dependency) => !dependency.external || !isBuiltin(dependency.path))) throw new Error('Plugin contains an external runtime dependency.');
  }
  const inputs = [];
  for (const input of Object.keys(compiled.metafile.inputs).sort()) {
    if (!/^src\/(?:client|cli|protocol|agent-journal|provider|security)\.ts$/.test(input) && !input.startsWith('node_modules/zod/')) throw new Error(`Unexpected runtime input: ${input}`);
    inputs.push({ path: input, sha256: hash(await readFile(resolve(project, input))) });
  }
  for (const file of compiled.outputFiles) {
    const name = relative(project, file.path).split(sep).join('/');
    if (!/^runtime\/(?:cli|client|protocol)\.mjs$/.test(name)) throw new Error(`Unexpected bundle output: ${name}`);
    files.set(name, Buffer.from(file.contents));
  }
  const zod = JSON.parse(await readFile(resolve(project, 'node_modules/zod/package.json'), 'utf8'));
  files.set('THIRD_PARTY_NOTICES.txt', Buffer.from(`This package bundles Zod ${zod.version}.\n\n${await readFile(resolve(project, 'node_modules/zod/LICENSE'), 'utf8')}\n`));
  files.set('integrity.json', json({
    format: 'zoko-plugin-integrity/1', name: manifest.name, version: manifest.version,
    runtime: 'Node.js >=24.0.0 <25', compiler: { name: 'esbuild', version: esbuildVersion }, inputs,
    files: [...files].sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0).map(([path, bytes]) => ({ path, bytes: bytes.length, sha256: hash(bytes) })),
  }));
  const archive = zip(files);
  const digest = hash(archive);
  await mkdir(output, { recursive: true });
  output = await realpath(output);
  if (output === source || relative(source, output).split(sep)[0] !== '..' && !isAbsolute(relative(source, output))) throw new Error('Resolved build output must be outside plugin source.');
  const stage = await mkdtemp(resolve(output, '.zoko-build-'));
  const destination = contained(output, resolve(output, 'zoko'));
  const archiveName = `zoko-${manifest.version}.zip`;
  const archivePath = contained(output, resolve(output, archiveName));
  let backup;
  try {
    for (const [name, bytes] of files) {
      const target = contained(stage, resolve(stage, name));
      await mkdir(dirname(target), { recursive: true });
      await writeFile(target, bytes, { mode: 0o644 });
    }
    const existing = await lstat(destination).catch((error) => { if (error.code === 'ENOENT') return null; throw error; });
    if (existing) {
      if (!existing.isDirectory() || existing.isSymbolicLink()) throw new Error('Build destination is not a regular directory.');
      const oldIntegrity = JSON.parse(await readFile(resolve(destination, 'integrity.json'), 'utf8'));
      if (oldIntegrity.format !== 'zoko-plugin-integrity/1' || oldIntegrity.name !== 'zoko') throw new Error('Refusing to replace a directory not created by this builder.');
      backup = `${stage}-previous`;
      await rename(destination, backup);
    }
    await rename(stage, destination);
    await writeFile(`${archivePath}.tmp`, archive, { mode: 0o644 });
    await rename(`${archivePath}.tmp`, archivePath);
    await writeFile(`${archivePath}.sha256`, `${digest}  ${archiveName}\n`, { mode: 0o644 });
    if (backup) await rm(contained(output, backup), { recursive: true });
  } catch (error) {
    if (backup && !(await lstat(destination).catch(() => null))) await rename(backup, destination);
    throw error;
  } finally {
    await rm(contained(output, stage), { recursive: true, force: true });
  }
  return { directory: destination, archive: archivePath, sha256: digest, files: files.size, bytes: archive.length };
}

const entryPath = process.argv[1] ? await realpath(process.argv[1]).catch(() => undefined) : undefined;
if (entryPath && entryPath === await realpath(fileURLToPath(import.meta.url))) {
  if (process.argv.length > 2) throw new Error('Usage: node scripts/build-plugin.mjs');
  process.stdout.write(`${JSON.stringify(await buildPlugin(), null, 2)}\n`);
}
