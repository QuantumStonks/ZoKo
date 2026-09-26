#!/usr/bin/env node
import { randomBytes, randomUUID } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { AmbiguousDecisionError, ZokoApiError, ZokoClient, parseXec, type PurchasePolicy } from './client.js';
import { DecisionInputSchema } from './protocol.js';

const help = `Zoko — typed decisions, exact XEC accounting

Environment:
  ZOKO_URL       HTTPS server URL (default http://127.0.0.1:3000)
  ZOKO_API_KEY   Buyer API key; use the operator token for admin commands.
                Credentials are read from the environment, never CLI arguments.

Commands:
  keygen [--out FILE]                         Generate operator + encryption environment keys
  doctor                                     Inspect public live and ready probes
  catalog | me | history [--limit 1..100]      Read the market or your account
  quote --input FILE --max-price XEC          Get a bound quote; does not purchase
  decide --input FILE --max-price XEC         Quote once, then purchase and poll
         [--latency-ms N] [--confidence 0..1] [--sellers ID,ID]
         [--key IDEMPOTENCY_KEY] [--journal FILE]
  execute --input FILE --quote ID --key KEY   Resume the exact original purchase
  recover --journal FILE                     Resume from an existing purchase journal
  account create --name NAME --daily-limit XEC --max-price XEC
         [--sellers ID,ID]                    Issue an account key (operator)
  seller add --input FILE                     Register a provider (operator)
  api METHOD /v1/PATH [--input FILE] [--key KEY]
                                             Explicit API call; no automatic retries
  help                                       Show this message

Decision files contain {"state":...,"questions":...}. Money accepts exact XEC
decimal strings with at most nine decimal places; all API amounts are nanoXEC.
--journal writes the original payload, quote and key BEFORE purchasing, mode
0600, and refuses to overwrite existing files. Keep it until the outcome is
known. recover uses that same payload and key and never obtains a new quote.
Only schema-valid terminal purchases are billed under the server contract.
Self-reported confidence is not a measured probability of correctness.

Examples:
  npm run cli -- keygen --out operator-secret.txt
  npm run cli -- catalog
  npm run cli -- decide --input decision.json --max-price 0.25 --journal purchase.json
  npm run cli -- recover --journal purchase.json
  npm run cli -- api POST /v1/deposit-address
  npm run cli -- api POST /v1/withdrawals --input withdrawal.json --key withdrawal-20260927-01
`;

