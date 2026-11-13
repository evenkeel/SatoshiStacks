/* Uses exactly the same renderer as the live table. */
(() => {
  const render = window.SatoshiDeck.renderCardHTML;
  document.getElementById('deckFeature').innerHTML = ['As', 'Kh', 'Qc', 'Jd', 'Th', '7s', null, null].map(c => render(c)).join('');
  document.getElementById('deckCompact').innerHTML = ['As', 'Th', 'Qc', '7d', null].map(c => render(c, 'small')).join('');
  document.getElementById('deckPhone').innerHTML = ['Ah', 'Ks', 'Qd', 'Jc', 'Ts'].map(c => render(c)).join('');
  document.getElementById('deckFull').innerHTML = ['s','h','c','d'].map(s => `<div class="deck-row">${'A23456789TJQK'.split('').map(r => render(r+s)).join('')}</div>`).join('');
})();
