import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtemp, readFile, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

const repository = new URL(import.meta.url.includes('/dist/') ? '../../' : '../', import.meta.url);
const script = new URL('scripts/plugin-metrics.mjs', repository);
const { collectMetrics, normalizeRepository, normalizeOpenIssues, normalizeTraffic, parseArguments, parseGhResponse, requestGh, writeMetricsReceipt } = await import(script.href);
const available = (data: unknown, nextPage = false) => ({ status: 'available', httpStatus: 200, data, nextPage });
const repoData = { stargazers_count: 0, forks_count: 4, open_issues_count: 7, archived: false, private: false };
const trafficData = { count: 5, uniques: 2, views: [{ timestamp: '2026-09-28T00:00:00Z', count: 5, uniques: 2 }] };

test('metrics arguments accept only a bounded github.com repository and known non-secret options', () => {
  assert.deepEqual(parseArguments([]), { repo: 'QuantumStonks/ZoKo', out: undefined, help: false });
  assert.equal(parseArguments(['--repo', 'a/b', '--out', '.local/metrics.json']).out, '.local/metrics.json');
  for (const args of [
    ['--repo', 'https://user:secret@github.com/a/b'], ['--repo', 'a/b/../../c'],
    ['--repo', 'a/..'], ['--repo', 'a/b?token=secret'], ['--repo', '-X POST'],
    ['--repo', 'a/b', '--repo', 'c/d'], ['--token', 'secret'], ['--out'], ['a/b'],
  ]) assert.throws(() => parseArguments(args));
});

test('gh response parser preserves zero, pagination, and classified HTTP failures without raw bodies', () => {
  const parsed = parseGhResponse('HTTP/2.0 200 OK\r\nLink: <https://api.github.com/x?page=2>; rel="next", <https://api.github.com/x?page=3>; rel="last"\r\nX-Request-Id: private\r\n\r\n[0]');
  assert.deepEqual(parsed, available([0], true));
  assert.equal(parseGhResponse('HTTP/2 200\n\n{}').nextPage, false);
  for (const [headers, reason] of [
    ['HTTP/2.0 401 Unauthorized', 'authentication_required'],
    ['HTTP/2.0 403 Forbidden', 'forbidden'],
    ['HTTP/2.0 403 Forbidden\nX-RateLimit-Remaining: 0', 'rate_limited'],
    ['HTTP/2.0 403 Forbidden\nRetry-After: 60', 'rate_limited'],
    ['HTTP/2.0 404 Not Found', 'not_found_or_inaccessible'],
    ['HTTP/2.0 429 Too Many Requests', 'rate_limited'],
    ['HTTP/2.0 502 Bad Gateway', 'http_error'],
  ]) {
    const result = parseGhResponse(`${headers}\n\n{"message":"ghp_do_not_print_me"}`);
    assert.equal(result.reason, reason);
    assert.ok(!JSON.stringify(result).includes('ghp_do_not_print_me'));
  }
  assert.throws(() => parseGhResponse('debug auth=secret'));
  assert.throws(() => parseGhResponse('HTTP/2.0 200 OK\n\nnot json'));
});

test('gh runner always uses GET without a shell and suppresses debug and diagnostic payloads', async () => {
  let executed = false;
  const result = await requestGh('repos/a/b', { run: async (command: string, args: string[], options: Record<string, any>) => {
    executed = true;
    assert.equal(command, 'gh');
    assert.ok(args.includes('GET'));
    assert.ok(args.includes('github.com'));
    assert.ok(!args.some(value => value.includes('Authorization')));
    assert.equal(options.shell, false);
    assert.equal(options.env.GH_DEBUG, '');
    assert.equal(options.env.GH_PROMPT_DISABLED, '1');
    assert.equal(options.timeout, 15_000);
    return { stdout: 'HTTP/2.0 200 OK\n\n{"count":0}' };
  } });
  assert.equal(executed, true);
  assert.deepEqual(result, available({ count: 0 }));
  const failures = [
    { code: 'ENOENT', reason: 'gh_unavailable' },
    { code: 'ABORT_ERR', reason: 'timeout' },
    { killed: true, reason: 'timeout' },
    { stderr: 'gh auth login secret', reason: 'authentication_required' },
    { stderr: 'dial tcp secret', reason: 'network_error' },
    { stderr: 'Authorization: Bearer ghp_secret', reason: 'request_failed' },
    { stdout: 'HTTP/2.0 403 Forbidden\n\n{"token":"ghp_secret"}', reason: 'forbidden' },
  ];
  for (const { reason, ...failure } of failures) {
    const result = await requestGh('repos/a/b', { run: async () => { throw Object.assign(new Error('ghp_secret'), failure); } });
    assert.equal(result.reason, reason);
    assert.doesNotMatch(JSON.stringify(result), /secret|Bearer|Authorization/);
  }
});

