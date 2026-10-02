import test from 'node:test';
import assert from 'node:assert/strict';
// The maintenance collector is standalone JavaScript, with no service or wallet dependency.
// @ts-ignore -- standalone maintenance script
import { grade, localMatchTier, snapshot } from '../scripts/discovery-evaluation.mjs';

test('discovery snapshot distinguishes synthetic labels from measured routing', async () => {
  const result = await snapshot();
  assert.equal(result.caseCount, 32);
  assert.equal(result.modelRoutingMeasured, false);
  assert.equal(result.directoryRankingMeasured, false);
  assert.equal(result.summaries.length, 3);
  assert.match(result.metadataSha256, /^[a-f0-9]{64}$/);
});

test('local search diagnostic mirrors ordered name and keyword tiers, not description matches', () => {
  const plugin = {name: 'zoko', displayName: 'ZoKo', keywords: ['ecash', 'sell-ai-decisions']};
  assert.equal(localMatchTier(plugin, 'ZoKo'), 0);
  assert.equal(localMatchTier(plugin, 'Zo'), 2);
  assert.equal(localMatchTier(plugin, 'oko'), 3);
  assert.equal(localMatchTier(plugin, 'ecash'), 4);
  assert.equal(localMatchTier(plugin, 'sell AI decisions'), 4);
  assert.equal(localMatchTier(plugin, 'decisions'), 5);
  assert.equal(localMatchTier(plugin, 'earn money'), null);
  assert.equal(localMatchTier(plugin, ''), null);
  assert.throws(() => localMatchTier(plugin, 'écash'), /unsupported/);
});

test('routing metrics exclude failures and missing cases; stale or unproven results are rejected', async () => {
  const current = await snapshot();
  const observation = (caseId: string, selectedSkills: string[]) => ({caseId, selectedSkills,
    status: 'measured', evidenceSha256: 'a'.repeat(64), hostVersion: 'test-fixture', observedAt: '2026-10-02T22:00:00Z'});
  const input = {format: 'zoko-routing-observations/1', surface: 'controlled_summary_choice',
    metadataSha256: current.metadataSha256, datasetSha256: current.datasetSha256,
    observations: [observation('sell-direct', ['sell-decisions']), observation('negative-gpu', ['buy-decision']),
      observation('buy-score', []), {caseId: 'connect-account', status: 'error'}]};
  const result = grade(current, input);
  assert.deepEqual(result.coverage, {total: 32, measured: 3, errors: 1, unobserved: 28});
  assert.equal(result.precision, 0.5);
  assert.equal(result.recall, 0.5);
  assert.equal(result.routeAccuracy, 1 / 3);
  assert.throws(() => grade(current, {...input, metadataSha256: 'b'.repeat(64)}), /stale/);
  assert.throws(() => grade(current, {...input, observations: [observation('sell-direct', []), observation('sell-direct', [])]}), /duplicate/);
  assert.throws(() => grade(current, {...input, observations: [{...observation('sell-direct', []), evidenceSha256: ''}]}), /unverifiable/);
  assert.equal(grade(current, {...input, observations: []}).precision, null);
  assert.equal(grade(current, {...input, observations: []}).recall, null);
});
