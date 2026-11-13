(function(root) {
  'use strict';
  const symbol = '₿';
  // Presentation only: numeric input values and server payloads stay numbers.
  function format(value) {
    const amount = Number(value || 0);
    return `${symbol}\u00a0${Number.isFinite(amount) ? amount.toLocaleString() : '0'}`;
  }
  const api = { symbol, format };
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.StacksAmounts = api;
})(typeof window === 'object' ? window : globalThis);
