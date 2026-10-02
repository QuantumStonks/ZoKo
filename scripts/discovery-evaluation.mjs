import { createHash } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const skills = ['buy-decision', 'connect-marketplace', 'sell-decisions'];
export const digest = value => createHash('sha256').update(value).digest('hex');

export async function snapshot() {
  const files = ['plugins/zoko/plugin.json', 'plugins/zoko/.codex-plugin/plugin.json',
    'docs/discovery-evaluation-v2.json', ...skills.flatMap(skill => [
      `plugins/zoko/skills/${skill}/SKILL.md`, `plugins/zoko/skills/${skill}/agents/openai.yaml`])];
  const inputs = await Promise.all(files.map(async path => ({path, bytes: await readFile(resolve(root, path))})));
  const fingerprints = inputs.map(({path, bytes}) => ({path, sha256: digest(bytes)}));
  const metadataSha256 = digest(JSON.stringify(fingerprints.filter(file => !file.path.startsWith('docs/'))));
  const datasetBytes = inputs.find(file => file.path.startsWith('docs/')).bytes;
  const dataset = JSON.parse(datasetBytes);
  if (dataset.format !== 'zoko-discovery-prompts/2' || !Array.isArray(dataset.cases)) throw new Error('invalid_dataset');
  const ids = new Set();
  for (const item of dataset.cases) {
    if (!item.id || ids.has(item.id) || typeof item.prompt !== 'string' || !item.prompt.trim()
      || !['development', 'holdout'].includes(item.split) || !Array.isArray(item.expectedSkills)
      || item.expectedSkills.some(skill => !skills.includes(skill))) throw new Error('invalid_case');
    ids.add(item.id);
  }
  const manifest = JSON.parse(inputs[0].bytes);
  const compatibility = JSON.parse(inputs[1].bytes);
  if (manifest.name !== compatibility.name || manifest.version !== compatibility.version
    || manifest.description !== compatibility.description
    || JSON.stringify(manifest.keywords) !== JSON.stringify(compatibility.keywords)) throw new Error('manifest_drift');
  const summaries = skills.map(skill => {
    const text = inputs.find(file => file.path === `plugins/zoko/skills/${skill}/SKILL.md`).bytes.toString('utf8');
    const frontmatter = /^---\r?\n([\s\S]*?)\r?\n---/.exec(text)?.[1];
    const description = /^description: (.+)$/m.exec(frontmatter ?? '')?.[1]?.trim();
    if (!description) throw new Error('missing_skill_description');
    const policy = inputs.find(file => file.path === `plugins/zoko/skills/${skill}/agents/openai.yaml`).bytes.toString('utf8');
    return {skill, description, descriptionCharacters: [...description].length,
      implicitInvocationAllowed: /^\s*allow_implicit_invocation: true\s*$/m.test(policy)};
  });
  return {format: 'zoko-discovery-snapshot/1', observedAt: new Date().toISOString(),
    version: manifest.version, metadataSha256, datasetSha256: digest(datasetBytes), fingerprints,
    caseCount: dataset.cases.length, cases: dataset.cases, summaries,
    modelRoutingMeasured: false, directoryRankingMeasured: false};
}

// This is the ASCII-name/keyword portion of the pinned Codex 0.159.0 app-server
// local search ranking. It is not the remote directory search algorithm.
export function localMatchTier(plugin, query) {
  const normalize = value => {
    if (/[^\x00-\x7f]/.test(value)) throw new Error('unsupported_non_ascii_profile');
    return value.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
  };
  const q = normalize(query);
  if (!q) return null;
  const visible = normalize(plugin.displayName ?? '');
  const internal = normalize(plugin.name);
  const names = [visible, internal];
  const keywords = plugin.keywords.map(normalize);
  const joined = normalize(`${internal} ${visible} ${keywords.join(' ')}`);
  const tiers = [visible === q, internal === q, names.some(name => name.startsWith(q)),
    names.some(name => name.includes(q)), keywords.some(word => word === q),
    keywords.some(word => word.includes(q)) || joined.includes(q)];
  const result = tiers.indexOf(true);
  return result === -1 ? null : result;
}

