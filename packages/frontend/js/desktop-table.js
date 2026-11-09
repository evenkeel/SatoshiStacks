/* Fit the whole desktop table, including the seats outside its rail. */
(() => {
  'use strict';
  if (document.body.classList.contains('is-mobile')) return;
  const area = document.getElementById('tableArea');
  const header = document.querySelector('.account-bar');
  if (!area || !header) return;
  const panels = [...document.querySelectorAll('.chat-box, .controls-area, .pre-action-bar, .table-actions-bar')];
  let frame;
  function fit() {
    cancelAnimationFrame(frame);
    frame = requestAnimationFrame(() => {
      const uiScale = Math.min(1, innerWidth / 1200, innerHeight / 700);
      document.body.style.setProperty('--desktop-ui-scale', uiScale);
      // Measure visible utilities so chat, betting, and the rail have separate space.
      const top = header.getBoundingClientRect().bottom + 8;
      const panelTops = panels.filter(panel => {
        const style = getComputedStyle(panel);
        return style.display !== 'none' && style.visibility !== 'hidden';
      }).map(panel => panel.getBoundingClientRect().top);
      const bottom = Math.min(innerHeight - 12, ...panelTops) - 12;
      const height = Math.max(1, bottom - top);
      const scale = Math.min((innerWidth - 16) / 1220, height / 820);
      area.style.top = `${top}px`;
      area.style.height = `${height}px`;
      area.style.setProperty('--table-scale', Math.max(.01, scale));
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