type Flags = Record<string, string>;
function parseArgs(args: string[]): { words: string[]; flags: Flags } {
  const words: string[] = [];
  const flags: Flags = {};
  for (let index = 0; index < args.length; index++) {
    const arg = args[index]!;
    if (!arg.startsWith('--')) { words.push(arg); continue; }
    const equals = arg.indexOf('=');
    const name = arg.slice(2, equals < 0 ? undefined : equals);
    if (name === 'help') { flags.help = 'true'; continue; }
    const value = equals < 0 ? args[++index] : arg.slice(equals + 1);
    if (!name || !value || value.startsWith('--')) throw new Error(`--${name} requires a value.`);
    if (name in flags) throw new Error(`--${name} was specified twice.`);
    flags[name] = value;
  }
  return { words, flags };
}
function allowedFlags(flags: Flags, allowed: string[]): void {
  for (const key of Object.keys(flags)) if (!allowed.includes(key)) throw new Error(`Unknown option --${key}. Run help for supported options.`);
}
function requireFlag(flags: Flags, name: string): string {
  const value = flags[name];
  if (!value) throw new Error(`--${name} is required.`);
  return value;
}
function numberFlag(flags: Flags, name: string, minimum: number, maximum: number, integer = false): number | undefined {
  const raw = flags[name];
  if (raw === undefined) return undefined;
  if (!/^(?:\d+)(?:\.\d+)?$/.test(raw)) throw new Error(`--${name} must be a number.`);
  const number = Number(raw);
  if (!Number.isFinite(number) || number < minimum || number > maximum || (integer && !Number.isInteger(number))) throw new Error(`--${name} must be ${integer ? 'an integer ' : ''}between ${minimum} and ${maximum}.`);
  return number;
}
async function jsonFile(path: string, maxBytes = 65_536): Promise<unknown> {
  const content = await readFile(path);
  if (content.byteLength > maxBytes) throw new Error(`Input exceeds ${maxBytes} bytes.`);
  try { return JSON.parse(content.toString('utf8')) as unknown; } catch { throw new Error('Input file must contain valid JSON.'); }
}
function output(value: unknown): void { process.stdout.write(`${JSON.stringify(value, null, 2)}\n`); }
function purchasePolicy(flags: Flags): PurchasePolicy {
  const policy: PurchasePolicy = { maxPriceNanos: parseXec(requireFlag(flags, 'max-price')) };
  const latency = numberFlag(flags, 'latency-ms', 1, 120_000, true);
  const confidence = numberFlag(flags, 'confidence', 0, 1);
  if (latency !== undefined) policy.maxLatencyMs = latency;
  if (confidence !== undefined) policy.minConfidence = confidence;
  if (flags.sellers) policy.allowedSellers = flags.sellers.split(',').map((s) => s.trim()).filter(Boolean);
  return policy;
}
async function doctor(baseUrl: string): Promise<void> {
  const parsed = new URL(baseUrl);
  const local = ['localhost', '127.0.0.1', '[::1]'].includes(parsed.hostname);
  if (parsed.username || parsed.password || parsed.hash || parsed.search || (parsed.protocol !== 'https:' && !(parsed.protocol === 'http:' && local))) throw new Error('Use a credential-free HTTPS URL, or localhost HTTP.');
  const result = await Promise.all(['/health/live', '/health/ready'].map(async (path) => {
    try {
      const response = await fetch(`${baseUrl.replace(/\/$/, '')}${path}`, { signal: AbortSignal.timeout(15_000), redirect: 'error' });
      const data: unknown = await response.json();
      return { path, ok: response.ok, status: response.status, data };
    } catch (error) { return { path, ok: false, error: error instanceof Error ? error.message : 'Connection failed' }; }
  }));
  output({ baseUrl, probes: result });
  if (result.some((item) => !item.ok)) process.exitCode = 1;
}

