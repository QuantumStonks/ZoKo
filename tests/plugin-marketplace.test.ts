import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, readdir, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { promisify } from 'node:util';

const exec = promisify(execFile);
const project = fileURLToPath(new URL('../', import.meta.url));
const hash = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex');
interface BuiltPlugin { directory: string; archive: string; sha256: string; files: number }
interface ExportResult { directory: string; version: string; archiveSha256: string; sourceCommit: string; packageMatchesCheckout: boolean; files: number; pluginFiles: number; provenanceSha256: string; marketplaceSha256: string }
interface InventoryItem { path: string; bytes: number; sha256: string }
const { buildPlugin } = await import(pathToFileURL(resolve(project, 'scripts/build-plugin.mjs')).href) as { buildPlugin: (options: { outputDirectory: string }) => Promise<BuiltPlugin> };
const { buildPluginMarketplace } = await import(pathToFileURL(resolve(project, 'scripts/build-plugin-marketplace.mjs')).href) as { buildPluginMarketplace: (options: { packageDirectory: string; outputDirectory: string }) => Promise<ExportResult> };

async function inventory(root: string, prefix = ''): Promise<Map<string, Buffer>> {
  const files = new Map<string, Buffer>();
  for (const item of await readdir(root, { withFileTypes: true })) {
    assert.equal(item.isSymbolicLink(), false);
    const path = join(root, item.name), name = `${prefix}${item.name}`;
    if (item.isDirectory()) for (const [child, bytes] of await inventory(path, `${name}/`)) files.set(child, bytes);
    else files.set(name, await readFile(path));
  }
  return new Map([...files].sort(([a], [b]) => a.localeCompare(b)));
}

