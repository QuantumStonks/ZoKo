#!/usr/bin/env node
import { execFile } from 'node:child_process';
import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

const execute = promisify(execFile);
const DEFAULT_REPOSITORY = 'QuantumStonks/ZoKo';
const API_VERSION = '2026-03-10';
const MAX_PAGES = 100;
const help = `Collect repository indicators; these are not Codex plugin adoption metrics.

Usage: node scripts/plugin-metrics.mjs [--repo OWNER/REPO] [--out FILE]
Uses the existing GitHub CLI authentication for github.com, with read-only GETs.
JSON is written to stdout. --out also saves a new receipt and never overwrites.
Exit: 0 repository read succeeded; 1 repository unavailable; 2 usage/write error.
Secondary failures remain explicit in JSON even when the exit status is zero.
`;

export function parseArguments(args) {
  const result = { repo: DEFAULT_REPOSITORY, out: undefined, help: false };
  const seen = new Set();
  for (let index = 0; index < args.length; index++) {
    const name = args[index];
    if (name === '--help' || name === '-h') { result.help = true; continue; }
    if (!['--repo', '--out'].includes(name) || seen.has(name)) throw new Error('Unknown or repeated option. Use --help.');
    seen.add(name);
    const value = args[++index];
    if (!value || value.startsWith('-') || value.includes('\0')) throw new Error('An option requires a value. Use --help.');
    if (name === '--repo') result.repo = value;
    else result.out = value;
  }
  if (!/^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})\/[A-Za-z0-9._-]{1,100}$/.test(result.repo) || /\/(?:\.|\.\.)$/.test(result.repo)) {
    throw new Error('Repository must be OWNER/REPO on github.com.');
  }
  return result;
}

function invalid() { throw new Error('Invalid metric response.'); }
function object(value) { if (!value || typeof value !== 'object' || Array.isArray(value)) invalid(); return value; }
function count(value) { if (!Number.isSafeInteger(value) || value < 0) invalid(); return value; }
function id(value) { if (count(value) === 0) invalid(); return value; }
function bool(value) { if (typeof value !== 'boolean') invalid(); return value; }
function sum(values) { return count(values.reduce((total, value) => total + value, 0)); }
function unavailable(reason, httpStatus = null) { return { status: 'unavailable', reason, httpStatus }; }

// Only normalized metrics and enumerated failure reasons enter the emitted receipt.
// Never emit child-process diagnostics, raw response bodies, headers, or credentials.
export function parseGhResponse(stdout) {
  if (typeof stdout !== 'string') invalid();
  const split = stdout.search(/\r?\n\r?\n/);
  if (split < 0) invalid();
  const header = stdout.slice(0, split);
  const status = /^HTTP\/[\d.]+\s+(\d{3})(?:\s|$)/.exec(header);
  if (!status) invalid();
  const httpStatus = Number(status[1]);
  const headers = new Map(header.split(/\r?\n/).slice(1).map(line => {
    const colon = line.indexOf(':');
    return [line.slice(0, colon).trim().toLowerCase(), line.slice(colon + 1).trim()];
  }));
  if (httpStatus < 200 || httpStatus >= 300) {
    const reason = httpStatus === 429 || (httpStatus === 403 && (headers.get('x-ratelimit-remaining') === '0' || headers.has('retry-after')))
      ? 'rate_limited' : httpStatus === 401 ? 'authentication_required' : httpStatus === 403 ? 'forbidden'
      : httpStatus === 404 ? 'not_found_or_inaccessible' : 'http_error';
    return unavailable(reason, httpStatus);
  }
  const body = stdout.slice(split).trim();
  return { status: 'available', httpStatus, data: JSON.parse(body), nextPage: /(?:^|[,;])\s*rel="?next"?(?:\s|[,;]|$)/i.test(headers.get('link') ?? '') };
}

