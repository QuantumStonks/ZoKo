const $ = (selector) => document.querySelector(selector);
const state = { token: null, role: null, me: null, sellers: [], quote: null, purchase: null, withdrawal: null, epoch: 0, running: false };
const titles = { overview: 'Overview', playground: 'Decision lab', wallet: 'Wallet', activity: 'Activity', operator: 'Operator' };
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
async function api(path, { method = 'GET', body, key, token = state.token, timeout = 30000 } = {}) {
  const epoch = state.epoch;
  const boundSession = token !== null && token === state.token;
  const response = await fetch(path, { method, headers: { Accept: 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}), ...(body === undefined ? {} : { 'Content-Type': 'application/json' }), ...(key ? { 'Idempotency-Key': key } : {}) }, body: body === undefined ? undefined : JSON.stringify(body), signal: AbortSignal.timeout(timeout), cache: 'no-store', redirect: 'error' });
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
function requireBuyer() { if (!state.token || state.role !== 'buyer') throw new Error('Connect a buyer or seller account to continue.'); }
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
  const target = $('#service-status'); target.className = `status-pill ${ready ? 'healthy' : 'unhealthy'}`;
  target.replaceChildren(node('i'), document.createTextNode(ready ? 'Service ready' : live ? 'Service needs attention' : 'Service unavailable'));
  target.title = ready ? 'The server readiness probe passed.' : 'The readiness probe has not passed. Check the operator runbook.';
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
  if (!state.sellers.length) { empty($('#catalog'), 'Your first seller starts here.', 'An operator can register a provider to publish its live offer.'); return; }
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
async function loadMe() { requireBuyer(); const epoch = state.epoch; const { data } = await api('/v1/me'); if (epoch !== state.epoch) return; state.me = data; renderAccount(); }
async function history() {
  requireBuyer(); const epoch = state.epoch; const { data } = await api('/v1/decisions?limit=50'); if (epoch !== state.epoch) return;
  const rows = data.decisions;
  if (!Array.isArray(rows)) throw new Error('Invalid request history response.');
  if (!rows.length) { empty($('#decision-history'), 'No decisions yet.', 'Make your first purchase in the decision lab.', '≋'); return; }
  $('#decision-history').replaceChildren(table(['Request', 'Status', 'Seller', 'Price', 'Created', 'Receipt'], rows.map((receipt) => { const button = node('button', 'Inspect ↗', 'text-button'); button.addEventListener('click', () => busy(button, () => inspectReceipt(receipt.id))); return [node('span', short(receipt.id), 'table-id'), statusTag(receipt.status), receipt.sellerId, `${money(receipt.priceNanos)} XEC`, when(receipt.createdAt), button]; })));
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
async function refreshBuyer() { const results = await Promise.allSettled([loadMe(), history(), withdrawals()]); results.forEach((result) => { if (result.status === 'rejected') toast(errorText(result.reason)); }); }
function clearSession() {
  state.token = null; state.role = null; state.me = null; state.quote = null; state.purchase = null; state.withdrawal = null; state.epoch++; state.running = false;
  $('#receipt-dialog').close(); $('#withdrawal-dialog').close(); $('#withdrawal-button').textContent = 'Review withdrawal →'; $('#connection-token').value = ''; $('#seller-api-key').value = ''; $('#new-account-secret').textContent = ''; $('#new-account-result').hidden = true; $('#operator-overview').textContent = ''; $('#audit-log').textContent = 'Select “Load audit log” to retrieve recent entries.'; $('#receipt-json').textContent = ''; $('#connect-button').textContent = 'Connect account ↗'; $('#operator-content').hidden = true; $('#operator-gate').hidden = false; $('#purchase-button').hidden = true; $('#resume-button').hidden = true; $('#quote-button').disabled = false;
  empty($('#decision-history'), 'Your request history lives here.', 'Connect an account to retrieve its decisions.', '≋'); empty($('#withdrawal-history'), 'No account connected.', 'Connect to retrieve your withdrawal history.', '▱'); empty($('#quote-result'), 'Know the cost before the call.', 'Your eligible seller, exact price and expiry will appear here.', '⌁'); empty($('#decision-result'), 'Ready when you are.', 'Validated answers and the server receipt appear after execution.', '⌘');
  for (const id of ['#decision-message', '#deposit-message', '#withdrawal-message', '#account-message', '#seller-message', '#admin-update-message']) message(id, '');
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
    else { state.me = data; renderAccount(); await refreshBuyer(); }
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
$('#deposit-claim-form').addEventListener('submit', (event) => { event.preventDefault(); void busy($('#deposit-claim-form button'), async () => { requireBuyer(); const { data } = await api('/v1/deposits/claim', { method: 'POST', body: { txid: $('#deposit-txid').value.trim() } }); message('#deposit-message', json(data)); await loadMe(); }, '#deposit-message'); });
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
$('#seller-form').addEventListener('submit', (event) => { event.preventDefault(); void busy($('#seller-form button[type="submit"]'), async () => { requireAdmin(); const body = { id: $('#seller-id').value.trim(), name: $('#seller-name').value.trim(), endpoint: $('#seller-endpoint').value.trim(), apiKey: $('#seller-api-key').value, model: $('#seller-model').value.trim(), priceNanos: parseMoney($('#seller-price').value), enabled: true, ...($('#seller-payout').value.trim() ? { payoutAccountId: $('#seller-payout').value.trim() } : {}) }; const { data } = await api('/v1/admin/sellers', { method: 'POST', body }); $('#seller-api-key').value = ''; message('#seller-message', json(data)); await Promise.all([overview(), catalog()]); }, '#seller-message'); });
$('#admin-update-form').addEventListener('submit', (event) => { event.preventDefault(); void busy($('#admin-update-form button'), async () => { requireAdmin(); let patch; try { patch = JSON.parse($('#admin-patch').value); } catch { throw new Error('Policy update must be valid JSON.'); } if (!patch || typeof patch !== 'object' || Array.isArray(patch)) throw new Error('Policy update must be a JSON object.'); const resource = $('#admin-resource').value; const { data } = await api(`/v1/admin/${resource}/${encodeURIComponent($('#admin-resource-id').value.trim())}`, { method: 'PATCH', body: patch }); message('#admin-update-message', json(data)); await Promise.all([overview(), catalog()]); }, '#admin-update-message'); });
$('#admin-resource').addEventListener('change', () => { $('#admin-patch').placeholder = $('#admin-resource').value === 'accounts' ? '{"disabled":true}' : '{"enabled":false}'; });
$('#refresh-audit').addEventListener('click', () => void busy($('#refresh-audit'), async () => { requireAdmin(); const { data } = await api('/v1/admin/audit'); $('#audit-log').textContent = json(data); }));
$('#refresh-overview').addEventListener('click', () => void busy($('#refresh-overview'), overview));
$('#refresh-history').addEventListener('click', () => void busy($('#refresh-history'), history));
$('#refresh-wallet').addEventListener('click', () => void busy($('#refresh-wallet'), async () => { requireBuyer(); await refreshBuyer(); }));
$('#refresh-catalog').addEventListener('click', () => void busy($('#refresh-catalog'), catalog));
addEventListener('pagehide', () => { clearSession(); });
addEventListener('beforeunload', (event) => { if ((state.purchase && !terminal(state.purchase.status)) || state.withdrawal?.submitted) { event.preventDefault(); event.returnValue = ''; } });
navigate();
void health();
void catalog().catch((error) => empty($('#catalog'), 'The catalog is unavailable.', errorText(error)));
setInterval(() => { if (!document.hidden) void health(); }, 45000);
