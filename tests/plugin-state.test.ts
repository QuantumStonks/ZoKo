import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const privateKeys = new Set([
  'accountid', 'depositaddress', 'walletdisplayxec', 'walletbalancexec',
  'walletaddressindexerutxos', 'credentialfile',
]);
const campaignKeys = new Set([
  'authority', 'cumulativeCapNanos', 'maximumDecisionNanos', 'initialDepositNanos',
  'privateReceipt', 'spentNanos', 'reservedNanos', 'walletFeeNanos',
  'marketplaceCreditedNanos', 'expiresAt', 'funding', 'credentialOffsiteEncrypted',
  'purchases', 'independentEligibleSellers', 'taskScope', 'operatorContinuousSellerSpendingNanos',
]);

// Return only a boolean so a failing check never prints private state values.
function isPublicState(value: unknown): boolean {
  if (typeof value === 'string') return !/ecash(?::|%3a)[a-z0-9]+/i.test(value);
  if (Array.isArray(value)) return value.every(isPublicState);
  if (value === null || typeof value !== 'object') return true;
  return Object.entries(value).every(([key, child]) => {
    const normalized = key.replace(/[-_\s]/g, '').toLowerCase();
    if (privateKeys.has(normalized)) return false;
    if (normalized === 'buyercampaign' && (
      child === null || typeof child !== 'object' || Array.isArray(child)
      || !Object.keys(child).every(campaignKey => campaignKeys.has(campaignKey))
    )) return false;
    // Historical acceptance names the wallet app, which is public status.
    if (normalized === 'fundingwallet') {
      return typeof child === 'string' && /^cashtab$/i.test(child);
    }
    return isPublicState(child);
  });
}

test('tracked plugin state excludes private wallet balances and account/address linkage', async () => {
  const repository = new URL(import.meta.url.includes('/dist/') ? '../../' : '../', import.meta.url);
  const state: unknown = JSON.parse(await readFile(new URL('ops/plugin-state.json', repository), 'utf8'));
  assert.ok(isPublicState(state), 'Keep private operating details in ignored receipts, never tracked state.');
});

test('public state guard catches nested and renamed private fields without rejecting receipt references or limits', () => {
  for (const key of [...privateKeys, 'fundingWallet', 'ACCOUNT_ID', 'deposit-address', 'Wallet_Display_Xec']) {
    assert.equal(isPublicState({ campaign: [{ [key]: 'private-fixture' }] }), false);
  }
  assert.equal(isPublicState({ renamedField: 'ECASH:qsyntheticfixture' }), false);
  assert.equal(isPublicState({ campaign: ['ecash:qsyntheticfixture'] }), false);
  assert.equal(isPublicState({ fundingLink: 'https://pay.e.cash/?bip21=ecash%3Aqsyntheticfixture' }), false);
  assert.equal(isPublicState({ buyerCampaign: { account: { id: 'private-fixture' }, balanceNanos: '123' } }), false);
  assert.ok(isPublicState({
    fundingWallet: 'Cashtab',
    buyerCampaign: {
      cumulativeCapNanos: '1000000000000', maximumDecisionNanos: '10000000000',
      spentNanos: '0', reservedNanos: '0', walletFeeNanos: null,
      independentEligibleSellers: 0, purchases: [], funding: 'prepared_not_sent',
      privateReceipt: { receipt: '.local/plugin-evidence/campaign.json', sha256: 'a'.repeat(64) },
    },
  }));
});
