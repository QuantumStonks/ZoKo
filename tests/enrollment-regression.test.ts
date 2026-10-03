import assert from 'node:assert/strict';
import { build } from 'esbuild';
import { dirname, resolve } from 'node:path';
import test, { type TestContext } from 'node:test';
import { fileURLToPath } from 'node:url';

// Bundle the actual CLI with an in-memory filesystem and fetch replacement.
// No account, credential file, ACL, endpoint or process outside this fixture is used.
const target = resolve('synthetic-enrollment', 'new-parent', 'new-child', 'account.json');
const input = { name: 'Synthetic regression account', dailyLimitNanos: '0', maxPriceNanos: '0' };
const saved = { format: 'zoko-agent-credentials/1', baseUrl: 'https://market.example', apiKey: `zoko_${'A'.repeat(43)}`, enrollment: input };
const environmentKey = `zoko_${'B'.repeat(43)}`;
const directoryChain: string[] = [];
for (let path = dirname(target); ; path = dirname(path)) {
  directoryChain.push(path);
  if (dirname(path) === path) break;
}
type Cli = { main: (args: string[]) => Promise<void> };
const bundles = new Map<string, Promise<Cli>>();
function cli(platform: string): Promise<Cli> {
  if (!bundles.has(platform)) bundles.set(platform, (async () => {
    const result = await build({
      entryPoints: [fileURLToPath(new URL('../src/cli.ts', import.meta.url))],
      bundle: true, write: false, format: 'esm', platform: 'node', target: 'node24',
      define: { 'process.platform': JSON.stringify(platform), 'process.stdout.write': 'globalThis.__zokoEnrollmentRegression.output' },
      plugins: [{ name: 'synthetic-filesystem', setup(builder) {
        builder.onResolve({ filter: /^node:(fs\/promises|child_process)$/ }, args => ({ path: args.path, namespace: 'fixture' }));
        builder.onLoad({ filter: /.*/, namespace: 'fixture' }, args => ({ contents: args.path === 'node:child_process'
          ? 'export const execFileSync = () => { globalThis.__zokoEnrollmentRegression.events.push("acl"); };'
          : ['lstat', 'mkdir', 'open', 'unlink', 'realpath', 'writeFile'].map(name => `export const ${name} = (...args) => globalThis.__zokoEnrollmentRegression.${name}(...args);`).join('\n') }));
      } }],
    });
    return await import(`data:text/javascript;base64,${Buffer.from(result.outputFiles[0]!.text).toString('base64')}`) as Cli;
  })());
  return bundles.get(platform)!;
}