test('normalization rejects missing, negative, fractional and unsafe counts instead of inventing zero', () => {
  assert.deepEqual(normalizeRepository(repoData), { stars: 0, forks: 4, openIssuesAndPullRequests: 7, archived: false, private: false });
  for (const value of [undefined, null, '0', -1, 1.5, Number.MAX_SAFE_INTEGER + 1]) {
    assert.throws(() => normalizeRepository({ ...repoData, stargazers_count: value }));
  }
  assert.deepEqual(normalizeOpenIssues({ total_count: 0, incomplete_results: false }), { count: 0 });
  assert.throws(() => normalizeOpenIssues({ total_count: 0, incomplete_results: true }));
  assert.throws(() => normalizeOpenIssues({ total_count: 0 }));
});

test('traffic normalization preserves distinct window uniques and validates daily evidence', () => {
  assert.deepEqual(normalizeTraffic(trafficData, 'views'), { windowDays: 14, count: 5, uniques: 2, days: trafficData.views });
  const repeatedVisitor = { count: 10, uniques: 2, clones: [
    { timestamp: '2026-09-28T00:00:00Z', count: 5, uniques: 2 },
    { timestamp: '2026-09-29T00:00:00Z', count: 5, uniques: 2 },
  ] };
  assert.equal(normalizeTraffic(repeatedVisitor, 'clones').uniques, 2);
  assert.deepEqual(normalizeTraffic({ count: 0, uniques: 0, views: [] }, 'views').days, []);
  for (const data of [
    { ...trafficData, views: undefined }, { ...trafficData, count: 6 }, { ...trafficData, uniques: 6 },
    { ...trafficData, views: [{ ...trafficData.views[0], timestamp: '2026-02-30T00:00:00Z' }] },
    { ...trafficData, count: 10, views: [trafficData.views[0], trafficData.views[0]] },
  ]) assert.throws(() => normalizeTraffic(data, 'views'));
});

test('collector paginates releases and assets, excludes drafts, and leaves plugin adoption unmeasured', async () => {
  const calls: string[] = [];
  const responses: Record<string, unknown> = {
    'repos/a/b': available(repoData),
    'search/issues?q=repo%3Aa%2Fb%20is%3Aissue%20is%3Aopen&per_page=1': available({ total_count: 3, incomplete_results: false }),
    'repos/a/b/releases?per_page=100&page=1': available([{ id: 1, draft: false, prerelease: false }], true),
    'repos/a/b/releases?per_page=100&page=2': available([{ id: 2, draft: true }, { id: 3, draft: false, prerelease: true }]),
    'repos/a/b/releases/1/assets?per_page=100&page=1': available([{ id: 10, download_count: 0, name: 'do-not-export-secret' }], true),
    'repos/a/b/releases/1/assets?per_page=100&page=2': available([{ id: 11, download_count: 4 }]),
    'repos/a/b/releases/3/assets?per_page=100&page=1': available([{ id: 12, download_count: 5 }]),
    'repos/a/b/traffic/views?per=day': available(trafficData),
    'repos/a/b/traffic/clones?per=day': available({ count: 0, uniques: 0, clones: [] }),
  };
  const result = await collectMetrics('a/b', { now: () => new Date('2026-09-29T12:00:00Z'), request: async (endpoint: string) => {
    calls.push(endpoint);
    assert.ok(endpoint in responses, endpoint);
    return responses[endpoint];
  } });
  assert.equal(result.coverage, 'complete');
  assert.equal(result.observedAt, '2026-09-29T12:00:00.000Z');
  assert.equal(result.repository.data.openIssuesAndPullRequests, 7);
  assert.equal(result.openIssues.data.count, 3);
  assert.deepEqual(result.releases.data, {
    publishedCount: 2, prereleaseCount: 1, draftsExcluded: 1, assetCount: 3, assetDownloads: 9,
    assets: [{ releaseId: 1, assetId: 10, downloads: 0 }, { releaseId: 1, assetId: 11, downloads: 4 }, { releaseId: 3, assetId: 12, downloads: 5 }],
  });
  assert.equal(calls.length, 9);
  assert.equal(result.pluginAdoption.installs, null);
  assert.equal(result.pluginAdoption.marketplaceRank, null);
  assert.ok(!JSON.stringify(result).includes('do-not-export-secret'));
});

