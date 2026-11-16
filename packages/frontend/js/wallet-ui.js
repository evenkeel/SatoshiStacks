/* Pure wallet views shared by the app and isolated UI tests. No wallet calls. */
(function(root) {
  'use strict';
  const esc = value => String(value ?? '').replace(/[&<>"']/g, ch => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[ch]));
  const fmt = (typeof module === 'object' && module.exports ? require('./amounts') : root.StacksAmounts).format;
  const labels = { reserved:'Preparing payment', in_flight:'Payment pending', succeeded:'Paid', failed:'Restoring balance', refunded:'Returned to your balance' };
  function cashoutHTML(state) {
    const history = (state.payments || []).slice(0,5);
    const pending = (state.payments || []).filter(p => ['reserved','in_flight','failed'].includes(p.status));
    const reservedSats = state.pendingWithdrawalSats ?? pending.reduce((sum,p)=>sum+p.amount_sats,0);
    const connection = {
      disabled: 'Lightning payments are not enabled yet. Your account is ready; deposits and withdrawals will open when payments are enabled. Demo chips are separate and cannot be withdrawn.',
      offline: 'Lightning is temporarily unavailable. Your balance and activity remain recorded. Payments will be checked again automatically.',
      paused: 'Lightning payments are paused. Your balance and activity remain recorded.',
      ready: 'Lightning payments are connected.',
    }[state.lightningStatus];
    let body = `<p class="wallet-amount">Available account balance<br><b class="wallet-balance">${fmt(state.availableSats)} sats</b></p>`;
    if (state.userId) body += `<p class="wallet-status">Nostr account · ${esc(state.userId.slice(0,8))}…${esc(state.userId.slice(-8))}</p>`;
    if (connection) body += `<p class="wallet-status" role="status">${connection}</p>`;
    body += `<ul class="wallet-history" aria-label="Funds summary"><li><span>At this table</span><span>${fmt(state.tableStackSats || 0)} sats</span></li><li><span>Pending withdrawals</span><span>${fmt(reservedSats)} sats</span></li></ul>`;
    if (state.deposits?.some(row=>row.status==='pending' && !row.bolt11)) body += '<p class="wallet-status" role="status">We are checking your deposit invoice. Retry the deposit request to recover the same invoice. Your existing balance is unchanged.</p>';
    const hasInvoice = state.deposits?.some(row => row.status === 'pending' && row.bolt11 && row.expiresAt > Date.now()/1000);
    body += `<button class="wallet-btn secondary" data-action="account-deposit"${state.depositsEnabled ? '' : ' disabled'}>${hasInvoice ? 'View pending deposit' : 'Deposit sats'}</button>`;
    if (!state.depositsEnabled && state.lightningStatus === 'ready') body += '<p class="wallet-status">New deposits are paused.</p>';
    if (state.seated) body += `<p class="wallet-status">At this table: ${fmt(state.tableStackSats)} sats. ${state.canReturnStack ? 'Return your stack to your account before withdrawing these sats.' : 'Finish the current hand before returning your stack.'}</p><button class="wallet-btn secondary" data-action="return-table-stack">Return table stack to account</button>`;
    else if (state.canBuyIn !== false && !state.watchOnly && state.availableSats > 0) body += '<button class="wallet-btn secondary" data-action="account-buyin">Buy in at this table</button>';

    if (state.error) body += `<p class="wallet-status" role="status">${esc(state.error)}</p>`;
    else if (!state.withdrawalsEnabled) body += `<button class="wallet-btn secondary" disabled>Withdraw sats</button>${connection && state.lightningStatus !== 'ready' ? '' : '<p class="wallet-status" role="status">Withdrawals are temporarily unavailable. Your balance stays recorded. This view will check again automatically.</p>'}`;
    else if (state.availableSats > 0) body += `<div class="wallet-amount">Withdraw from your account</div><p class="wallet-status">Only your available account balance can be withdrawn. Sats at a table must be returned to your account first.</p>
      <label for="withdrawalAmount">Amount in sats</label><input id="withdrawalAmount" class="wallet-invoice-input" type="number" min="1" max="${Number(state.availableSats)}" step="1" value="${Number(state.availableSats)}">
      <button class="wallet-btn" data-action="confirm-cashout">Receive in Lightning wallet</button>
      <details class="wallet-alternative"><summary>Use an invoice from another wallet</summary>
        <label for="cashoutInvoice">Create an invoice for up to ${fmt(state.availableSats)} sats in your receiving wallet.</label>
        <textarea id="cashoutInvoice" class="wallet-invoice-input" rows="3" placeholder="Paste your Lightning invoice" autocomplete="off" spellcheck="false" maxlength="10000"></textarea>
        <button class="wallet-btn secondary" data-action="confirm-pasted-cashout">Withdraw to this invoice</button>
      </details>`;
    else if (!reservedSats) body += '<p class="wallet-status">No funds are available to withdraw.</p>';
    if (reservedSats > 0) body += `<p class="wallet-status" role="status">${fmt(reservedSats)} sats are reserved for a payment. We are checking its final status; a timeout does not mean it failed. You can close this window and return later. A pending payment cannot be sent again as a new withdrawal.</p>`;
    if (state.deposits?.length) body += `<h2 class="wallet-history-title">Pending deposits</h2><ul class="wallet-history">${state.deposits.map(row => `<li><span>${fmt(row.amount_sats)} sats</span><span>${row.status === 'pending' ? (row.bolt11 ? (row.expiresAt > Date.now()/1000 ? 'Awaiting payment' : 'Checking expiry') : 'Preparing invoice') : 'Confirming deposit'}</span></li>`).join('')}</ul><p class="wallet-status">Deposits become available only after Lightning confirms payment.</p>`;
    if (history.length) body += `<h2 class="wallet-history-title">Recent withdrawals</h2><ul class="wallet-history">${history.map(p=>`<li><span>${fmt(p.amount_sats)} sats</span><span>${esc(labels[p.status] || 'Checking status')}</span></li>`).join('')}</ul>`;
    if (state.transfers?.length) body += `<h2 class="wallet-history-title">Account activity</h2><ul class="wallet-history">${state.transfers.map(t => `<li><span>${esc(({deposit:'Deposit',table_buyin:'Table buy-in',table_cashout:'Returned from table',withdrawal_reserved:'Withdrawal reserved',withdrawal_refunded:'Withdrawal returned',recovered_credit:'Recovered balance',identifier_purchase:'Username purchase'})[t.kind] || t.kind)}</span><span>${fmt(t.amount_sats)} sats</span></li>`).join('')}</ul>`;
    if (!state.transfers?.length && !history.length && !state.deposits?.length) body += '<p class="wallet-status">No account activity yet.</p>';
    body += '<p class="wallet-status">SatoshiStacks holds these sats for you. Keep access to your Nostr signing key; it controls access to this account.</p>';
    return body + '<button class="login-back-btn" data-action="refresh-cashout">Refresh balance</button>';
  }
  const api = { cashoutHTML };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.StacksWalletUI = api;
})(typeof window !== 'undefined' ? window : globalThis);