export async function main(args = process.argv.slice(2)): Promise<void> {
  const { words, flags } = parseArgs(args);
  const command = words[0] ?? 'help';
  if (command === 'help' || flags.help) { process.stdout.write(help); return; }
  if (command === 'keygen') {
    allowedFlags(flags, ['out']);
    if (words.length !== 1) throw new Error('keygen takes no positional arguments.');
    const secret = `ZOKO_ADMIN_TOKEN=${randomBytes(32).toString('base64url')}\nZOKO_ENCRYPTION_KEY=${randomBytes(32).toString('base64')}\n`;
    if (flags.out) {
      await writeFile(flags.out, secret, { flag: 'wx', mode: 0o600 });
      output({ saved: resolve(flags.out) });
    } else process.stdout.write(secret);
    return;
  }
  const baseUrl = process.env.ZOKO_URL ?? 'http://127.0.0.1:3000';
  if (command === 'doctor') { allowedFlags(flags, []); await doctor(baseUrl); return; }
  const apiKey = process.env.ZOKO_API_KEY;
  if (!apiKey && command !== 'catalog') throw new Error('Set ZOKO_API_KEY in the environment. Use the operator token for admin endpoints.');
  const client = new ZokoClient({ baseUrl, apiKey: apiKey ?? 'public-catalog' });
  if (command === 'catalog' || command === 'me' || command === 'history') {
    allowedFlags(flags, command === 'history' ? ['limit'] : []);
    if (words.length !== 1) throw new Error(`${command} takes no positional arguments.`);
    output(command === 'catalog' ? await client.catalog() : command === 'me' ? await client.me() : await client.history(numberFlag(flags, 'limit', 1, 100, true) ?? 50));
    return;
  }
  if (command === 'quote' || command === 'decide') {
    allowedFlags(flags, command === 'quote' ? ['input', 'max-price', 'latency-ms', 'confidence', 'sellers'] : ['input', 'max-price', 'latency-ms', 'confidence', 'sellers', 'key', 'journal']);
    const input = DecisionInputSchema.parse(await jsonFile(requireFlag(flags, 'input'), 32_768));
    const policy = purchasePolicy(flags);
    const quote = await client.quote(input, policy);
    if (command === 'quote') { output(quote); return; }
    const key = flags.key ?? randomUUID();
    const journal = { version: 1, baseUrl: client.baseUrl, quoteId: quote.id, idempotencyKey: key, input, preparedAt: new Date().toISOString() };
    if (flags.journal) await writeFile(flags.journal, `${JSON.stringify(journal, null, 2)}\n`, { flag: 'wx', mode: 0o600 });
    process.stderr.write(`${JSON.stringify({ event: 'purchase_prepared', quoteId: quote.id, idempotencyKey: key, inputFile: resolve(flags.input!), journal: flags.journal ? resolve(flags.journal) : null })}\n`);
    const receipt = await client.execute(quote.id, input, key);
    output(receipt);
    return;
  }
  if (command === 'execute') {
    allowedFlags(flags, ['input', 'quote', 'key']);
    const input = DecisionInputSchema.parse(await jsonFile(requireFlag(flags, 'input'), 32_768));
    output(await client.execute(requireFlag(flags, 'quote'), input, requireFlag(flags, 'key')));
    return;
  }
  if (command === 'recover') {
    allowedFlags(flags, ['journal']);
    const data = await jsonFile(requireFlag(flags, 'journal'));
    if (!data || typeof data !== 'object' || !('version' in data) || data.version !== 1 || !('baseUrl' in data) || data.baseUrl !== client.baseUrl || !('quoteId' in data) || typeof data.quoteId !== 'string' || !('idempotencyKey' in data) || typeof data.idempotencyKey !== 'string' || !('input' in data)) throw new Error('Invalid journal, or journal URL differs from ZOKO_URL.');
    output(await client.execute(data.quoteId, DecisionInputSchema.parse(data.input), data.idempotencyKey));
    return;
  }
  if (command === 'account' && words[1] === 'create') {
    allowedFlags(flags, ['name', 'daily-limit', 'max-price', 'sellers']);
    output(await client.request('POST', '/v1/admin/accounts', { name: requireFlag(flags, 'name'), dailyLimitNanos: parseXec(requireFlag(flags, 'daily-limit')), maxPriceNanos: parseXec(requireFlag(flags, 'max-price')), ...(flags.sellers ? { allowedSellers: flags.sellers.split(',').map((s) => s.trim()).filter(Boolean) } : {}) }));
    return;
  }
  if (command === 'seller' && words[1] === 'add') {
    allowedFlags(flags, ['input']);
    output(await client.request('POST', '/v1/admin/sellers', await jsonFile(requireFlag(flags, 'input'))));
    return;
  }
  if (command === 'api') {
    allowedFlags(flags, ['input', 'key']);
    const method = words[1]?.toUpperCase();
    const path = words[2];
    if (!method || !['GET', 'POST', 'PATCH', 'PUT', 'DELETE'].includes(method) || !path?.startsWith('/v1/') || words.length !== 3) throw new Error('Usage: api METHOD /v1/PATH [--input FILE] [--key IDEMPOTENCY_KEY]');
    const input = flags.input ? await jsonFile(flags.input) : undefined;
    if (method === 'GET' && input !== undefined) throw new Error('GET requests cannot have an input file.');
    output(await client.request(method, path, input, { idempotencyKey: flags.key }));
    return;
  }
  throw new Error(`Unknown command: ${words.join(' ')}. Run help for available commands.`);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error: unknown) => {
    if (error instanceof AmbiguousDecisionError) {
      process.stderr.write(`${JSON.stringify({ error: error.name, message: error.message, quoteId: error.quoteId, idempotencyKey: error.idempotencyKey, decisionId: error.decisionId })}\n`);
      process.exitCode = 2;
    } else {
      process.stderr.write(`${JSON.stringify({ error: error instanceof Error ? error.name : 'Error', message: error instanceof Error ? error.message : 'Unknown error', ...(error instanceof ZokoApiError ? { status: error.status, details: error.body } : {}) })}\n`);
      process.exitCode = 1;
    }
  });
}