test('partial or inaccessible sources never become zero-valued evidence', async () => {
  const request = async (endpoint: string) => {
    if (endpoint === 'repos/a/b') return available(repoData);
    if (endpoint.includes('search/issues')) return available({ total_count: 2, incomplete_results: true });
    if (endpoint.includes('/releases?')) return available([{ id: 1, draft: false, prerelease: false }]);
    return { status: 'unavailable', reason: 'forbidden', httpStatus: 403 };
  };
  const result = await collectMetrics('a/b', { request });
  assert.equal(result.coverage, 'partial');
  assert.equal(result.openIssues.reason, 'incomplete_search');
  assert.equal(result.openIssues.data, null);
  assert.equal(result.releases.data, null);
  assert.equal(result.releases.failedStage, 'release_assets');
  assert.equal(result.traffic.views.data, null);
  assert.equal(result.traffic.views.reason, 'forbidden');
  const failed = await collectMetrics('a/b', { request: async () => ({ status: 'unavailable', reason: 'gh_unavailable', httpStatus: null }) });
  assert.equal(failed.coverage, 'unavailable');
  assert.equal(failed.repository.data, null);
});

test('pagination is bounded and overlapping release observations are rejected', async () => {
  let pageCount = 0;
  const limited = await collectMetrics('a/b', { request: async (endpoint: string) => {
    if (endpoint.includes('/releases?')) { pageCount++; return available([], true); }
    return { status: 'unavailable', reason: 'forbidden', httpStatus: 403 };
  } });
  assert.equal(pageCount, 100);
  assert.equal(limited.releases.reason, 'pagination_limit');
  assert.equal(limited.releases.data, null);
  const duplicate = await collectMetrics('a/b', { request: async (endpoint: string) => {
    if (endpoint.includes('/releases?')) return available([{ id: 1, draft: true }, { id: 1, draft: true }]);
    return { status: 'unavailable', reason: 'forbidden', httpStatus: 403 };
  } });
  assert.equal(duplicate.releases.reason, 'invalid_response');
});

test('saved receipts create parent directories and refuse to overwrite previous evidence', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'zoko-metrics-'));
  try {
    const path = join(directory, 'nested', 'receipt.json');
    const content = '{"observedAt":"2026-09-29T12:00:00.000Z"}\n';
    await writeMetricsReceipt(path, content);
    assert.equal(await readFile(path, 'utf8'), content);
    if (process.platform !== 'win32') assert.equal((await stat(path)).mode & 0o777, 0o600);
    await assert.rejects(writeMetricsReceipt(path, '{"replacement":true}\n'));
    assert.equal(await readFile(path, 'utf8'), content);
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test('CLI help and argument failures do not invoke API collection or echo supplied credentials', () => {
  const invoke = (...args: string[]) => spawnSync(process.execPath, [fileURLToPath(script), ...args], { encoding: 'utf8', timeout: 10_000 });
  const help = invoke('--help');
  assert.equal(help.status, 0);
  assert.match(help.stdout, /not Codex plugin adoption metrics/);
  const invalid = invoke('--token', 'ghp_secret_should_never_appear');
  assert.equal(invalid.status, 2);
  assert.doesNotMatch(invalid.stdout + invalid.stderr, /ghp_secret_should_never_appear/);
});