function fixture(t: TestContext, existing = false) {
  const events: string[] = [];
  const calls: { url: string; authorization: string | null; body: unknown }[] = [];
  let content: string | undefined = existing ? JSON.stringify(saved) + '\n' : undefined;
  let syncFailure: { path: string; code: string } | undefined;
  let openFailure: { path: string; code: string } | undefined;
  const fail = (code: string) => Object.assign(new Error(`Synthetic filesystem ${code}`), { code });
  const info = () => ({ isFile: () => true, isSymbolicLink: () => false, mode: 0o600, size: Buffer.byteLength(content ?? ''), dev: 1, ino: 1 });
  const filesystem = {
    events,
    output: (value: string) => { assert.ok(!value.includes(saved.apiKey) && !value.includes(environmentKey)); return true; },
    lstat: async () => { events.push('lstat'); if (content === undefined) throw fail('ENOENT'); return info(); },
    mkdir: async () => { events.push('mkdir'); return dirname(dirname(target)); },
    realpath: async () => { throw fail('ENOENT'); },
    writeFile: async () => { assert.fail('Unexpected non-handle write'); },
    unlink: async () => { events.push('unlink'); content = undefined; },
    open: async (path: string, flags: string) => {
      events.push(`open:${path}:${flags}`);
      if (openFailure?.path === path) throw fail(openFailure.code);
      if (path === target && flags === 'wx') { assert.equal(content, undefined); content = ''; }
      return {
        stat: async () => info(),
        readFile: async () => content,
        writeFile: async (value: string) => { events.push('write'); content = value; },
        sync: async () => { events.push(`sync:${path}`); if (syncFailure?.path === path) throw fail(syncFailure.code); },
        close: async () => { events.push(`close:${path}`); },
      };
    },
  };
  const globals = globalThis as unknown as Record<string, unknown>;
  const previousFixture = globals.__zokoEnrollmentRegression;
  globals.__zokoEnrollmentRegression = filesystem;
  const names = ['ZOKO_URL', 'ZOKO_API_KEY', 'ZOKO_CREDENTIALS_FILE'];
  const previous = names.map(name => process.env[name]);
  for (const name of names) delete process.env[name];
  t.after(() => {
    names.forEach((name, index) => { if (previous[index] === undefined) delete process.env[name]; else process.env[name] = previous[index]; });
    if (previousFixture === undefined) delete globals.__zokoEnrollmentRegression; else globals.__zokoEnrollmentRegression = previousFixture;
  });
  t.mock.method(globalThis, 'fetch', async (url: string | URL | Request, options?: RequestInit) => {
    const call = { url: String(url), authorization: new Headers(options?.headers).get('authorization'), body: options?.body ? JSON.parse(String(options.body)) as unknown : undefined };
    calls.push(call); events.push(`request:${call.url}`);
    return new Response(JSON.stringify(call.url.endsWith('/.well-known/zoko.json') ? { authentication: { enrollment: '/v1/enroll' } } : { account: { id: 'synthetic-account' } }), { headers: { 'content-type': 'application/json' } });
  });
  return { events, calls, content: () => content, failSync: (path: string, code: string) => { syncFailure = { path, code }; }, failOpen: (path: string, code: string) => { openFailure = { path, code }; }, clearFailure: () => { syncFailure = undefined; openFailure = undefined; } };
}
const enroll = ['enroll', '--credentials', target, '--name', input.name];

test('CLI rejects competing key sources before reading a file or dispatching, including equal keys', async t => {
  const f = fixture(t, true), runtime = await cli('linux');
  process.env.ZOKO_CREDENTIALS_FILE = target;
  for (const key of [environmentKey, saved.apiKey]) {
    process.env.ZOKO_API_KEY = key;
    await assert.rejects(runtime.main(['me']), error => error instanceof Error && /credential sources/i.test(error.message) && !error.message.includes(key));
  }
  assert.deepEqual(f.events, []); assert.deepEqual(f.calls, []);
});

test('CLI dispatches the origin-bound file key with absent or empty environment key and normalized URL', async t => {
  const f = fixture(t, true), runtime = await cli('linux');
  process.env.ZOKO_CREDENTIALS_FILE = target;
  await runtime.main(['me']);
  process.env.ZOKO_API_KEY = ''; process.env.ZOKO_URL = 'https://market.example/';
  await runtime.main(['me']);
  assert.equal(f.calls.length, 2);
  for (const call of f.calls) { assert.equal(call.url, 'https://market.example/v1/me'); assert.equal(call.authorization, `Bearer ${saved.apiKey}`); }
});

test('CLI refuses a saved-key origin mismatch before any request and retains environment-only compatibility', async t => {
  const f = fixture(t, true), runtime = await cli('linux');
  process.env.ZOKO_CREDENTIALS_FILE = target; process.env.ZOKO_URL = 'https://other.example';
  await assert.rejects(runtime.main(['me']), /different marketplace/);
  assert.equal(f.calls.length, 0);
  delete process.env.ZOKO_CREDENTIALS_FILE; process.env.ZOKO_API_KEY = environmentKey;
  await runtime.main(['me']);
  assert.equal(f.calls[0]?.url, 'https://other.example/v1/me');
  assert.equal(f.calls[0]?.authorization, `Bearer ${environmentKey}`);
});

