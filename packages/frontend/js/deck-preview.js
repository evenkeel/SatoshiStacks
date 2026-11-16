/* Uses exactly the same renderer and card styles as the live table. */
(() => {
  const render = window.SatoshiDeck.renderCardHTML;
  document.getElementById('deckFeature').innerHTML = ['As', 'Ac', 'Kh', 'Qc', 'Jd', 'Th', '7s', null].map(c => render(c)).join('');
  // Pairs overlap by 8px exactly as opponents' shown hands do on the felt.
  document.getElementById('deckCompact').innerHTML = ['As', 'Ac', 'Th', 'Qd', '7c', '7s', null, null].map(c => render(c, 'small')).join('');
  document.getElementById('deckPhone').innerHTML = ['Ah', 'Ks', 'Qd', 'Jc', 'Tc', 'Ts'].map(c => render(c)).join('');
  document.getElementById('deckFull').innerHTML = ['s','c','h','d'].map(s => `<div class="deck-row">${'A23456789TJQK'.split('').map(r => render(r+s)).join('')}</div>`).join('');
})();