export async function requestGh(endpoint, { signal, run = execute } = {}) {
  try {
    const { stdout } = await run('gh', [
      'api', '--hostname', 'github.com', '--method', 'GET', '--include',
      '-H', 'Accept: application/vnd.github+json', '-H', `X-GitHub-Api-Version: ${API_VERSION}`, endpoint,
    ], {
      encoding: 'utf8', timeout: 15_000, maxBuffer: 8 * 1024 * 1024,
      signal, windowsHide: true, shell: false,
      env: { ...process.env, GH_DEBUG: '', GH_PROMPT_DISABLED: '1', GH_PAGER: 'cat', PAGER: 'cat' },
    });
    return parseGhResponse(stdout);
  } catch (error) {
    // gh exits nonzero for HTTP failures while preserving --include output.
    if (typeof error?.stdout === 'string') {
      try { const response = parseGhResponse(error.stdout); if (response.status === 'unavailable') return response; } catch { /* discard all raw data */ }
    }
    if (error?.code === 'ENOENT') return unavailable('gh_unavailable');
    if (signal?.aborted || error?.code === 'ABORT_ERR' || error?.killed) return unavailable('timeout');
    if (typeof error?.stderr === 'string') {
      if (/gh auth login|GH_TOKEN environment variable|not logged into any GitHub hosts/i.test(error.stderr)) return unavailable('authentication_required');
      if (/\b(?:dial tcp|TLS handshake|network is unreachable|connection refused|could not resolve host)\b/i.test(error.stderr)) return unavailable('network_error');
    }
    return unavailable(error instanceof SyntaxError || error?.message === 'Invalid metric response.' ? 'invalid_response' : 'request_failed');
  }
}

export function normalizeRepository(value) {
  const data = object(value);
  return {
    stars: count(data.stargazers_count), forks: count(data.forks_count),
    openIssuesAndPullRequests: count(data.open_issues_count),
    archived: bool(data.archived), private: bool(data.private),
  };
}

export function normalizeOpenIssues(value) {
  const data = object(value);
  if (bool(data.incomplete_results)) throw new Error('Incomplete search.');
  return { count: count(data.total_count) };
}

export function normalizeTraffic(value, kind) {
  if (!['views', 'clones'].includes(kind)) invalid();
  const data = object(value);
  if (!Array.isArray(data[kind])) invalid();
  const seen = new Set();
  const days = data[kind].map(value => {
    const day = object(value);
    if (typeof day.timestamp !== 'string' || !/^\d{4}-\d{2}-\d{2}T00:00:00Z$/.test(day.timestamp)
      || !Number.isFinite(Date.parse(day.timestamp)) || new Date(day.timestamp).toISOString() !== day.timestamp.replace('Z', '.000Z')
      || seen.has(day.timestamp)) invalid();
    seen.add(day.timestamp);
    const result = { timestamp: day.timestamp, count: count(day.count), uniques: count(day.uniques) };
    if (result.uniques > result.count) invalid();
    return result;
  }).sort((left, right) => left.timestamp.localeCompare(right.timestamp));
  const total = count(data.count);
  const uniques = count(data.uniques);
  if (uniques > total || sum(days.map(day => day.count)) !== total) invalid();
  return { windowDays: 14, count: total, uniques, days };
}

async function pages(endpoint, request, signal) {
  const values = [];
  for (let page = 1; page <= MAX_PAGES; page++) {
    const response = await request(`${endpoint}?per_page=100&page=${page}`, { signal });
    if (response.status !== 'available') return response;
    if (!Array.isArray(response.data)) return unavailable('invalid_response', response.httpStatus);
    values.push(...response.data);
    if (!response.nextPage) return { status: 'available', httpStatus: response.httpStatus, data: values };
  }
  return unavailable('pagination_limit');
}

async function releases(base, request, signal) {
  const response = await pages(`${base}/releases`, request, signal);
  if (response.status !== 'available') return response;
  const releaseIds = new Set();
  const assetIds = new Set();
  const assets = [];
  let published = 0;
  let prereleases = 0;
  let draftsExcluded = 0;
  for (const value of response.data) {
    const release = object(value);
    const releaseId = id(release.id);
    if (releaseIds.has(releaseId)) invalid();
    releaseIds.add(releaseId);
    if (bool(release.draft)) { draftsExcluded++; continue; }
    published++;
    if (bool(release.prerelease)) prereleases++;
    // Fetch the asset endpoint explicitly so release-list embedding cannot truncate totals.
    const result = await pages(`${base}/releases/${releaseId}/assets`, request, signal);
    if (result.status !== 'available') return { ...result, failedStage: 'release_assets' };
    for (const value of result.data) {
      const asset = object(value);
      const assetId = id(asset.id);
      if (assetIds.has(assetId)) invalid();
      assetIds.add(assetId);
      assets.push({ releaseId, assetId, downloads: count(asset.download_count) });
    }
  }
  return { status: 'available', httpStatus: 200, data: {
    publishedCount: published, prereleaseCount: prereleases, draftsExcluded,
    assetCount: assets.length, assetDownloads: sum(assets.map(asset => asset.downloads)), assets,
  } };
}