export function grade(snapshot, observations) {
  if (observations.format !== 'zoko-routing-observations/1'
    || observations.metadataSha256 !== snapshot.metadataSha256
    || observations.datasetSha256 !== snapshot.datasetSha256
    || !Array.isArray(observations.observations)) throw new Error('stale_or_invalid_observations');
  const allowedSurfaces = ['controlled_summary_choice', 'native_skill_load'];
  if (!allowedSurfaces.includes(observations.surface)) throw new Error('invalid_surface');
  const seen = new Set();
  let truePositive = 0, falsePositive = 0, trueNegative = 0, falseNegative = 0, routeCorrect = 0, errors = 0;
  const cases = [];
  for (const observation of observations.observations) {
    const expected = snapshot.cases.find(item => item.id === observation.caseId);
    if (!expected || seen.has(observation.caseId)) throw new Error('unknown_or_duplicate_case');
    seen.add(observation.caseId);
    if (!['measured', 'error'].includes(observation.status)) throw new Error('invalid_status');
    if (observation.status === 'error') { errors++; cases.push({id: expected.id, status: 'error'}); continue; }
    if (!Array.isArray(observation.selectedSkills) || observation.selectedSkills.some(skill => !skills.includes(skill))
      || new Set(observation.selectedSkills).size !== observation.selectedSkills.length
      || !/^[a-f0-9]{64}$/.test(observation.evidenceSha256 ?? '')
      || typeof observation.hostVersion !== 'string' || !observation.hostVersion
      || typeof observation.observedAt !== 'string' || !Number.isFinite(Date.parse(observation.observedAt))) {
      throw new Error('unverifiable_observation');
    }
    const triggered = observation.selectedSkills.length > 0;
    const positive = expected.expectedSkills.length > 0;
    if (positive && triggered) truePositive++;
    if (!positive && triggered) falsePositive++;
    if (!positive && !triggered) trueNegative++;
    if (positive && !triggered) falseNegative++;
    const correct = positive
      ? triggered && observation.selectedSkills.every(skill => expected.expectedSkills.includes(skill))
      : !triggered;
    if (correct) routeCorrect++;
    cases.push({id: expected.id, split: expected.split, selectedSkills: observation.selectedSkills, correct});
  }
  const measured = truePositive + falsePositive + trueNegative + falseNegative;
  const ratio = (n, d) => d === 0 ? null : n / d;
  return {format: 'zoko-routing-grade/1', observedAt: new Date().toISOString(),
    surface: observations.surface, metadataSha256: snapshot.metadataSha256, datasetSha256: snapshot.datasetSha256,
    coverage: {total: snapshot.cases.length, measured, errors, unobserved: snapshot.cases.length - seen.size},
    confusion: {truePositive, falsePositive, trueNegative, falseNegative},
    precision: ratio(truePositive, truePositive + falsePositive), recall: ratio(truePositive, truePositive + falseNegative),
    routeAccuracy: ratio(routeCorrect, measured), cases,
    scope: 'Only supplied evidenced observations; no directory rank, adoption, execution success or earnings inferred.'};
}

async function main() {
  const args = process.argv.slice(2);
  let out, observations;
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--out' && args[i + 1]) out = args[++i];
    else if (args[i] === '--observations' && args[i + 1]) observations = args[++i];
    else throw new Error('invalid_arguments');
  }
  const current = await snapshot();
  const manifest = JSON.parse(await readFile(resolve(root, 'plugins/zoko/plugin.json')));
  const profile = {name: manifest.name, displayName: manifest.extensions['com.openai'].interface.displayName, keywords: manifest.keywords};
  const report = observations ? grade(current, JSON.parse(await readFile(resolve(observations)))) : {...current,
    localSearchProfile: {sourceCommit: '687a119f0fcaace47e1f1abcc77cec6c813fd6da',
      sourcePath: 'codex-rs/app-server/src/request_processors/plugins/search.rs',
      queryTiers: ['ZoKo', 'eCash', 'XEC', 'sell AI decisions', 'rubric scoring', 'purchase recovery', 'earn money', 'second opinion']
        .map(query => ({query, tier: localMatchTier(profile, query)})),
      scope: 'Static ASCII local-search compatibility diagnostic; not an actual search response or global rank.'}};
  if (out) await writeFile(resolve(out), JSON.stringify(report, null, 2) + '\n', {flag: 'wx', mode: 0o600});
  process.stdout.write(JSON.stringify({format: report.format, output: out ?? null,
    metadataSha256: report.metadataSha256, datasetSha256: report.datasetSha256,
    cases: report.caseCount ?? report.coverage, modelRoutingMeasured: Boolean(observations)}, null, 2) + '\n');
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch(() => { process.stderr.write('Discovery evaluation failed; no result recorded.\n'); process.exitCode = 1; });
}