test('marketplace export preserves the actual release and refuses unsafe or inconsistent sources and destinations', async (t) => {
  const temp = await mkdtemp(join(tmpdir(), 'zoko-marketplace-test-'));
  t.after(() => rm(temp, { recursive: true, force: true }));
  const built = await buildPlugin({ outputDirectory: join(temp, 'release') });
  const originalPackage = await inventory(built.directory);
  const destination = join(temp, 'export');
  const options = { packageDirectory: built.directory, outputDirectory: destination };
  const exported = await buildPluginMarketplace(options);

  await t.test('exact package bytes, hidden manifests, integrity, provenance and isolated runtime', async () => {
    assert.equal(exported.archiveSha256, built.sha256);
    assert.equal(exported.pluginFiles, built.files);
    assert.equal(exported.files, built.files + 3);
    assert.equal(exported.packageMatchesCheckout, true);
    assert.match(exported.sourceCommit, /^[a-f0-9]{40,64}$/);
    assert.deepEqual(await inventory(join(destination, 'plugins/zoko')), originalPackage);
    const catalog = JSON.parse(await readFile(join(destination, '.agents/plugins/marketplace.json'), 'utf8'));
    assert.deepEqual(catalog, { name: 'zoko', interface: { displayName: 'ZoKo' }, plugins: [{ name: 'zoko', source: { source: 'local', path: './plugins/zoko' }, policy: { installation: 'AVAILABLE', authentication: 'ON_INSTALL' }, category: 'Developer Tools' }] });
    const files = await inventory(destination);
    const provenance = JSON.parse(files.get('provenance.json')!.toString());
    assert.equal(provenance.archive.sha256, built.sha256);
    assert.equal(provenance.archive.bytes, (await readFile(built.archive)).length);
    assert.equal(provenance.sourceCommit, (await exec('git', ['rev-parse', 'HEAD'], { cwd: project })).stdout.trim());
    assert.equal(provenance.files.length, files.size - 1);
    assert.deepEqual(new Set(provenance.files.map((item: InventoryItem) => item.path)), new Set([...files.keys()].filter((name) => name !== 'provenance.json')));
    for (const item of provenance.files as InventoryItem[]) {
      assert.equal(item.bytes, files.get(item.path)!.length);
      assert.equal(item.sha256, hash(files.get(item.path)!));
    }
    assert.equal(exported.provenanceSha256, hash(files.get('provenance.json')!));
    assert.equal(exported.marketplaceSha256, hash(files.get('.agents/plugins/marketplace.json')!));
    assert.ok(files.has('plugins/zoko/.codex-plugin/plugin.json'));
    assert.ok(files.has('plugins/zoko/integrity.json'));
    assert.ok(files.has('plugins/zoko/LICENSE.txt'));
    assert.ok(files.has('plugins/zoko/THIRD_PARTY_NOTICES.txt'));
    assert.ok([...files.keys()].every((name) => !/(?:^|\/)(?:node_modules|\.env|\.git|purchases)(?:\/|$)/.test(name)));
    const unrelated = join(temp, 'unrelated');
    await mkdir(unrelated);
    const cli = await exec(process.execPath, [join(destination, 'plugins/zoko/runtime/cli.mjs'), 'help'], { cwd: unrelated });
    assert.match(cli.stdout, /Zoko — typed decisions, exact XEC accounting/);
  });

  await t.test('repeat export is deterministic and replaces only a verified earlier export', async () => {
    const before = await inventory(destination);
    assert.deepEqual(await buildPluginMarketplace(options), exported);
    assert.deepEqual(await inventory(destination), before);
    const untouched = join(temp, 'unrelated-destination');
    await mkdir(untouched);
    await writeFile(join(untouched, 'README.md'), 'user-owned data');
    await assert.rejects(buildPluginMarketplace({ ...options, outputDirectory: untouched }), /unrecognized export/);
    assert.equal(await readFile(join(untouched, 'README.md'), 'utf8'), 'user-owned data');
    await writeFile(join(destination, 'unexpected.txt'), 'preserve this');
    await assert.rejects(buildPluginMarketplace(options), /Unapproved file/);
    assert.equal(await readFile(join(destination, 'unexpected.txt'), 'utf8'), 'preserve this');
    await rm(join(destination, 'unexpected.txt'));
  });

  await t.test('runtime tampering, incomplete inventory, traversal and duplicate integrity entries fail before export', async () => {
    const runtime = join(built.directory, 'runtime/cli.mjs');
    await writeFile(runtime, 'tampered runtime');
    await assert.rejects(buildPluginMarketplace(options), /Integrity mismatch/);
    await writeFile(runtime, originalPackage.get('runtime/cli.mjs')!);
    const integrityPath = join(built.directory, 'integrity.json');
    const pristine = originalPackage.get('integrity.json')!;
    for (const change of [
      (items: InventoryItem[]) => items.pop(),
      (items: InventoryItem[]) => { items[0]!.path = '../escaped.txt'; },
      (items: InventoryItem[]) => { items[0]!.path = '/escaped.txt'; },
      (items: InventoryItem[]) => { items[0]!.path = 'C:/escaped.txt'; },
      (items: InventoryItem[]) => { items[0]!.path = items[1]!.path; },
    ]) {
      const changed = JSON.parse(pristine.toString());
      change(changed.files);
      await writeFile(integrityPath, JSON.stringify(changed));
      await assert.rejects(buildPluginMarketplace(options), /[Ii]ntegrity/);
    }
    await writeFile(integrityPath, pristine);
    assert.deepEqual(await inventory(join(destination, 'plugins/zoko')), originalPackage);
  });

  await t.test('secret files, node_modules, source symlinks and output symlinks cannot cross the export boundary', async () => {
    await writeFile(join(built.directory, '.env'), 'fixture-secret');
    await assert.rejects(buildPluginMarketplace(options), /Unsafe/);
    await rm(join(built.directory, '.env'));
    await mkdir(join(built.directory, 'node_modules'));
    await writeFile(join(built.directory, 'node_modules/leak.txt'), 'fixture-secret');
    await assert.rejects(buildPluginMarketplace(options), /Unapproved file/);
    await rm(join(built.directory, 'node_modules'), { recursive: true });
    const outside = join(temp, 'outside');
    await mkdir(outside);
    await writeFile(join(outside, 'sentinel.txt'), 'must survive');
    const sourceLink = join(built.directory, 'skills/linked');
    await symlink(outside, sourceLink, process.platform === 'win32' ? 'junction' : 'dir');
    await assert.rejects(buildPluginMarketplace(options), /symlink/);
    await rm(sourceLink);
    const outputLink = join(temp, 'output-link');
    await symlink(outside, outputLink, process.platform === 'win32' ? 'junction' : 'dir');
    await assert.rejects(buildPluginMarketplace({ ...options, outputDirectory: outputLink }), /symlink/);
    await assert.rejects(buildPluginMarketplace({ ...options, packageDirectory: outputLink }), /symlink/);
    assert.equal(await readFile(join(outside, 'sentinel.txt'), 'utf8'), 'must survive');
    for (const outputDirectory of [built.directory, dirname(built.directory), join(built.directory, 'nested')]) {
      await assert.rejects(buildPluginMarketplace({ ...options, outputDirectory }), /overlaps/);
    }
    assert.deepEqual(await inventory(built.directory), originalPackage);
  });

  await t.test('archive and sidecar must match the directory, not merely each other', async () => {
    const archive = await readFile(built.archive), sidecar = await readFile(`${built.archive}.sha256`);
    const damaged = Buffer.from(archive);
    damaged[30 + damaged.readUInt16LE(26)]! ^= 1;
    await writeFile(built.archive, damaged);
    await assert.rejects(buildPluginMarketplace(options), /SHA-256/);
    await writeFile(`${built.archive}.sha256`, `${hash(damaged)}  ${built.archive.split(/[\\/]/).at(-1)}\n`);
    await assert.rejects(buildPluginMarketplace(options));
    await writeFile(built.archive, archive);
    await writeFile(`${built.archive}.sha256`, sidecar);
    assert.deepEqual(await inventory(join(destination, 'plugins/zoko')), originalPackage);
    assert.equal((await buildPluginMarketplace(options)).archiveSha256, built.sha256);
  });
});