export async function collectMetrics(repo = DEFAULT_REPOSITORY, { request = requestGh, now = () => new Date(), signal = AbortSignal.timeout(60_000) } = {}) {
  parseArguments(['--repo', repo]);
  const observationStartedAt = now().toISOString();
  const base = `repos/${repo}`;
  const observe = async (endpoint, operation) => {
    let result;
    try { result = await operation(); }
    catch (error) { result = unavailable(error?.message === 'Incomplete search.' ? 'incomplete_search' : 'invalid_response'); }
    if (result.status !== 'available') result = { ...result, data: null };
    return { endpoint, observedAt: now().toISOString(), ...result };
  };
  const normalized = async (endpoint, normalize) => {
    const result = await request(endpoint, { signal });
    return result.status === 'available' ? { status: 'available', httpStatus: result.httpStatus, data: normalize(result.data) } : result;
  };
  const issuesEndpoint = `search/issues?q=${encodeURIComponent(`repo:${repo} is:issue is:open`)}&per_page=1`;
  const [repository, openIssues, releaseMetrics, views, clones] = await Promise.all([
    observe(base, () => normalized(base, normalizeRepository)),
    observe(issuesEndpoint, () => normalized(issuesEndpoint, normalizeOpenIssues)),
    observe(`${base}/releases`, () => releases(base, request, signal)),
    observe(`${base}/traffic/views?per=day`, () => normalized(`${base}/traffic/views?per=day`, value => normalizeTraffic(value, 'views'))),
    observe(`${base}/traffic/clones?per=day`, () => normalized(`${base}/traffic/clones?per=day`, value => normalizeTraffic(value, 'clones'))),
  ]);
  return {
    schemaVersion: 1, repo, source: 'github-rest-via-gh', apiVersion: API_VERSION,
    observationStartedAt, observedAt: now().toISOString(),
    coverage: repository.status !== 'available' ? 'unavailable' : [openIssues, releaseMetrics, views, clones].every(value => value.status === 'available') ? 'complete' : 'partial',
    repository, openIssues, releases: releaseMetrics, traffic: { views, clones },
    pluginAdoption: {
      status: 'unavailable', reason: 'no_authoritative_adoption_source',
      installs: null, activations: null, completedTasks: null, retainedUsers: null, marketplaceRank: null,
    },
    limitations: [
      'Repository indicators include all repository activity, not only the Codex plugin.',
      'Release asset downloads are transfer counts, not unique people, installations, or active users; source archives are excluded.',
      'Traffic is the GitHub rolling 14-day window; overlapping snapshots and daily unique counts must not be summed into unique users.',
      'Traffic access failures do not mean zero traffic; forbidden can reflect token permissions or repository access.',
      'Snapshots are collected across multiple requests and are not an atomic view of GitHub.',
    ],
  };
}

export async function writeMetricsReceipt(path, json) {
  const target = resolve(path);
  await mkdir(dirname(target), { recursive: true });
  await writeFile(target, json, { flag: 'wx', mode: 0o600 });
}

export async function main(args = process.argv.slice(2)) {
  let options;
  try { options = parseArguments(args); }
  catch { process.stderr.write('Invalid metrics options. Run with --help.\n'); return 2; }
  if (options.help) { process.stdout.write(help); return 0; }
  const result = await collectMetrics(options.repo);
  const json = `${JSON.stringify(result, null, 2)}\n`;
  if (options.out) {
    try {
      await writeMetricsReceipt(options.out, json);
    } catch { process.stderr.write('Could not save metrics receipt; the path may already exist or be unwritable.\n'); return 2; }
  }
  process.stdout.write(json);
  return result.repository.status === 'available' ? 0 : 1;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().then(code => { process.exitCode = code; }).catch(() => {
    process.stderr.write('Metrics collection failed without a complete receipt. No diagnostic payload was printed.\n');
    process.exitCode = 2;
  });
}
