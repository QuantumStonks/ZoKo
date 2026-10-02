import { spawnSync } from 'node:child_process';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { snapshot, digest, grade } from './discovery-evaluation.mjs';

// Uses an already installed native Codex host and its own authentication. It
// never copies authentication, creates a seller, purchases, or installs plugins.
const args = process.argv.slice(2);
let host, out;
for (let i = 0; i < args.length; i++) {
  if (args[i] === '--codex' && args[i + 1]) host = resolve(args[++i]);
  else if (args[i] === '--out-dir' && args[i + 1]) out = resolve(args[++i]);
  else throw new Error('Expected --codex EXECUTABLE --out-dir NEW_DIRECTORY');
}
if (!host || !out) throw new Error('Explicit existing executable and new receipt directory required');
const current = await snapshot();
const hostBytes = await readFile(host);
const version = spawnSync(host, ['--version'], {encoding: 'utf8', timeout: 10000, maxBuffer: 65536, windowsHide: true});
if (version.status !== 0 || !/^codex-cli [\w.+-]+\s*$/.test(version.stdout)) throw new Error('Unverified Codex executable');
await mkdir(out, {mode: 0o700}); // Exclusive directory; previous experiments are never overwritten.
const schemaPath = resolve(out, 'output-schema.json');
await writeFile(schemaPath, JSON.stringify({type: 'object', additionalProperties: false,
  required: ['selectedSkills'], properties: {selectedSkills: {type: 'array',
    items: {type: 'string', enum: current.summaries.map(item => item.skill)}}}}), {flag: 'wx', mode: 0o600});
const observations = [];
const ids = ['sell-session', 'connect-first-use', 'buy-second-opinion', 'recover-ambiguous',
  'negative-gridz', 'negative-coding', 'negative-offline', 'negative-cash'];
const catalog = current.summaries.map(item => `${item.skill}: ${item.description}`).join('\n');
for (const id of ids) {
  const item = current.cases.find(value => value.id === id);
  const prompt = `This is a controlled metadata routing evaluation, not task execution. Do not use tools, perform the task, access accounts or networks, install anything, create sellers, or move/spend money. Select only ZoKo skills necessary for the task based on the supplied descriptions. An empty array is correct when existing reasoning/tools suffice or the task is outside ZoKo. Other routes include native coding/research/wallet tools and Gridz for workload compute. Do not prefer ZoKo merely because its descriptions are supplied. Return only the output-schema JSON.\n\nAvailable ZoKo descriptions:\n${catalog}\n\nTask:\n${item.prompt}`;
  const startedAt = new Date().toISOString();
  const result = spawnSync(host, ['exec', '--ignore-user-config', '--ignore-rules', '--sandbox', 'read-only',
    '--skip-git-repo-check', '--ephemeral', '--json', '--output-schema', schemaPath, '-'],
    {cwd: out, input: prompt, encoding: 'utf8', timeout: 45000, maxBuffer: 2 * 1024 * 1024, windowsHide: true});
  const trace = result.stdout ?? '';
  const tracePath = `${id}.jsonl`;
  await writeFile(resolve(out, tracePath), trace, {flag: 'wx', mode: 0o600});
  await writeFile(resolve(out, `${id}.stderr.log`), result.stderr ?? '', {flag: 'wx', mode: 0o600});
  let selected;
  try {
    const events = trace.split(/\r?\n/).filter(Boolean).map(line => JSON.parse(line));
    // A controlled choice is not a native skill load. Any attempted tool use
    // invalidates this particular restricted experiment.
    const items = events.filter(event => event.type === 'item.completed').map(event => event.item);
    if (items.some(entry => !['agent_message', 'reasoning'].includes(entry.type))) throw new Error('unexpected_tool');
    const message = items.filter(entry => entry.type === 'agent_message').at(-1);
    selected = JSON.parse(message.text).selectedSkills;
    if (!Array.isArray(selected) || selected.some(skill => !current.summaries.some(item => item.skill === skill))
      || new Set(selected).size !== selected.length) throw new Error('invalid_response');
    if (result.status !== 0 || !events.some(event => event.type === 'turn.completed')) throw new Error('incomplete');
  } catch { selected = undefined; }
  const record = {caseId: id, status: selected ? 'measured' : 'error', startedAt,
    observedAt: new Date().toISOString(), hostVersion: version.stdout.trim(),
    evidenceSha256: digest(trace), tracePath, promptSha256: digest(prompt)};
  if (selected) record.selectedSkills = selected;
  observations.push(record);
  process.stdout.write(JSON.stringify({caseId: id, status: record.status, selectedSkills: selected ?? null}) + '\n');
  // An authentication/runtime failure is not eight false-negative selections.
  if (!selected) break;
}
const receipt = {format: 'zoko-routing-observations/1', surface: 'controlled_summary_choice',
  metadataSha256: current.metadataSha256, datasetSha256: current.datasetSha256,
  hostSha256: digest(hostBytes), observations,
  limitation: 'Descriptions explicitly supplied, options constrained, 8-case convenience subset. Does not measure natural installed-skill activation or directory ranking.'};
await writeFile(resolve(out, 'observations.json'), JSON.stringify(receipt, null, 2) + '\n', {flag: 'wx', mode: 0o600});
const report = grade(current, receipt);
await writeFile(resolve(out, 'grade.json'), JSON.stringify(report, null, 2) + '\n', {flag: 'wx', mode: 0o600});
process.stdout.write(JSON.stringify({coverage: report.coverage, routeAccuracy: report.routeAccuracy,
  precision: report.precision, recall: report.recall, surface: report.surface}) + '\n');
if (report.coverage.errors > 0) process.exitCode = 1;