for (const platform of ['linux', 'darwin']) test(`${platform}: enrollment syncs file and all containing directory entries before mock dispatch`, async t => {
  const f = fixture(t), runtime = await cli(platform);
  process.env.ZOKO_URL = saved.baseUrl;
  await runtime.main(enroll);
  const syncs = f.events.filter(event => event.startsWith('sync:'));
  assert.deepEqual(syncs, [target, ...directoryChain].map(path => `sync:${path}`));
  assert.ok(f.events.indexOf(`close:${target}`) < f.events.indexOf(`sync:${directoryChain[0]}`));
  assert.ok(f.events.indexOf(`close:${directoryChain.at(-1)}`) < f.events.findIndex(event => event.startsWith('request:')));
  assert.equal(f.calls[0]?.authorization, null);
  assert.deepEqual(f.calls[1]?.body, input);
  assert.equal(f.calls[1]?.authorization, `Bearer ${JSON.parse(f.content()!).apiKey}`);
});

for (const directory of [directoryChain[0]!, directoryChain[2]!]) test(`POSIX directory sync failure at ${directory} prevents dispatch and preserves exact retry identity`, async t => {
  const f = fixture(t), runtime = await cli('linux');
  process.env.ZOKO_URL = saved.baseUrl; f.failSync(directory, 'EIO');
  await assert.rejects(runtime.main(enroll), { code: 'EIO' });
  assert.equal(f.calls.length, 0); assert.ok(f.content());
  assert.ok(f.events.includes(`close:${directory}`)); assert.ok(!f.events.includes('unlink'));
  const original = f.content(); f.clearFailure(); f.events.length = 0;
  await runtime.main(enroll);
  assert.equal(f.content(), original); assert.ok(!f.events.includes('mkdir'));
  assert.deepEqual(f.events.filter(event => event.startsWith('sync:')), directoryChain.map(path => `sync:${path}`));
  assert.equal(f.calls[1]?.authorization, `Bearer ${JSON.parse(original!).apiKey}`);
});

test('POSIX unsupported directory sync fails closed; file sync failure removes only the never-dispatched new file', async t => {
  const f = fixture(t), runtime = await cli('linux'); process.env.ZOKO_URL = saved.baseUrl;
  f.failSync(target, 'EIO'); await assert.rejects(runtime.main(enroll), { code: 'EIO' });
  assert.equal(f.content(), undefined); assert.equal(f.calls.length, 0);
  f.failSync(directoryChain[0]!, 'EINVAL'); await assert.rejects(runtime.main(enroll), { code: 'EINVAL' });
  assert.ok(f.content()); assert.equal(f.calls.length, 0);
});

test('Windows tolerates only known unsupported directory sync errors, retains ACL checks, and rejects I/O failure', async t => {
  const f = fixture(t), runtime = await cli('win32'); process.env.ZOKO_URL = saved.baseUrl;
  for (const code of ['EINVAL', 'ENOTSUP', 'EISDIR', 'EPERM', 'EACCES']) {
    f.failSync(directoryChain[0]!, code); await runtime.main(enroll);
  }
  assert.ok(f.events.includes('acl')); assert.equal(f.calls.length, 10);
  const original = f.content(); f.failSync(directoryChain[0]!, 'EIO');
  await assert.rejects(runtime.main(enroll), { code: 'EIO' });
  assert.equal(f.calls.length, 10); assert.equal(f.content(), original);
});

test('Windows directory-open limitations permit retry while ENOENT remains fatal without replacing the saved key', async t => {
  const f = fixture(t, true), runtime = await cli('win32'); process.env.ZOKO_URL = saved.baseUrl;
  f.failOpen(directoryChain[0]!, 'EISDIR'); await runtime.main(enroll);
  assert.equal(f.calls.length, 2); assert.ok(f.events.includes('acl'));
  const original = f.content(); f.failOpen(directoryChain[0]!, 'ENOENT');
  await assert.rejects(runtime.main(enroll), { code: 'ENOENT' });
  assert.equal(f.calls.length, 2); assert.equal(f.content(), original);
  assert.ok(!f.events.includes('mkdir'));
});
