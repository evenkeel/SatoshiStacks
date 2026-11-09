'use strict';

// Player exports include only their own private cards and cards publicly shown.
function playerHistory(text, player, handId) {
  const name = String(player.username).replace(/[\r\n\u0000-\u001f\u007f\u2028\u2029]/g, ' ');
  const lines = text.split('\n');
  const index = lines.indexOf('*** HOLE CARDS ***');
  const cards = typeof player.hole_cards === 'string' ? JSON.parse(player.hole_cards) : player.hole_cards;
  if (index !== -1 && cards?.length === 2) {
    lines.splice(index + 1, 0, `Dealt to ${name} [${cards.join(' ')}]`);
  }
  const history = lines.join('\n').trimEnd();
  return handId && !history.includes(handId) ? `Hand ID: ${handId}\n${history}` : history;
}
module.exports = { playerHistory };
