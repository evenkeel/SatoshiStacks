/* Fit the whole desktop table, including the seats outside its rail. */
(() => {
  'use strict';
  if (document.body.classList.contains('is-mobile')) return;
  const area = document.getElementById('tableArea');
  const header = document.querySelector('.account-bar');
  if (!area || !header) return;
  const panels = [...document.querySelectorAll('.chat-box, .controls-area, .pre-action-bar, .table-actions-bar')];
  // An octagonal envelope includes the rail, dealer, avatars and nameplates,
  // while leaving the lower corners available for chat and betting controls.
  const envelopeWidth = 1220;
  const envelopeHeight = 780;
  function overlapsPanel(scale, top, panel) {
    const centerX = innerWidth / 2;
    const centerY = top + envelopeHeight * scale / 2;
    const low = Math.max(-390, (panel.top - 12 - centerY) / scale);
    const high = Math.min(390, (panel.bottom + 12 - centerY) / scale);
    if (low >= high) return false;
    const nearest = Math.max(low, Math.min(0, high));
    const halfWidth = 610 - Math.max(0, Math.abs(nearest) - 120) * 180 / 270;
    return panel.right + 12 > centerX - halfWidth * scale &&
      panel.left - 12 < centerX + halfWidth * scale;
  }
  let frame;
  function fit() {
    cancelAnimationFrame(frame);
    frame = requestAnimationFrame(() => {
      const uiScale = Math.min(1, innerWidth / 1200, innerHeight / 700);
      document.body.style.setProperty('--desktop-ui-scale', uiScale);
      const top = header.getBoundingClientRect().bottom + 8;
      const blockers = panels.filter(panel => {
        const style = getComputedStyle(panel);
        return style.display !== 'none' && style.visibility !== 'hidden';
      }).map(panel => panel.getBoundingClientRect()).filter(rect => rect.width > 0 && rect.height > 0);
      let low = 0;
      let high = Math.max(0, Math.min((innerWidth - 16) / envelopeWidth,
        (innerHeight - top - 12) / envelopeHeight));
      // The envelope grows from the top center, so each larger candidate
      // contains the previous one. Binary search finds the largest clear fit.
      for (let i = 0; i < 20; i++) {
        const candidate = (low + high) / 2;
        if (blockers.some(panel => overlapsPanel(candidate, top, panel))) high = candidate;
        else low = candidate;
      }
      const scale = Math.max(.01, low);
      area.style.top = `${top}px`;
      area.style.height = `${envelopeHeight * scale}px`;
      area.style.setProperty('--table-scale', scale);
      const badge = document.getElementById('spectatorBadge');
      const chat = document.querySelector('.chat-box');
      if (badge && chat) badge.style.bottom = `${innerHeight - chat.getBoundingClientRect().top + 4}px`;
    });
  }
  const observer = new ResizeObserver(fit);
  observer.observe(header);
  panels.forEach(panel => observer.observe(panel));
  const changes = new MutationObserver(fit);
  panels.forEach(panel => changes.observe(panel, { attributes: true, attributeFilter: ['class'] }));
  window.addEventListener('resize', fit);
  fit();
})();
