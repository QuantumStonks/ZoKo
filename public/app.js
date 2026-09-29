import { cashtabFunding, createFundingRequest, parseFundingAmount, depositKey, observeDeposits, pollFunding } from '/cashtab.js';

const $ = (selector) => document.querySelector(selector);
const state = { token: null, role: null, me: null, sellers: [], ownOffers: [], offersAfter: null, offersNext: null, offersGeneration: 0, quote: null, purchase: null, withdrawal: null, funding: null, epoch: 0, running: false };
const titles = { overview: 'Overview', playground: 'Buyer lab', seller: 'Seller offers', wallet: 'Wallet', activity: 'Activity', operator: 'Operator' };
const terminal = (status) => !['pending', 'queued', 'calling', 'running', 'reserved'].includes(status);
const node = (tag, text, className) => { const element = document.createElement(tag); if (text !== undefined) element.textContent = text; if (className) element.className = className; return element; };
const json = (value) => JSON.stringify(value, null, 2);
const money = (raw) => {
  if (typeof raw !== 'string' || !/^-?\d+$/.test(raw)) return '—';
  const amount = BigInt(raw), absolute = amount < 0n ? -amount : amount;
  const integer = (absolute / 1_000_000_000n).toString().replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  const decimal = (absolute % 1_000_000_000n).toString().padStart(9, '0').replace(/0+$/, '');
  return `${amount < 0n ? '−' : ''}${integer}${decimal ? `.${decimal}` : ''}`;
};
const parseMoney = (value) => {
  const match = /^(0|[1-9]\d*)(?:\.(\d{1,9}))?$/.exec(value.trim());
  if (!match) throw new Error('Enter an exact XEC amount with at most nine decimal places.');
  const result = BigInt(match[1]) * 1_000_000_000n + BigInt((match[2] || '').padEnd(9, '0'));
  if (result.toString().length > 40) throw new Error('Amount exceeds the ledger limit.');
  return result.toString();
};
const short = (value) => typeof value === 'string' && value.length > 17 ? `${value.slice(0, 8)}…${value.slice(-5)}` : String(value ?? '—');
const when = (value) => { const date = new Date(value); return Number.isNaN(date.getTime()) ? '—' : date.toLocaleString(undefined, { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' }); };
class ApiError extends Error { constructor(status, data) { super(data?.error?.message ?? data?.message ?? (typeof data?.error === 'string' ? data.error : `Request failed (HTTP ${status}).`)); this.status = status; this.data = data; } }
async function api(path, { method = 'GET', body, key, token = state.token, timeout = 30000, signal } = {}) {
  const epoch = state.epoch;
  const boundSession = token !== null && token === state.token;
  const response = await fetch(path, { method, headers: { Accept: 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}), ...(body === undefined ? {} : { 'Content-Type': 'application/json' }), ...(key ? { 'Idempotency-Key': key } : {}) }, body: body === undefined ? undefined : JSON.stringify(body), signal: signal ? AbortSignal.any([AbortSignal.timeout(timeout), signal]) : AbortSignal.timeout(timeout), cache: 'no-store', redirect: 'error' });
  const text = await response.text();
  if (text.length > 2097152) throw new Error('The server response exceeded the console limit.');
  let data;
  try { data = text ? JSON.parse(text) : {}; } catch { throw new Error('The server returned an unreadable response.'); }
  if (boundSession && epoch !== state.epoch) throw new Error('The account changed before the response arrived. Reconnect to inspect its history.');
  if (!response.ok) throw new ApiError(response.status, data);
  return { data, status: response.status };
}
function message(id, content, error = false) { const target = $(id); target.hidden = !content; target.textContent = content ?? ''; target.classList.toggle('error', error); }
let toastTimer;
function toast(text) { clearTimeout(toastTimer); $('#toast').textContent = text; $('#toast').hidden = false; toastTimer = setTimeout(() => { $('#toast').hidden = true; }, 4500); }
function errorText(error) { return error instanceof Error ? error.message : 'The request could not be completed.'; }
async function busy(button, task, messageTarget) {
  if (button.disabled) return;
  button.disabled = true;
  if (messageTarget) message(messageTarget, '');
  try { await task(); } catch (error) { if (messageTarget) message(messageTarget, errorText(error), true); else toast(errorText(error)); }
  finally { button.disabled = false; }
}
function requireBuyer() { if (!state.token || state.role !== 'buyer') throw new Error('Connect an agent account to continue. It can buy decisions and publish offers.'); }
function requireAdmin() { if (!state.token || state.role !== 'admin') throw new Error('Connect with an operator token to continue.'); }
function empty(target, heading, description, glyph = '◈') { const wrap = node('div', undefined, 'empty-state compact'); wrap.append(node('span', glyph, 'empty-glyph'), node('h3', heading), node('p', description)); target.replaceChildren(wrap); }
function details(entries) { const list = node('dl', undefined, 'details-list'); for (const [label, value] of entries) { const row = node('div'); row.append(node('dt', label), node('dd', String(value ?? '—'))); list.append(row); } return list; }
function statusTag(value) { const status = String(value ?? 'unknown'); return node('span', status.replaceAll('_', ' '), `status-tag ${/fail|refund|reject|indeterminate/.test(status) ? 'failed' : terminal(status) ? '' : 'pending'}`); }
function table(headers, rows) { const element = node('table'); const head = node('thead'); const headRow = node('tr'); headers.forEach((value) => headRow.append(node('th', value))); head.append(headRow); const body = node('tbody'); rows.forEach((row) => { const tr = node('tr'); row.forEach((value) => { const td = node('td'); value instanceof Node ? td.append(value) : td.textContent = String(value ?? '—'); tr.append(td); }); body.append(tr); }); element.append(head, body); return element; }
function navigate() { const view = location.hash.slice(1); const selected = titles[view] ? view : 'overview'; for (const key of Object.keys(titles)) $(`#view-${key}`).hidden = key !== selected; document.querySelectorAll('[data-view]').forEach((item) => { const active = item.dataset.view === selected; item.classList.toggle('active', active); if (active) item.setAttribute('aria-current', 'page'); else item.removeAttribute('aria-current'); }); $('#current-view').textContent = titles[selected]; document.title = `${titles[selected]} — Zoko`; }
addEventListener('hashchange', navigate);
document.querySelectorAll('[data-close]').forEach((button) => button.addEventListener('click', () => $(`#${button.dataset.close}`).close()));
$('#connect-button').addEventListener('click', () => { $('#disconnect-button').hidden = !state.token; $('#connection-role').value = state.role ?? 'buyer'; $('#connect-dialog').showModal(); });

async function health() {
  const checks = await Promise.allSettled([api('/health/live', { token: null, timeout: 8000 }), api('/health/ready', { token: null, timeout: 10000 })]);
  const live = checks[0].status === 'fulfilled'; const ready = checks[1].status === 'fulfilled';
  const tradingReady = ready && checks[1].value.data.tradingReady !== false;
  const target = $('#service-status'); target.className = `status-pill ${ready ? 'healthy' : 'unhealthy'}`;
  target.replaceChildren(node('i'), document.createTextNode(ready ? (tradingReady ? 'Marketplace ready' : 'Awaiting seller offers') : live ? 'Service needs attention' : 'Service unavailable'));
  target.title = ready ? (tradingReady ? 'Infrastructure is ready and approved seller offers are available.' : 'Infrastructure is ready. Trading starts when an approved seller offer is available.') : 'The readiness probe has not passed. Check the operator runbook.';
}
async function catalog() {
  const { data } = await api('/v1/catalog', { token: null });
  if (!Array.isArray(data.sellers)) throw new Error('Invalid catalog response.');
  state.sellers = data.sellers;
  $('#seller-count').textContent = String(state.sellers.filter((seller) => seller.available).length);
  const oldFilter = $('#seller-filter').value;
  $('#seller-filter').replaceChildren(node('option', 'Lowest eligible price'));
  $('#seller-filter').firstChild.value = '';
  for (const seller of state.sellers) { if (!seller.available) continue; const option = node('option', `${seller.name} · ${money(seller.priceNanos)} XEC`); option.value = seller.id; $('#seller-filter').append(option); }
  $('#seller-filter').value = oldFilter;
  if (!state.sellers.length) { empty($('#catalog'), 'The market is waiting for seller agents.', 'Connect an agent account to submit an offer. Approved offers appear here.'); return; }
  $('#catalog').replaceChildren(...state.sellers.map((seller) => {
    const card = node('article', undefined, 'seller-card');
    const top = node('div', undefined, 'seller-card-top'); top.append(node('span', (seller.name?.[0] ?? 'Z').toUpperCase(), 'seller-icon'), node('span', seller.available ? 'AVAILABLE' : 'UNAVAILABLE', `badge ${seller.available ? 'available' : 'unavailable'}`));
    const tags = node('div', undefined, 'seller-tags'); (seller.questionTypes ?? []).forEach((type) => tags.append(node('span', String(type).toUpperCase(), 'tag')));
    const priceRow = node('div', undefined, 'seller-price-row'); const price = node('div', money(seller.priceNanos), 'seller-price'); price.append(node('small', ' XEC / call'));
    const select = node('button', 'Use seller ↗', 'text-button'); select.disabled = !seller.available; select.addEventListener('click', () => { $('#seller-filter').value = seller.id; invalidateQuote(); location.hash = 'playground'; }); priceRow.append(price, select);
    card.append(top, node('h3', seller.name), node('div', seller.model, 'seller-model'), tags, priceRow);
    const stats = node('div', undefined, 'seller-stats');
    if (seller.completed !== undefined) stats.append(node('span', `${seller.completed} completed`));
    if (seller.p95LatencyMs !== null && seller.p95LatencyMs !== undefined) stats.append(node('span', `p95 ${seller.p95LatencyMs} ms`));
    if (stats.childNodes.length) card.append(stats);
    return card;
  }));
}
function ownOfferCard(offer) {
  if (!offer || typeof offer.id !== 'string' || !/^[a-z0-9][a-z0-9_-]{0,63}$/.test(offer.id) || typeof offer.enabled !== 'boolean' || typeof offer.paused !== 'boolean') throw new Error('The server returned an invalid seller offer.');
  const card = node('article', undefined, 'panel owned-offer');
  const heading = node('div', undefined, 'panel-heading');
  heading.append(node('h2', offer.name), node('span', offer.enabled ? 'APPROVED' : 'NOT APPROVED', `badge ${offer.enabled ? 'available' : 'unavailable'}`));
  const commission = Number.isInteger(offer.commissionBps) && offer.commissionBps >= 0 && offer.commissionBps <= 10000 ? `${(offer.commissionBps / 100).toFixed(2).replace(/\.?0+$/, '')}%` : '—';
  card.append(heading, details([['Offer ID', offer.id], ['Delivery', offer.deliveryMode === 'agent' ? 'Active agent session' : 'HTTPS endpoint'], ['Endpoint', offer.endpoint ?? 'Not required'], ['Model', offer.model], ['Current price', `${money(offer.priceNanos)} XEC`], ['Marketplace commission', commission], ['Seller account', offer.payoutAccountId], ['Seller pause', offer.paused ? 'Paused' : 'Not paused']]));
  if (!offer.enabled) card.append(node('p', 'This offer is not approved for the buyer catalog. The operator controls approval; your pause setting is separate.', 'form-note'));
  const form = node('form', undefined, 'own-offer-form');
  const priceId = `own-price-${offer.id}`, credentialId = `own-key-${offer.id}`, pausedId = `own-paused-${offer.id}`;
  const priceLabel = node('label', 'Price per decision · XEC'); priceLabel.htmlFor = priceId;
  const price = node('input'); price.id = priceId; price.required = true; price.inputMode = 'decimal'; price.value = money(offer.priceNanos).replaceAll(',', ''); price.autocomplete = 'off';
  const credentialLabel = node('label', 'Rotate endpoint API key'); credentialLabel.htmlFor = credentialId;
  const credential = node('input'); credential.id = credentialId; credential.type = 'password'; credential.autocomplete = 'off'; credential.maxLength = 4096; credential.placeholder = 'Leave empty to keep the current key'; credential.spellcheck = false;
  const pausedLabel = node('label', undefined, 'checkbox-label'); pausedLabel.htmlFor = pausedId;
  const paused = node('input'); paused.id = pausedId; paused.type = 'checkbox'; paused.checked = offer.paused; pausedLabel.append(paused, document.createTextNode('Pause this offer for new purchases'));
  const save = node('button', 'Save offer settings', 'button outline full'); save.type = 'submit';
  form.append(priceLabel, price);
  if (offer.deliveryMode !== 'agent') form.append(credentialLabel, credential);
  form.append(pausedLabel, save);
  form.addEventListener('submit', (event) => {
    event.preventDefault(); void busy(save, async () => {
      requireBuyer(); const priceNanos = parseMoney(price.value); if (BigInt(priceNanos) <= 0n) throw new Error('An offer price must be positive.');
      const changes = { priceNanos, paused: paused.checked, ...(credential.value ? { apiKey: credential.value } : {}) };
      const epoch = state.epoch; price.disabled = true; credential.disabled = true; paused.disabled = true;
      try {
        const { data } = await api(`/v1/seller/offers/${encodeURIComponent(offer.id)}`, { method: 'PATCH', body: changes });
        if (epoch !== state.epoch) return;
        credential.value = ''; state.ownOffers = state.ownOffers.map((existing) => existing.id === data.id ? data : existing); card.replaceWith(ownOfferCard(data));
        toast('Offer settings saved.'); await catalog();
      } finally { price.disabled = false; credential.disabled = false; paused.disabled = false; }
    });
  });
  card.append(form); return card;
}
async function loadOffers(after = state.offersAfter) {
  requireBuyer(); const epoch = state.epoch, generation = ++state.offersGeneration;
  const { data } = await api(`/v1/seller/offers?limit=100${after ? `&after=${encodeURIComponent(after)}` : ''}`);
  if (epoch !== state.epoch || generation !== state.offersGeneration) return;
  if (!Array.isArray(data.offers) || !(data.nextCursor === null || typeof data.nextCursor === 'string')) throw new Error('The server returned an invalid offer page.');
  state.ownOffers = data.offers; state.offersAfter = after; state.offersNext = data.nextCursor;
  if (data.offers.length) $('#owned-offers').replaceChildren(...data.offers.map(ownOfferCard));
  else empty($('#owned-offers'), 'No offers on this page.', 'Submit your agent endpoint below to create a seller-owned offer.', '◇');
  $('#offer-page-note').textContent = `Showing ${data.offers.length} ${data.offers.length === 1 ? 'offer' : 'offers'}${after ? ' after the selected cursor' : ''}.`;
  $('#offers-first').hidden = !after; $('#offers-next').hidden = !data.nextCursor;
  message('#offer-list-message', '');
}
$('#refresh-offers').addEventListener('click', () => void busy($('#refresh-offers'), () => loadOffers(), '#offer-list-message'));
$('#offers-first').addEventListener('click', () => void busy($('#offers-first'), () => loadOffers(null), '#offer-list-message'));
$('#offers-next').addEventListener('click', () => { if (state.offersNext) void busy($('#offers-next'), () => loadOffers(state.offersNext), '#offer-list-message'); });
$('#offer-form').addEventListener('submit', (event) => {
  event.preventDefault(); void busy($('#submit-offer'), async () => {
    requireBuyer(); const priceNanos = parseMoney($('#offer-price').value); if (BigInt(priceNanos) <= 0n) throw new Error('An offer price must be positive.');
    const endpoint = $('#offer-endpoint').value.trim(), parsed = new URL(endpoint);
    if (parsed.protocol !== 'https:' || parsed.username || parsed.password || parsed.hash) throw new Error('Use an HTTPS agent endpoint without URL credentials or a fragment.');
    const body = { id: $('#offer-id').value.trim(), name: $('#offer-name').value.trim(), endpoint, model: $('#offer-model').value.trim(), priceNanos, apiKey: $('#offer-api-key').value };
    const epoch = state.epoch; const { data } = await api('/v1/seller/offers', { method: 'POST', body }); if (epoch !== state.epoch) return;
    $('#offer-form').reset(); message('#offer-message', `Offer ${data.id} was submitted for operator approval. Earnings belong to your connected account. It will enter the buyer catalog after approval and while unpaused.`);
    await loadOffers(null);
  }, '#offer-message');
});
function renderAccount() {
  const data = state.me;
  if (!data) {
    for (const id of ['#balance-value', '#reserved-value']) $(id).replaceChildren(document.createTextNode('— '), node('span', 'XEC'));
    $('#balance-note').textContent = 'Connect an account to see your funds.';
    $('#wallet-summary').replaceChildren(node('p', 'Connect a buyer account to view balances and spending policy.', 'muted'));
    $('#deposit-address-result').hidden = true;
    $('#deposit-address').value = '';
    $('#withdrawal-fee').textContent = 'Connect to see withdrawal availability and fees.';
    return;
  }
  $('#balance-value').replaceChildren(document.createTextNode(`${money(data.balanceNanos)} `), node('span', 'XEC'));
  $('#reserved-value').replaceChildren(document.createTextNode(`${money(data.reservedNanos)} `), node('span', 'XEC'));
  $('#balance-note').textContent = `${data.account.name} · prepaid eCash balance`;
  const blocks = [ ['Available', data.balanceNanos], ['Reserved', data.reservedNanos], ['Daily limit', data.account.dailyLimitNanos], ['Per-call limit', data.account.maxPriceNanos], ['Spent today', data.spending.spentNanos], ['Daily budget reserved', data.spending.reservedNanos] ];
  $('#wallet-summary').replaceChildren(...blocks.map(([label, amount]) => { const block = node('div', undefined, 'summary-block'); block.append(node('span', label), node('strong', money(amount)), node('small', 'XEC')); return block; }));
  if (data.depositAddress) renderAddress(data.depositAddress);
  const payments = data.payments ?? {};
  const fee = payments.maximumWithdrawalFeeNanos ?? payments.maxWithdrawalFeeNanos;
  $('#withdrawal-fee').textContent = fee ? `Maximum network fee: ${money(fee)} XEC, added to the amount sent.${payments.minWithdrawalNanos ? ` Minimum withdrawal: ${money(payments.minWithdrawalNanos)} XEC.` : ''}` : 'Fee limits are enforced by the server. Withdrawal review requires the configured maximum fee.';
  if (payments.withdrawalsEnabled === false || payments.enabled === false) $('#withdrawal-fee').textContent = 'Withdrawals are disabled in the current server configuration.';
}
function renderAddress(address) {
  if (typeof address !== 'string' || !/^(ecash|ectest|ecregtest):[a-z0-9]+$/.test(address)) throw new Error('The server returned an unsupported eCash address.');
  $('#deposit-address').value = address;
  $('#wallet-link').href = address;
  $('#deposit-address-result').hidden = false;
}
async function deposits() {
  requireBuyer(); const epoch = state.epoch; const { data } = await api('/v1/deposits?limit=100'); if (epoch !== state.epoch) return;
  observeDeposits(data.deposits);
  if (!data.deposits.length) { empty($('#deposit-history'), 'No deposits recorded yet.', 'Incoming payments appear here while Zoko verifies the network.', '▱'); return; }
  $('#deposit-history').replaceChildren(table(['Transaction', 'Output', 'Status', 'Amount', 'Confirmations', 'Credited'], data.deposits.map((record) => {
    const id = node('span', short(record.txid), 'table-id'); id.title = record.txid;
    return [id, record.vout, statusTag(record.status), `${money(record.amountNanos)} XEC`, record.confirmations ?? '—', record.creditedAt ? when(record.creditedAt) : '—'];
  })));
}
function resetFunding() {
  state.funding?.controller?.abort(); state.funding = null;
  $('#funding-preview').hidden = true; $('#funding-review').replaceChildren(); $('#funding-pay-link').removeAttribute('href'); $('#funding-pay-link').removeAttribute('aria-disabled');
  $('#funding-amount').disabled = false; $('#prepare-funding').disabled = false; $('#funding-cashtab').disabled = false; $('#funding-cashtab').hidden = true; $('#check-funding').hidden = true; $('#reset-funding').hidden = true;
  message('#funding-status', '');
}
function fundingControls(funding) {
  if (state.funding !== funding) return;
  $('#funding-amount').disabled = funding.submitted || funding.walletPending;
  $('#prepare-funding').disabled = funding.submitted || funding.walletPending;
  $('#funding-cashtab').hidden = !funding.extension;
  $('#funding-cashtab').disabled = funding.submitted || funding.walletPending;
  $('#funding-pay-link').className = funding.extension ? 'text-button funding-alternative' : 'button primary full';
  $('#funding-pay-link').textContent = funding.extension ? 'Open the mobile / web payment link ↗' : 'Pay with Cashtab ↗';
  $('#funding-pay-link').setAttribute('aria-disabled', String(funding.submitted || funding.walletPending));
  $('#cashtab-method').textContent = funding.extension ? 'EXTENSION READY' : 'MOBILE / WEB';
  $('#funding-wallet-note').textContent = funding.extension ? 'Cashtab will ask you to review and approve this exact destination and amount.' : 'The official pay.e.cash link opens Cashtab or its wallet payment page. Approve the payment there, then return to check funding.';
  $('#check-funding').hidden = !funding.submitted;
  $('#check-funding').disabled = funding.watching || funding.walletPending;
  $('#reset-funding').hidden = !funding.submitted;
  $('#reset-funding').disabled = funding.walletPending;
}
function renderFundingObservation(funding, observation) {
  if (state.funding !== funding) return;
  funding.observation = observation;
  const transaction = funding.txid ? ` Transaction ${funding.txid}.` : '';
  const tail = observation.timedOut ? ' Automatic checks have paused. Use “Check funding” later; do not pay again just because confirmation is pending.' : '';
  if (observation.status === 'credited') message('#funding-status', `Zoko has verified and credited ${money(observation.creditedNanos)} XEC to this account.${transaction}`);
  else if (observation.status === 'review') message('#funding-status', `A recorded deposit requires review. Inspect its status in deposit history or contact the operator.${transaction}`, true);
  else if (observation.status === 'pending') message('#funding-status', `${money(observation.observedNanos)} XEC is recorded on this account. ${money(observation.creditedNanos)} XEC is credited; the remaining deposit is awaiting network verification.${transaction}${tail}`);
  else message('#funding-status', `No matching deposit has been recorded yet. The wallet may still be awaiting approval or the network may still be indexing the payment.${transaction}${tail}`);
}
async function beginFundingWatch(funding) {
  if (state.funding !== funding || funding.watching || funding.epoch !== state.epoch) return;
  requireBuyer(); funding.controller?.abort(); funding.controller = new AbortController(); funding.watching = true; fundingControls(funding);
  try {
    const observation = await pollFunding({
      signal: funding.controller.signal, txid: funding.txid, baseline: funding.baseline,
      readDeposits: async (signal) => { const { data } = await api(`/v1/deposits?limit=100${funding.txid ? `&txid=${encodeURIComponent(funding.txid)}` : ''}`, { signal, timeout: 10000 }); return data.deposits; },
      onUpdate: (value) => { if (funding.epoch !== state.epoch) return; renderFundingObservation(funding, value); void loadMe().catch(() => {}); },
    });
    renderFundingObservation(funding, observation);
  } catch (error) {
    if (!funding.controller.signal.aborted && state.funding === funding) message('#funding-status', `Deposit verification could not be completed: ${errorText(error)} Check funding again before sending another payment.`, true);
  } finally {
    funding.watching = false;
    if (state.funding === funding && funding.epoch === state.epoch) { fundingControls(funding); void Promise.allSettled([loadMe(), deposits()]); }
  }
}
$('#funding-form').addEventListener('submit', (event) => {
  event.preventDefault(); void busy($('#prepare-funding'), async () => {
    requireBuyer(); if (state.funding?.walletPending || state.funding?.submitted) throw new Error('Check the existing top-up before preparing another payment.');
    const amount = parseFundingAmount($('#funding-amount').value);
    await loadMe(); if (state.me?.payments?.depositsEnabled !== true) throw new Error('Deposits are not currently ready. Ask the operator to check payment status.');
    const epoch = state.epoch;
    const [addressResult, historyResult, extension] = await Promise.all([api('/v1/deposit-address', { method: 'POST', body: {} }), api('/v1/deposits?limit=100'), cashtabFunding.available()]);
    if (epoch !== state.epoch) return;
    const request = createFundingRequest(addressResult.data.address ?? addressResult.data.depositAddress, amount.amountXec);
    observeDeposits(historyResult.data.deposits);
    resetFunding();
    const funding = { request, epoch, extension, baseline: new Set(historyResult.data.deposits.map(depositKey)), submitted: false, walletPending: false, watching: false, txid: undefined, controller: null };
    state.funding = funding; renderAddress(request.address);
    $('#funding-review').replaceChildren(details([['Amount to credit', `${money(request.amountNanos)} XEC`], ['Receiving account', state.me.account.name], ['Network', 'eCash mainnet'], ['Destination', request.address]]));
    $('#funding-pay-link').href = request.payUrl; $('#funding-preview').hidden = false; fundingControls(funding);
    message('#funding-status', 'Payment prepared. Review the destination and amount, then approve it in your wallet.');
  }, '#funding-status');
});
$('#funding-amount').addEventListener('input', () => { if (state.funding && !state.funding.submitted && !state.funding.walletPending) resetFunding(); });
$('#funding-cashtab').addEventListener('click', () => {
  const funding = state.funding;
  if (!funding || funding.submitted || funding.walletPending || funding.epoch !== state.epoch) return;
  funding.walletPending = true; fundingControls(funding); message('#funding-status', 'Review the top-up in Cashtab. This page is waiting for your wallet response.');
  void (async () => {
    requireBuyer(); const outcome = await cashtabFunding.send(funding.request);
    if (state.funding !== funding || funding.epoch !== state.epoch) return;
    funding.walletPending = false;
    if (outcome.kind === 'unavailable') { funding.extension = false; message('#funding-status', 'The Cashtab extension is unavailable. Use the official payment link below to review this top-up.'); }
    else if (outcome.kind === 'declined') message('#funding-status', `Cashtab declined the request: ${outcome.reason}`);
    else if (outcome.kind === 'busy') message('#funding-status', 'Another Cashtab approval is already in progress. Finish it before opening another payment.');
    else {
      funding.submitted = true;
      if (outcome.kind === 'submitted') {
        funding.txid = outcome.txid; $('#deposit-txid').value = outcome.txid;
        message('#funding-status', `Cashtab returned transaction ${outcome.txid}. Zoko is checking it on chain before crediting your account.`);
        try { await api('/v1/deposits/claim', { method: 'POST', body: { txid: outcome.txid } }); } catch { /* A callback is only a hint; indexed deposit history remains authoritative. */ }
      } else message('#funding-status', outcome.reason, true);
      if (state.funding === funding && funding.epoch === state.epoch) void beginFundingWatch(funding).catch((error) => message('#funding-status', errorText(error), true));
    }
    fundingControls(funding);
  })().catch((error) => { if (state.funding === funding) { funding.walletPending = false; fundingControls(funding); message('#funding-status', errorText(error), true); } });
});
$('#funding-pay-link').addEventListener('click', (event) => {
  const funding = state.funding;
  if (!funding || funding.submitted || funding.walletPending || funding.epoch !== state.epoch || state.role !== 'buyer') { event.preventDefault(); return; }
  funding.submitted = true; fundingControls(funding);
  // The ordinary, validated anchor performs the only wallet navigation. Never
  // open a second popup, parse URL success claims, or infer credit from return.
  void beginFundingWatch(funding).catch((error) => message('#funding-status', errorText(error), true));
});
$('#check-funding').addEventListener('click', () => { if (state.funding) void beginFundingWatch(state.funding).catch((error) => message('#funding-status', errorText(error), true)); });
$('#reset-funding').addEventListener('click', () => { if (state.funding?.walletPending) return; const wasPending = state.funding?.observation?.status !== 'credited'; resetFunding(); if (wasPending) message('#funding-status', 'The earlier payment may still arrive. Check deposit history before approving a separate top-up.'); $('#funding-amount').focus(); });
async function loadMe() { requireBuyer(); const epoch = state.epoch; const { data } = await api('/v1/me'); if (epoch !== state.epoch) return; state.me = data; renderAccount(); }
async function history() {
  requireBuyer(); const epoch = state.epoch; const { data } = await api('/v1/decisions?limit=50'); if (epoch !== state.epoch) return;
  const rows = data.decisions;
  if (!Array.isArray(rows)) throw new Error('Invalid request history response.');
  if (!rows.length) { empty($('#decision-history'), 'No decisions yet.', 'Make your first purchase in the decision lab.', '≋'); return; }
  $('#decision-history').replaceChildren(table(['Request', 'Status', 'Seller', 'Quoted price', 'Created', 'Receipt'], rows.map((receipt) => { const button = node('button', 'Inspect ↗', 'text-button'); button.addEventListener('click', () => busy(button, () => inspectReceipt(receipt.id))); return [node('span', short(receipt.id), 'table-id'), statusTag(receipt.status), receipt.sellerId, `${money(receipt.priceNanos)} XEC`, when(receipt.createdAt), button]; })));
}
async function withdrawals() {
  requireBuyer(); const epoch = state.epoch; const { data } = await api('/v1/withdrawals'); if (epoch !== state.epoch) return;
  const rows = Array.isArray(data) ? data : data.withdrawals;
  if (!Array.isArray(rows)) throw new Error('Invalid withdrawal history response.');
  if (!rows.length) { empty($('#withdrawal-history'), 'No withdrawals yet.', 'Your on-chain settlement requests appear here.', '▱'); return; }
  $('#withdrawal-history').replaceChildren(table(['Withdrawal', 'Status', 'Amount', 'Network fee', 'Destination', 'Transaction'], rows.map((row) => [node('span', short(row.id), 'table-id'), statusTag(row.status), `${money(row.amountNanos ?? row.amount_nanos)} XEC`, `${money(row.feeNanos ?? row.fee_nanos)} XEC`, node('span', short(row.address), 'table-id'), node('span', short(row.txid), 'table-id')])));
}
async function inspectReceipt(id) { const { data } = await api(`/v1/decisions/${encodeURIComponent(id)}`); $('#receipt-json').textContent = json(data); $('#receipt-dialog').showModal(); }
async function overview() { requireAdmin(); const epoch = state.epoch; const { data } = await api('/v1/admin/overview'); if (epoch === state.epoch) $('#operator-overview').textContent = json(data); }
async function refreshBuyer() { const results = await Promise.allSettled([loadMe(), history(), withdrawals(), deposits()]); results.forEach((result) => { if (result.status === 'rejected') toast(errorText(result.reason)); }); }
function clearSession() {
  resetFunding();
  state.token = null; state.role = null; state.me = null; state.ownOffers = []; state.offersAfter = null; state.offersNext = null; state.quote = null; state.purchase = null; state.withdrawal = null; state.epoch++; state.running = false;
  $('#seller-content').hidden = true; $('#seller-access-gate').hidden = false; $('#refresh-offers').disabled = true; $('#offer-api-key').value = ''; $('#owned-offers').replaceChildren(); $('#offers-first').hidden = true; $('#offers-next').hidden = true; $('#offer-page-note').textContent = ''; $('#receipt-dialog').close(); $('#withdrawal-dialog').close(); $('#withdrawal-button').textContent = 'Review withdrawal →'; $('#connection-token').value = ''; $('#seller-api-key').value = ''; $('#new-account-secret').textContent = ''; $('#new-account-result').hidden = true; $('#operator-overview').textContent = ''; $('#audit-log').textContent = 'Select “Load audit log” to retrieve recent entries.'; $('#receipt-json').textContent = ''; $('#connect-button').textContent = 'Connect account ↗'; $('#operator-content').hidden = true; $('#operator-gate').hidden = false; $('#purchase-button').hidden = true; $('#resume-button').hidden = true; $('#quote-button').disabled = false;
  empty($('#deposit-history'), 'No account connected.', 'Connect to retrieve verified and pending deposits.', '▱'); empty($('#decision-history'), 'Your request history lives here.', 'Connect an account to retrieve its decisions.', '≋'); empty($('#withdrawal-history'), 'No account connected.', 'Connect to retrieve your withdrawal history.', '▱'); empty($('#quote-result'), 'Know the cost before the call.', 'Your eligible seller, exact price and expiry will appear here.', '⌁'); empty($('#decision-result'), 'Ready when you are.', 'Validated answers and the server receipt appear after execution.', '⌘');
  for (const id of ['#decision-message', '#deposit-message', '#withdrawal-message', '#account-message', '#seller-message', '#admin-update-message', '#offer-message', '#offer-list-message']) message(id, '');
  renderAccount();
}
$('#connect-form').addEventListener('submit', (event) => {
  event.preventDefault(); const button = $('#connect-form button[type="submit"]');
  void busy(button, async () => {
    const role = $('#connection-role').value; const token = $('#connection-token').value.trim(); if (!token) throw new Error('Enter an API token.');
    const { data } = await api(role === 'admin' ? '/v1/admin/overview' : '/v1/me', { token });
    clearSession(); state.token = token; state.role = role;
    $('#connect-button').textContent = role === 'admin' ? 'Operator connected' : data.account.name;
    $('#connect-dialog').close(); $('#connection-token').value = '';
    if (role === 'admin') { $('#operator-content').hidden = false; $('#operator-gate').hidden = true; $('#operator-overview').textContent = json(data); location.hash = 'operator'; }
    else { state.me = data; renderAccount(); $('#seller-content').hidden = false; $('#seller-access-gate').hidden = true; $('#refresh-offers').disabled = false; await Promise.all([refreshBuyer(), loadOffers(null).catch((error) => message('#offer-list-message', errorText(error), true))]); }
    toast('Account connected. Token held in this tab only.');
  }, '#connect-message');
});
$('#disconnect-button').addEventListener('click', () => { clearSession(); $('#connect-dialog').close(); toast('Disconnected. Credentials cleared.'); });

function readInput() {
  const raw = $('#decision-state').value.trim(); if (!raw) throw new Error('Provide a state for the decision.');
  let inputState = raw; try { inputState = JSON.parse(raw); } catch { /* Non-JSON state is an intentional plain-text input. */ }
  if (inputState === null || (!['string', 'object'].includes(typeof inputState))) throw new Error('State must be text, a JSON object, or a JSON array.');
  let questions; try { questions = JSON.parse($('#decision-questions').value); } catch { throw new Error('Questions must be valid JSON.'); }
  if (!questions || typeof questions !== 'object' || Array.isArray(questions) || Object.keys(questions).length < 1 || Object.keys(questions).length > 20) throw new Error('Provide an object with 1–20 named questions.');
  const input = { state: inputState, questions };
  if (new TextEncoder().encode(JSON.stringify(input)).length > 32768) throw new Error('Decision input must be at most 32 KiB.');
  return input;
}
function invalidateQuote() { if (state.purchase && !terminal(state.purchase.status)) return; state.quote = null; $('#purchase-button').hidden = true; if ($('#quote-result .quote-cost')) empty($('#quote-result'), 'Request changed.', 'Get a fresh quote for this input.', '⌁'); }
$('#decision-form').addEventListener('input', invalidateQuote);
$('#decision-form').addEventListener('submit', (event) => {
  event.preventDefault(); void busy($('#quote-button'), async () => {
    requireBuyer(); if (state.purchase && !terminal(state.purchase.status)) throw new Error('Resolve the original purchase before preparing another one.');
    const input = readInput(); const policy = { maxPriceNanos: parseMoney($('#max-price').value), maxLatencyMs: Number($('#max-latency').value), minConfidence: Number($('#min-confidence').value), ...($('#seller-filter').value ? { allowedSellers: [$('#seller-filter').value] } : {}) };
    const epoch = state.epoch; const { data: quote } = await api('/v1/quotes', { method: 'POST', body: { ...input, policy } }); if (epoch !== state.epoch) return;
    state.quote = { ...quote, input }; state.purchase = null; $('#resume-button').hidden = true;
    const cost = node('div', money(quote.priceNanos), 'quote-cost'); cost.append(node('span', 'XEC / decision'));
    $('#quote-result').className = ''; $('#quote-result').replaceChildren(node('span', 'BOUND QUOTE', 'badge available'), cost, details([['Seller', quote.sellerId], ['Timeout', `${quote.timeoutMs} ms`], ['Minimum confidence', quote.minConfidence], ['Billing', 'All schema-valid responses, including low confidence'], ['Expires', new Date(quote.expiresAt).toLocaleTimeString()], ['Quote ID', short(quote.id)]]));
    $('#purchase-button').textContent = `Purchase for ${money(quote.priceNanos)} XEC →`; $('#purchase-button').hidden = false;
    message('#decision-message', 'Quote ready. Review its price before purchasing.');
  }, '#decision-message');
});
function renderReceipt(receipt) {
  const target = $('#decision-result'); target.className = ''; const fragments = [statusTag(receipt.status)];
  if (receipt.result?.answers) for (const [id, answer] of Object.entries(receipt.result.answers)) {
    const card = node('div', undefined, 'answer-card'); const top = node('div', undefined, 'answer-top'); top.append(node('span', id), node('span', answer.type));
    const value = answer.type === 'noul' ? `P(true) = ${answer.noul}` : answer.type === 'choice' ? answer.choice : String(answer.score);
    card.append(top, node('div', value, 'answer-value'));
    if (answer.type === 'noul') card.append(node('div', `Derived confidence: ${Math.max(answer.noul, 1 - answer.noul).toFixed(3)}`, 'answer-confidence'));
    else if (typeof answer.confidence === 'number') card.append(node('div', `Provider confidence: ${answer.confidence.toFixed(3)}`, 'answer-confidence'));
    fragments.push(card);
  }
  fragments.push(details([['Request', receipt.id], ['Seller', receipt.sellerId], ['Quoted price', `${money(receipt.priceNanos)} XEC`], ['Meets confidence policy', receipt.accepted === true ? 'Yes' : receipt.accepted === false ? 'No · review result' : '—'], ['Latency', receipt.latencyMs == null ? '—' : `${receipt.latencyMs} ms`]]));
  if (receipt.error) fragments.push(node('p', typeof receipt.error === 'string' ? receipt.error : json(receipt.error), 'form-note'));
  const inspect = node('button', 'Inspect full receipt ↗', 'text-button'); inspect.addEventListener('click', () => { $('#receipt-json').textContent = json(receipt); $('#receipt-dialog').showModal(); }); fragments.push(inspect);
  target.replaceChildren(...fragments);
}
async function executePurchase() {
  requireBuyer(); if (state.running) return;
  if (!state.purchase) {
    if (!state.quote) throw new Error('Prepare a quote first.');
    if (Date.parse(state.quote.expiresAt) <= Date.now()) { invalidateQuote(); throw new Error('This quote expired. Get a fresh quote before purchasing.'); }
    state.purchase = { quoteId: state.quote.id, input: structuredClone(state.quote.input), key: crypto.randomUUID(), status: 'pending', id: null };
  }
  const purchase = state.purchase, epoch = state.epoch; state.running = true;
  $('#quote-button').disabled = true; $('#purchase-button').hidden = true; $('#resume-button').hidden = true;
  message('#decision-message', `Purchase submitted. Recovery key: ${purchase.key}. The original request is retained until resolved.`);
  let failures = 0; const deadline = Date.now() + 120000;
  try {
    while (Date.now() < deadline) {
      if (epoch !== state.epoch) return;
      try {
        const response = purchase.id ? await api(`/v1/decisions/${encodeURIComponent(purchase.id)}`) : await api('/v1/decisions', { method: 'POST', body: { quoteId: purchase.quoteId, ...purchase.input }, key: purchase.key });
        if (epoch !== state.epoch) return;
        const receipt = response.data; if (!receipt.id || !receipt.status) throw new Error('The server returned an invalid decision receipt.');
        purchase.id = receipt.id; purchase.status = receipt.status; failures = 0;
        if (response.status !== 202 && terminal(receipt.status)) {
          renderReceipt(receipt); $('#quote-button').disabled = false; state.quote = null;
          message('#decision-message', receipt.status === 'succeeded' ? 'Decision delivered. Inspect the receipt and its confidence before using the answer.' : `Request is ${receipt.status}. Inspect the receipt for the terminal outcome.`, receipt.status !== 'succeeded');
          await refreshBuyer(); return;
        }
        message('#decision-message', `Request ${receipt.id} is ${receipt.status}. Waiting for its original result…`);
        await new Promise((resolve) => setTimeout(resolve, 1000));
      } catch (error) {
        if (epoch !== state.epoch) return;
        if (error instanceof ApiError && error.status < 500 && ![408, 425, 429].includes(error.status)) { purchase.status = 'rejected'; $('#quote-button').disabled = false; state.quote = null; throw error; }
        if (++failures >= 4) throw error;
        await new Promise((resolve) => setTimeout(resolve, Math.min(250 * 2 ** failures, 2000)));
      }
    }
    throw new Error('The request is still unresolved after two minutes.');
  } catch (error) {
    if (epoch !== state.epoch) return;
    if (!terminal(purchase.status)) { $('#resume-button').hidden = false; message('#decision-message', `${errorText(error)} Its outcome may already be recorded. Resume the original purchase using this button; do not make a second purchase. Request: ${purchase.id ?? 'not yet known'}. Recovery key: ${purchase.key}.`, true); }
    else { message('#decision-message', errorText(error), true); await refreshBuyer(); }
  } finally { if (epoch === state.epoch) state.running = false; }
}
$('#purchase-button').addEventListener('click', () => void executePurchase().catch((error) => message('#decision-message', errorText(error), true)));
$('#resume-button').addEventListener('click', () => void executePurchase().catch((error) => message('#decision-message', errorText(error), true)));

$('#deposit-address-button').addEventListener('click', () => void busy($('#deposit-address-button'), async () => { requireBuyer(); const { data } = await api('/v1/deposit-address', { method: 'POST', body: {} }); renderAddress(data.address ?? data.depositAddress); await loadMe(); }, '#deposit-message'));
$('#copy-address').addEventListener('click', () => void navigator.clipboard.writeText($('#deposit-address').value).then(() => toast('Address copied.')).catch(() => toast('Copy unavailable. Select and copy the address manually.')));
$('#deposit-claim-form').addEventListener('submit', (event) => { event.preventDefault(); void busy($('#deposit-claim-form button'), async () => { requireBuyer(); const txid = $('#deposit-txid').value.trim().toLowerCase(); const { data } = await api('/v1/deposits/claim', { method: 'POST', body: { txid } }); observeDeposits(data.deposits, { txid }); message('#deposit-message', json(data)); await Promise.all([loadMe(), deposits()]); if (state.funding?.submitted && !state.funding.watching) { state.funding.txid = txid; void beginFundingWatch(state.funding).catch((error) => message('#funding-status', errorText(error), true)); } }, '#deposit-message'); });
$('#withdrawal-form').addEventListener('input', () => { if (state.withdrawal?.submitted) return; state.withdrawal = null; });
$('#withdrawal-form').addEventListener('submit', (event) => {
  event.preventDefault(); void busy($('#withdrawal-button'), async () => {
    requireBuyer(); await loadMe();
    if (state.withdrawal?.submitted) { $('#withdrawal-dialog').showModal(); return; }
    const amountNanos = parseMoney($('#withdrawal-amount').value); if (BigInt(amountNanos) <= 0n || BigInt(amountNanos) % 10000000n !== 0n) throw new Error('Withdrawals must be positive whole on-chain atoms: at most two XEC decimal places.');
    const address = $('#withdrawal-address').value.trim(); if (!/^(ecash|ectest|ecregtest):[a-z0-9]+$/.test(address)) throw new Error('Enter a complete eCash address including its network prefix.');
    const payments = state.me.payments ?? {}; if (payments.withdrawalsEnabled === false || payments.enabled === false) throw new Error('Withdrawals are disabled on this server.');
    const fee = payments.maximumWithdrawalFeeNanos ?? payments.maxWithdrawalFeeNanos;
    if (typeof fee !== 'string' || !/^\d+$/.test(fee)) throw new Error('The configured maximum withdrawal fee is unavailable. Ask the operator to check payment readiness.');
    const maximumDebit = (BigInt(amountNanos) + BigInt(fee)).toString(); if (BigInt(maximumDebit) > BigInt(state.me.balanceNanos)) throw new Error('Available balance cannot cover the withdrawal and maximum network fee.');
    state.withdrawal = { body: { address, amountNanos }, key: crypto.randomUUID(), submitted: false };
    $('#withdrawal-review').replaceChildren(...details([['Network', payments.network ?? address.split(':')[0]], ['Destination', address], ['Amount sent', `${money(amountNanos)} XEC`], ['Maximum fee', `${money(fee)} XEC`], ['Maximum balance reserved', `${money(maximumDebit)} XEC`]]).children);
    $('#confirm-withdrawal').textContent = 'Confirm withdrawal'; $('#withdrawal-dialog').showModal();
  }, '#withdrawal-message');
});
$('#confirm-withdrawal').addEventListener('click', () => void busy($('#confirm-withdrawal'), async () => {
  requireBuyer(); if (!state.withdrawal) throw new Error('Review a withdrawal first.');
  const withdrawal = state.withdrawal; withdrawal.submitted = true;
  try {
    const { data } = await api('/v1/withdrawals', { method: 'POST', body: withdrawal.body, key: withdrawal.key });
    $('#withdrawal-dialog').close(); message('#withdrawal-message', json(data)); state.withdrawal = null; $('#withdrawal-address').value = ''; $('#withdrawal-amount').value = ''; $('#withdrawal-button').textContent = 'Review withdrawal →'; await refreshBuyer();
  } catch (error) {
    $('#withdrawal-dialog').close();
    if (error instanceof ApiError && error.status < 500 && ![408, 425, 429].includes(error.status)) state.withdrawal = null;
    else { $('#confirm-withdrawal').textContent = 'Retry original withdrawal'; $('#withdrawal-button').textContent = 'Resume original withdrawal →'; }
    throw new Error(`${errorText(error)}${state.withdrawal ? ` Retry the original request with this form. Recovery key: ${withdrawal.key}.` : ''}`);
  }
}, '#withdrawal-message'));

$('#account-form').addEventListener('submit', (event) => { event.preventDefault(); void busy($('#account-form button[type="submit"]'), async () => { requireAdmin(); const sellers = $('#account-sellers').value.split(',').map((value) => value.trim()).filter(Boolean); const { data } = await api('/v1/admin/accounts', { method: 'POST', body: { name: $('#account-name').value.trim(), dailyLimitNanos: parseMoney($('#account-daily').value), maxPriceNanos: parseMoney($('#account-max').value), ...(sellers.length ? { allowedSellers: sellers } : {}) } }); $('#new-account-secret').textContent = json(data); $('#new-account-result').hidden = false; await overview(); }, '#account-message'); });
$('#copy-account-secret').addEventListener('click', () => void navigator.clipboard.writeText($('#new-account-secret').textContent).then(() => toast('Issued credentials copied. Store them securely.')).catch(() => toast('Copy unavailable. Select and copy the credentials manually.')));
$('#clear-account-secret').addEventListener('click', () => { $('#new-account-secret').textContent = ''; $('#new-account-result').hidden = true; });
$('#seller-form').addEventListener('submit', (event) => { event.preventDefault(); void busy($('#seller-form button[type="submit"]'), async () => { requireAdmin(); const body = { id: $('#seller-id').value.trim(), name: $('#seller-name').value.trim(), endpoint: $('#seller-endpoint').value.trim(), apiKey: $('#seller-api-key').value, model: $('#seller-model').value.trim(), priceNanos: parseMoney($('#seller-price').value), enabled: true, payoutAccountId: $('#seller-payout').value.trim() }; const { data } = await api('/v1/admin/sellers', { method: 'POST', body }); $('#seller-api-key').value = ''; message('#seller-message', json(data)); await Promise.all([overview(), catalog()]); }, '#seller-message'); });
$('#admin-update-form').addEventListener('submit', (event) => { event.preventDefault(); void busy($('#admin-update-form button'), async () => { requireAdmin(); let patch; try { patch = JSON.parse($('#admin-patch').value); } catch { throw new Error('Policy update must be valid JSON.'); } if (!patch || typeof patch !== 'object' || Array.isArray(patch)) throw new Error('Policy update must be a JSON object.'); const resource = $('#admin-resource').value; const { data } = await api(`/v1/admin/${resource}/${encodeURIComponent($('#admin-resource-id').value.trim())}`, { method: 'PATCH', body: patch }); message('#admin-update-message', json(data)); await Promise.all([overview(), catalog()]); }, '#admin-update-message'); });
$('#admin-resource').addEventListener('change', () => { $('#admin-patch').placeholder = $('#admin-resource').value === 'accounts' ? '{"disabled":true}' : '{"enabled":true}'; });
$('#refresh-audit').addEventListener('click', () => void busy($('#refresh-audit'), async () => { requireAdmin(); const { data } = await api('/v1/admin/audit'); $('#audit-log').textContent = json(data); }));
$('#refresh-overview').addEventListener('click', () => void busy($('#refresh-overview'), overview));
$('#refresh-history').addEventListener('click', () => void busy($('#refresh-history'), history));
$('#refresh-wallet').addEventListener('click', () => void busy($('#refresh-wallet'), async () => { requireBuyer(); await refreshBuyer(); }));
$('#refresh-catalog').addEventListener('click', () => void busy($('#refresh-catalog'), catalog));
addEventListener('pagehide', () => { clearSession(); });
addEventListener('beforeunload', (event) => { if ((state.purchase && !terminal(state.purchase.status)) || state.withdrawal?.submitted || state.funding?.walletPending || state.funding?.watching) { event.preventDefault(); event.returnValue = ''; } });
navigate();
void health();
void catalog().catch((error) => empty($('#catalog'), 'The catalog is unavailable.', errorText(error)));
setInterval(() => { if (!document.hidden) void health(); }, 45000);
