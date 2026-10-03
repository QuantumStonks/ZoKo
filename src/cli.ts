#!/usr/bin/env node
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { lstat, mkdir, open, realpath, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { AmbiguousDecisionError, ZokoApiError, ZokoClient, parseXec, validateIdempotencyKey, type PurchasePolicy, type Quote, type RegisterSellerOfferInput, type UpdateSellerOfferInput } from './client.js';
import { DecisionInputSchema, type DecisionInput } from './protocol.js';
import { claimWithJournal, completeWithJournal } from './agent-journal.js';
import { prepareEnrollment, readAgentCredentials } from './enrollment.js';

const help = `Zoko — typed decisions, exact XEC accounting

Environment:
  ZOKO_URL       HTTPS server URL (default http://127.0.0.1:3000)
  ZOKO_API_KEY   Buyer API key; use the operator token for admin commands.
                Credentials are read from the environment, never CLI arguments.
  ZOKO_JOURNAL_DIR  Private purchase journal directory (default ~/.zoko/purchases)
  ZOKO_CREDENTIALS_FILE  Protected enrollment file; keeps account keys out of prompts

Commands:
  keygen [--out FILE]                         Generate operator + encryption environment keys
  doctor                                     Inspect public live and ready probes
  discover                                   Read public service and billing metadata
  enroll --credentials FILE --name NAME       Generate/protect a local key and enroll
         [--daily-limit XEC] [--max-price XEC] Defaults to zero purchase authority
  catalog | me | history [--limit 1..100]      Read the market or your account
  decision --id ID                           Read one original decision receipt
  deposits [--txid TXID] [--limit 1..100]      Read your verified deposit history
  quote --input FILE --max-price XEC          Get a bound quote; does not purchase
         [--journal FILE] [--key KEY]         Save for later reviewed execution
  decide --input FILE --max-price XEC         Quote once, then purchase and poll
         [--latency-ms N] [--confidence 0..1] [--sellers ID,ID]
         [--key IDEMPOTENCY_KEY] [--journal FILE]
  execute --journal FILE                     Execute the exact reviewed quote/input
  execute --input FILE --quote ID --key KEY   Execute/recover an original purchase
         [--journal FILE]                    Persist recovery data before dispatch
  recover --journal FILE                     Resume from an existing purchase journal
  account create --name NAME --daily-limit XEC --max-price XEC
         [--sellers ID,ID]                    Issue an account key (operator)
  seller add --input FILE                     Register a provider (operator)
  seller list [--limit N] [--after ID]         Read your own bounded offer page
  seller register --input FILE               Submit your own offer for approval
  seller update --id ID --input FILE          Change own price/key/pause state
  seller agent-register --input FILE          Publish an active-session offer (pending approval)
  seller ready --id ID --ready true|false      Renew 120-second presence or go offline
  seller claim --id ID --journal FILE          Durably claim/recover one typed decision
  seller complete --journal FILE [--input FILE] Submit/recover its original typed result
  api METHOD /v1/PATH [--input FILE] [--key KEY]
                                             Explicit API call; no automatic retries
  help                                       Show this message

Decision files contain {"state":...,"questions":...}. Money accepts exact XEC
decimal strings with at most nine decimal places; all API amounts are nanoXEC.
decide/execute save the original payload, quote ID and key BEFORE dispatch,
using an exclusive mode-0600 journal. --journal selects its path. New journals
bind the account and URL; recover also accepts original version-1 journals.
Keep the journal and its .attempt.json dispatch marker until reconciled.
Recovery never obtains a new quote. The raw api command has no journal.
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
  const file = await open(path, 'r');
  try {
    if (!(await file.stat()).isFile()) throw new Error('Input must be a regular file.');
    const content = Buffer.alloc(maxBytes + 1);
    let length = 0;
    while (length < content.length) {
      const { bytesRead } = await file.read(content, length, content.length - length, null);
      if (!bytesRead) break;
      length += bytesRead;
    }
    if (length > maxBytes) throw new Error(`Input exceeds ${maxBytes} bytes.`);
    try { return JSON.parse(content.subarray(0, length).toString('utf8')) as unknown; } catch { throw new Error('Input file must contain valid JSON.'); }
  } finally { await file.close(); }
}
function output(value: unknown): void { process.stdout.write(`${JSON.stringify(value, null, 2)}\n`); }
function purchasePolicy(flags: Flags): PurchasePolicy {
  const policy: PurchasePolicy = { maxPriceNanos: parseXec(requireFlag(flags, 'max-price')) };
  const latency = numberFlag(flags, 'latency-ms', 100, 60_000, true);
  const confidence = numberFlag(flags, 'confidence', 0, 1);
  if (latency !== undefined) policy.maxLatencyMs = latency;
  if (confidence !== undefined) policy.minConfidence = confidence;
  if (flags.sellers) policy.allowedSellers = flags.sellers.split(',').map((s) => s.trim()).filter(Boolean);
  return policy;
}
async function doctor(client: ZokoClient): Promise<void> {
  const result = await Promise.all((['live', 'ready'] as const).map(async (probe) => {
    const path = `/health/${probe}`;
    try {
      return { path, ok: true, status: 200, data: await client.health(probe, AbortSignal.timeout(15_000)) };
    } catch (error) { return { path, ok: false, ...(error instanceof ZokoApiError ? { status: error.status, data: error.body } : {}), error: error instanceof Error ? error.message : 'Connection failed' }; }
  }));
  output({ baseUrl: client.baseUrl, probes: result });
  if (result.some((item) => !item.ok)) process.exitCode = 1;
}

interface PurchaseJournal {
  version: 1 | 2;
  baseUrl: string;
  accountId?: string;
  quoteId: string;
  idempotencyKey: string;
  input: DecisionInput;
  preparedAt?: string;
  quote?: Quote;
}
async function accountId(client: ZokoClient): Promise<string> {
  const identity = await client.me<{ account?: { id?: unknown } }>();
  if (!identity?.account || typeof identity.account.id !== 'string' || !identity.account.id) throw new Error('Zoko returned an invalid account identity.');
  return identity.account.id;
}
async function journalPath(explicit: string | undefined, client: ZokoClient, key: string): Promise<string> {
  if (explicit) return resolve(explicit);
  const directory = resolve(process.env.ZOKO_JOURNAL_DIR ?? join(homedir(), '.zoko', 'purchases'));
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const identity = createHash('sha256').update(`${client.baseUrl}\0${key}`).digest('hex');
  return join(directory, `${identity}.json`);
}
async function saveJournal(path: string, journal: PurchaseJournal): Promise<void> {
  const serialized = `${JSON.stringify(journal)}\n`;
  if (Buffer.byteLength(serialized) > 65_536) throw new Error('Purchase journal exceeds the 65,536-byte recovery limit. No decision was dispatched.');
  const file = await open(path, 'wx', 0o600).catch((error: NodeJS.ErrnoException) => {
    if (error.code === 'EEXIST') throw new Error(`Purchase journal already exists. Use recover --journal ${JSON.stringify(path)}; do not create a new purchase.`);
    throw error;
  });
  try {
    await file.writeFile(serialized, 'utf8');
    await file.sync();
  } finally { await file.close(); }
}
async function readJournal(path: string, client: ZokoClient): Promise<PurchaseJournal> {
  const data = await jsonFile(path);
  if (!data || typeof data !== 'object') throw new Error('Invalid purchase journal.');
  const value = data as Record<string, unknown>;
  if (![1, 2].includes(Number(value.version)) || typeof value.version !== 'number' || value.baseUrl !== client.baseUrl || typeof value.quoteId !== 'string' || !value.quoteId || typeof value.idempotencyKey !== 'string') throw new Error('Invalid journal, or journal URL differs from ZOKO_URL.');
  validateIdempotencyKey(value.idempotencyKey);
  const journal = { ...value, input: DecisionInputSchema.parse(value.input) } as unknown as PurchaseJournal;
  if (value.version === 2) {
    if (typeof value.accountId !== 'string') throw new Error('Invalid account-bound purchase journal.');
    let currentAccount: string;
    try { currentAccount = await accountId(client); }
    catch (error) {
      if (await wasAttempted(path, journal)) throw new AmbiguousDecisionError(journal.quoteId, journal.idempotencyKey, undefined, error);
      throw error;
    }
    if (value.accountId !== currentAccount) throw new Error('Purchase journal belongs to a different Zoko account. Restore the original account credential.');
  }
  return journal;
}
async function wasAttempted(path: string, journal: PurchaseJournal): Promise<boolean> {
  let data: unknown;
  try { data = await jsonFile(`${path}.attempt.json`, 4096); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false; throw error; }
  if (!data || typeof data !== 'object') throw new Error('Invalid dispatch marker; preserve the original journal and reconcile its purchase.');
  const attempt = data as Record<string, unknown>;
  if (attempt.version !== 1 || attempt.baseUrl !== journal.baseUrl || attempt.accountId !== journal.accountId || attempt.quoteId !== journal.quoteId || attempt.idempotencyKey !== journal.idempotencyKey || typeof attempt.attemptedAt !== 'string') throw new Error('Dispatch marker differs from the original purchase. Preserve both files and reconcile before continuing.');
  return true;
}
async function markAttempt(path: string, journal: PurchaseJournal): Promise<boolean> {
  if (await wasAttempted(path, journal)) return true;
  let file;
  try { file = await open(`${path}.attempt.json`, 'wx', 0o600); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'EEXIST') {
      if (await wasAttempted(path, journal)) return true;
      throw new Error('Dispatch marker exists but is unreadable. Preserve the journal and reconcile before continuing.');
    }
    throw error;
  }
  try {
    await file.writeFile(`${JSON.stringify({ version: 1, baseUrl: journal.baseUrl, accountId: journal.accountId, quoteId: journal.quoteId, idempotencyKey: journal.idempotencyKey, attemptedAt: new Date().toISOString() })}\n`, 'utf8');
    await file.sync();
  } finally { await file.close(); }
  return false;
}
function prepared(path: string, journal: PurchaseJournal): void {
  process.stderr.write(`${JSON.stringify({ event: 'purchase_prepared', quoteId: journal.quoteId, idempotencyKey: journal.idempotencyKey, accountId: journal.accountId, journal: path, dispatchMarker: `${path}.attempt.json` })}\n`);
}
async function executeJournal(path: string, journal: PurchaseJournal, client: ZokoClient): Promise<void> {
  prepared(path, journal);
  const alreadyAttempted = await markAttempt(path, journal);
  try { output(await client.execute(journal.quoteId, journal.input, journal.idempotencyKey)); }
  catch (error) {
    // A fresh process must retain uncertainty from a prior dispatched purchase,
    // even when authentication fails before the server can inspect that key.
    if ((alreadyAttempted || journal.version === 1) && !(error instanceof AmbiguousDecisionError)) throw new AmbiguousDecisionError(journal.quoteId, journal.idempotencyKey, undefined, error);
    throw error;
  }
}
function positional(words: string[], expected: number): void {
  if (words.length !== expected) throw new Error(`Unexpected positional arguments for ${words.slice(0, expected).join(' ')}.`);
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
  if(process.env.ZOKO_CREDENTIALS_FILE && process.env.ZOKO_API_KEY) throw Error('Competing credential sources: use either ZOKO_CREDENTIALS_FILE or ZOKO_API_KEY; no request sent');
  const saved=process.env.ZOKO_CREDENTIALS_FILE ? await readAgentCredentials(process.env.ZOKO_CREDENTIALS_FILE) : undefined;
  const baseUrl = process.env.ZOKO_URL ?? saved?.baseUrl ?? 'http://127.0.0.1:3000';
  if(saved && new ZokoClient({baseUrl}).baseUrl!==saved.baseUrl) throw Error('Credentials belong to a different marketplace; no authenticated request sent');
  if(command==='enroll') {
    allowedFlags(flags,['credentials','name','daily-limit','max-price']);positional(words,1);
    if(!process.env.ZOKO_URL) throw Error('Set the intended ZOKO_URL before enrollment');
    const input={name:requireFlag(flags,'name'),dailyLimitNanos:parseXec(flags['daily-limit']??'0'),maxPriceNanos:parseXec(flags['max-price']??'0')};
    const credential=await prepareEnrollment(requireFlag(flags,'credentials'),baseUrl,input);
    const enrollmentClient=new ZokoClient({baseUrl:credential.baseUrl,apiKey:credential.apiKey});
    const discovery=await enrollmentClient.discover<{authentication?:{enrollment?:string}}>();
    if(discovery.authentication?.enrollment!=='/v1/enroll') throw Error('This marketplace does not support self-service enrollment; protected credentials preserved');
    const result=await enrollmentClient.enroll(credential.enrollment);
    output({credentialsFile:resolve(requireFlag(flags,'credentials')),result,next:'Set ZOKO_CREDENTIALS_FILE to this protected file and run me; never print the key'});return;
  }
  const client = new ZokoClient({ baseUrl, apiKey: process.env.ZOKO_API_KEY || saved?.apiKey });
  if (command === 'doctor') { allowedFlags(flags, []); positional(words, 1); await doctor(client); return; }
  if (command === 'discover' || command === 'catalog' || command === 'me' || command === 'history') {
    allowedFlags(flags, command === 'history' ? ['limit'] : []);
    if (words.length !== 1) throw new Error(`${command} takes no positional arguments.`);
    output(command === 'discover' ? await client.discover() : command === 'catalog' ? await client.catalog() : command === 'me' ? await client.me() : await client.history(numberFlag(flags, 'limit', 1, 100, true) ?? 50));
    return;
  }
  if (command === 'decision') {
    allowedFlags(flags, ['id']); positional(words, 1);
    output(await client.getDecision(requireFlag(flags, 'id'))); return;
  }
  if (command === 'deposits') {
    allowedFlags(flags, ['txid', 'limit']); positional(words, 1);
    output(await client.deposits({ txid: flags.txid, limit: numberFlag(flags, 'limit', 1, 100, true) })); return;
  }
  if (command === 'quote' || command === 'decide') {
    allowedFlags(flags, ['input', 'max-price', 'latency-ms', 'confidence', 'sellers', 'key', 'journal']); positional(words, 1);
    if (command === 'quote' && flags.key && !flags.journal) throw new Error('quote --key requires --journal to preserve the purchase identity.');
    const input = DecisionInputSchema.parse(await jsonFile(requireFlag(flags, 'input'), 32_768));
    const policy = purchasePolicy(flags);
    const key = flags.key ?? randomUUID();
    validateIdempotencyKey(key);
    const path = command === 'decide' || flags.journal ? await journalPath(flags.journal, client, key) : undefined;
    if (path) {
      const exists = await lstat(path).then(() => true, (error: NodeJS.ErrnoException) => { if (error.code === 'ENOENT') return false; throw error; });
      if (exists) throw new Error(`Purchase journal already exists. Use recover --journal ${JSON.stringify(path)}; do not request another quote.`);
    }
    const owner = command === 'decide' || flags.journal ? await accountId(client) : undefined;
    const quote = await client.quote(input, policy);
    if (command === 'quote' && !flags.journal) { output(quote); return; }
    const journal: PurchaseJournal = { version: 2, baseUrl: client.baseUrl, accountId: owner, quoteId: quote.id, quote, idempotencyKey: key, input, preparedAt: new Date().toISOString() };
    await saveJournal(path!, journal);
    if (command === 'quote') { prepared(path!, journal); output(quote); return; }
    await executeJournal(path!, journal, client);
    return;
  }
  if (command === 'execute') {
    allowedFlags(flags, ['input', 'quote', 'key', 'journal']); positional(words, 1);
    if (flags.journal && !flags.input && !flags.quote && !flags.key) {
      const path = resolve(flags.journal);
      await executeJournal(path, await readJournal(path, client), client); return;
    }
    const input = DecisionInputSchema.parse(await jsonFile(requireFlag(flags, 'input'), 32_768));
    const quoteId = requireFlag(flags, 'quote'), key = requireFlag(flags, 'key');
    validateIdempotencyKey(key);
    const path = await journalPath(flags.journal, client, key);
    // Explicit recovery using the old invocation stays compatible when its automatic
    // journal already exists, but a different payload/account cannot replace it.
    let existing: PurchaseJournal | undefined;
    try { existing = await readJournal(path, client); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
    if (existing) {
      if (existing.quoteId !== quoteId || existing.idempotencyKey !== key || JSON.stringify(existing.input) !== JSON.stringify(input)) throw new Error('Existing journal has a different purchase identity or payload. Use its original recover command.');
      await executeJournal(path, existing, client); return;
    }
    const journal: PurchaseJournal = { version: 2, baseUrl: client.baseUrl, accountId: await accountId(client), quoteId, idempotencyKey: key, input, preparedAt: new Date().toISOString() };
    await saveJournal(path, journal);
    await executeJournal(path, journal, client);
    return;
  }
  if (command === 'recover') {
    allowedFlags(flags, ['journal']); positional(words, 1);
    const path = resolve(requireFlag(flags, 'journal'));
    await executeJournal(path, await readJournal(path, client), client);
    return;
  }
  if (command === 'account' && words[1] === 'create') {
    allowedFlags(flags, ['name', 'daily-limit', 'max-price', 'sellers']); positional(words, 2);
    output(await client.request('POST', '/v1/admin/accounts', { name: requireFlag(flags, 'name'), dailyLimitNanos: parseXec(requireFlag(flags, 'daily-limit')), maxPriceNanos: parseXec(requireFlag(flags, 'max-price')), ...(flags.sellers ? { allowedSellers: flags.sellers.split(',').map((s) => s.trim()).filter(Boolean) } : {}) }));
    return;
  }
  if(command==='seller'&&words[1]==='agent-register'){
    allowedFlags(flags,['input']);positional(words,2);
    output(await client.request('POST','/v1/seller/agent-offers',await jsonFile(requireFlag(flags,'input'))));return;
  }
  if(command==='seller'&&words[1]==='ready'){
    allowedFlags(flags,['id','ready']);positional(words,2);
    const id=requireFlag(flags,'id'),ready=requireFlag(flags,'ready');
    if(!/^[a-z0-9][a-z0-9_-]{0,63}$/.test(id)||!['true','false'].includes(ready))throw new Error('Provide a valid offer ID and --ready true or false.');
    output(await client.request('POST',`/v1/seller/offers/${id}/ready`,{ready:ready==='true'}));return;
  }
  if(command==='seller'&&words[1]==='claim'){
    allowedFlags(flags,['id','journal']);positional(words,2);
    output(await claimWithJournal(client,resolve(requireFlag(flags,'journal')),requireFlag(flags,'id')));return;
  }
  if(command==='seller'&&words[1]==='complete'){
    allowedFlags(flags,['journal','input']);positional(words,2);
    output(await completeWithJournal(client,resolve(requireFlag(flags,'journal')),flags.input?await jsonFile(flags.input):undefined));return;
  }
  if (command === 'seller' && words[1] === 'add') {
    allowedFlags(flags, ['input']); positional(words, 2);
    output(await client.request('POST', '/v1/admin/sellers', await jsonFile(requireFlag(flags, 'input'))));
    return;
  }
  if (command === 'seller' && words[1] === 'list') {
    allowedFlags(flags, ['limit', 'after']); positional(words, 2);
    output(await client.listOffers({ limit: numberFlag(flags, 'limit', 1, 100, true), after: flags.after })); return;
  }
  if (command === 'seller' && ['register', 'update'].includes(words[1] ?? '')) {
    allowedFlags(flags, words[1] === 'register' ? ['input'] : ['input', 'id']); positional(words, 2);
    const input = await jsonFile(requireFlag(flags, 'input'));
    if (!input || typeof input !== 'object' || Array.isArray(input)) throw new Error('Offer input must be a JSON object.');
    output(words[1] === 'register' ? await client.registerOffer(input as RegisterSellerOfferInput) : await client.updateOffer(requireFlag(flags, 'id'), input as UpdateSellerOfferInput)); return;
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

// Node resolves module paths through directory aliases (for example macOS /var).
// Canonicalize both sides so direct execution still works without running on import.
const entryPath = process.argv[1] ? await realpath(process.argv[1]).catch(() => undefined) : undefined;
if (entryPath && entryPath === await realpath(fileURLToPath(import.meta.url))) {
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
