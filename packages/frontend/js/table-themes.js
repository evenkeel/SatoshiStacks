/* Themes own presentation only. No game state, socket, card, or seat mutations. */
(() => {
  'use strict';
  const assets = { felt: '/img/table-felt.svg?v=2', rail: '/img/table-rail.svg?v=2', logo: '/img/table-wordmark.svg?v=7' };
  // Register approved local assets here. Every theme uses the same table bounds.
  const themes = {
    bunker: { ...assets, name: 'Neon clubhouse', room: 'radial-gradient(ellipse 62% 54% at 50% 44%, #2f3f8a99, transparent 72%), radial-gradient(ellipse at 6% 8%, #f2652233, transparent 42%), radial-gradient(ellipse at 94% 10%, #5ae9ed24, transparent 44%), repeating-linear-gradient(45deg, #ffffff06 0 2px, transparent 2px 28px), repeating-linear-gradient(-45deg, #ffffff06 0 2px, transparent 2px 28px), linear-gradient(165deg, #1b2150, #111535 58%, #0b0e24)', accent: '#ffc72c', feltFilter: 'none', railFilter: 'none' },
    midnight: { ...assets, name: 'Midnight station', room: 'radial-gradient(ellipse at 50% 40%, #26395d, #101529 60%, #080b16)', accent: '#a8c8ff', feltFilter: 'hue-rotate(40deg) saturate(.8)', railFilter: 'hue-rotate(165deg) saturate(.5)' },
    classic: { ...assets, name: 'Classic club', room: 'radial-gradient(ellipse at 50% 40%, #493b2b, #211e1a 65%, #141310)', accent: '#e5c17a', feltFilter: 'hue-rotate(-40deg) saturate(.85)', railFilter: 'sepia(.65) saturate(.8)' },
  };
  const select = document.getElementById('tableTheme');
  const status = document.getElementById('themeStatus');
  const felt = document.querySelector('.table-felt');
  const rail = document.querySelector('.table-rail');
  const sign = document.querySelector('.table-neon-sign');
  if (!select || !felt || !rail || !sign) return;
  const storageKey = 'satoshistacks.room-theme.v1';
  let active = 'bunker';
  let request = 0;
  const loaded = new Map();
  function preload(src) {
    if (!loaded.has(src)) {
      const promise = new Promise((resolve, reject) => {
        const img = new Image();
        img.onload = resolve;
        img.onerror = () => reject(new Error('Artwork unavailable'));
        img.src = src;
      });
      loaded.set(src, promise);
      promise.catch(() => loaded.delete(src));
    }
    return loaded.get(src);
  }
  async function apply(id, persist = true) {
    const theme = themes[id];
    if (!theme) return;
    const current = ++request;
    status.textContent = 'Loading room artwork…';
    try {
      await Promise.all([theme.felt, theme.rail, theme.logo, theme.roomImage].filter(Boolean).map(preload));
      if (current !== request) return;
      // Commit together after loading; the current room stays visible on failure.
      felt.src = theme.felt;
      rail.src = theme.rail;
      sign.style.backgroundImage = `url("${theme.logo}")`;
      const style = document.body.style;
      style.setProperty('--theme-room', theme.roomImage ? `url("${theme.roomImage}") center / cover no-repeat, ${theme.room}` : theme.room);
      style.setProperty('--theme-accent', theme.accent);
      style.setProperty('--theme-felt-filter', theme.feltFilter);
      style.setProperty('--theme-rail-filter', theme.railFilter);
      document.body.dataset.roomTheme = id;
      active = id;
      select.value = id;
      status.textContent = `${theme.name} selected`;
      if (persist) { try { localStorage.setItem(storageKey, id); } catch {} }
    } catch {
      if (current !== request) return;
      select.value = active;
      status.textContent = 'Artwork could not load. Your current room is still selected.';
    }
  }
  select.addEventListener('change', () => apply(select.value));
  let saved;
  try { saved = localStorage.getItem(storageKey); } catch {}
  apply(Object.hasOwn(themes, saved) ? saved : 'bunker', false);
})();
