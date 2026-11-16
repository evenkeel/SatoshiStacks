/* Fit the desktop table: the largest scale, and the vertical position, at which
   its real silhouette clears the corner clusters and the player docks. The docks
   are reserved whether or not anyone is seated, so the table is one size for
   watching and for playing. Chat is then fitted into the corner that is left. */
(root => {
  'use strict';
  const GAP = 12;   // clearance around a dock or corner cluster
  const EDGE = 8;   // clearance from the window edge
  const TABLE_HEIGHT = 680;

  // The table's silhouette in its own units, measured from the centre of the
  // 1000 × 680 playfield: the rail, the dealer tray, six avatars with their turn
  // rings, and six nameplates with room for the tags that hang off them.
  // Keep in step with the desktop seat positions in the stylesheets.
  const SHAPES = [{ rx: 523, ry: 363 }, box(-104, -375, 104, -312)];
  for (const side of [-1, 1]) {
    SHAPES.push({ x: side * 500, y: 0, rx: 65, ry: 65 }, plate(side * 490, 40));
    for (const row of [-1, 1]) {
      SHAPES.push({ x: side * 280, y: row * 292, rx: 65, ry: 65 },
        row < 0 ? plate(side * 410, -335) : plate(side * 140, 250));
    }
  }
  function box(x0, y0, x1, y1) { return { x0, y0, x1, y1 }; }
  function plate(centerX, top) { return box(centerX - 84, top, centerX + 84, top + 96); }
  const bounds = SHAPES.reduce((all, shape) => {
    const b = shape.rx ? box((shape.x || 0) - shape.rx, (shape.y || 0) - shape.ry,
      (shape.x || 0) + shape.rx, (shape.y || 0) + shape.ry) : shape;
    return box(Math.min(all.x0, b.x0), Math.min(all.y0, b.y0), Math.max(all.x1, b.x1), Math.max(all.y1, b.y1));
  }, box(0, 0, 0, 0));

  // With the table centred on centerX at this scale, the open range of table
  // centre heights at which one shape would come within GAP of one panel.
  function blockedRange(shape, panel, centerX, scale) {
    const left = panel.left - GAP, right = panel.right + GAP;
    const top = panel.top - GAP, bottom = panel.bottom + GAP;
    if (!shape.rx) {
      if (centerX + shape.x1 * scale <= left || centerX + shape.x0 * scale >= right) return null;
      return [top - shape.y1 * scale, bottom - shape.y0 * scale];
    }
    const x = centerX + (shape.x || 0) * scale;
    const distance = Math.max(left - x, 0, x - right) / (shape.rx * scale);
    if (distance >= 1) return null;
    const reach = Math.sqrt(1 - distance * distance) * shape.ry * scale;
    const y = (shape.y || 0) * scale;
    return [top - reach - y, bottom + reach - y];
  }

  // The tallest clear band of centre heights at this scale, or null if none.
  function clearBand(width, height, panels, scale) {
    const centerX = width / 2;
    if (centerX + bounds.x0 * scale < EDGE || centerX + bounds.x1 * scale > width - EDGE) return null;
    const first = EDGE - bounds.y0 * scale, last = height - EDGE - bounds.y1 * scale;
    if (first > last) return null;
    const blocked = [];
    for (const panel of panels) {
      for (const shape of SHAPES) {
        const range = blockedRange(shape, panel, centerX, scale);
        if (range) blocked.push(range);
      }
    }
    blocked.sort((a, b) => a[0] - b[0]);
    let best = null, cursor = first;
    const offer = (from, to) => { if (to >= from && (!best || to - from > best[1] - best[0])) best = [from, to]; };
    for (const [from, to] of blocked) {
      if (from > cursor) offer(cursor, Math.min(from, last));
      cursor = Math.max(cursor, to);
      if (cursor > last) break;
    }
    if (cursor <= last) offer(cursor, last);
    return best;
  }

  // Largest table that fits a width × height window around the given panels
  // (viewport rectangles). The table stays centred across the window and rests
  // midway through whatever vertical room is left over.
  function fitTable(width, height, panels) {
    let low = 0, band = null;
    let high = Math.max(0, Math.min((width - 2 * EDGE) / (bounds.x1 - bounds.x0),
      (height - 2 * EDGE) / (bounds.y1 - bounds.y0)));
    for (let i = 0; i < 24; i++) {
      const candidate = (low + high) / 2;
      const clear = clearBand(width, height, panels, candidate);
      if (clear) { low = candidate; band = clear; } else high = candidate;
    }
    const scale = Math.max(.01, low);
    return { scale, centerY: band ? (band[0] + band[1]) / 2 : height / 2 };
  }

  // The betting dock sits in the bottom-right pocket beside the oval. Where that
  // pocket has room to spare, the dock grows into it for larger buttons, but
  // only as far as costs the table nothing. `dockAt(scale)` is the dock's
  // viewport rectangle at a given scale; returns that scale and the table fit.
  function fitDock(width, height, panels, dockAt, max = 1.5) {
    const around = scale => fitTable(width, height, [...panels, dockAt(scale)]);
    const floor = around(1).scale * .999;
    let low = 1, high = max;
    if (around(max).scale >= floor) low = max;
    else for (let i = 0; i < 10; i++) {
      const candidate = (low + high) / 2;
      if (around(candidate).scale >= floor) low = candidate; else high = candidate;
    }
    // Whole hundredths: a dock that could grow by a hair stays at its base size.
    const dock = Math.floor(low * 100) / 100;
    return { dock, fit: around(dock) };
  }

  // The lowest point of a fitted table above the window columns left..right,
  // or -Infinity where the table does not reach those columns at all.
  function tableBottomOver(width, { scale, centerY }, left, right) {
    const centerX = width / 2;
    let lowest = -Infinity;
    for (const shape of SHAPES) {
      if (!shape.rx) {
        if (centerX + shape.x1 * scale > left && centerX + shape.x0 * scale < right) lowest = Math.max(lowest, centerY + shape.y1 * scale);
        continue;
      }
      const x = centerX + (shape.x || 0) * scale;
      const distance = Math.max(left - x, 0, x - right) / (shape.rx * scale);
      if (distance < 1) lowest = Math.max(lowest, centerY + ((shape.y || 0) + Math.sqrt(1 - distance * distance) * shape.ry) * scale);
    }
    return lowest;
  }

  // Chat is fitted around the table, never the reverse. From the window's
  // bottom-left corner it takes the column the table leaves free: as wide as
  // `maxWidth` when there is room, narrower when a narrower column is usefully
  // taller. `composer` is the height of the message box at the foot of the
  // column, `ceiling` the lowest thing above it that is not the table. Returns
  // the column width and the clear height above the message box, which is zero
  // or less when the table reaches the corner.
  function fitChat(width, fit, { left, bottom, composer, ceiling, minWidth, maxWidth, step }) {
    let best = null;
    for (let column = maxWidth; column >= minWidth - .01; column -= step) {
      const room = bottom - composer - Math.max(ceiling, tableBottomOver(width, fit, 0, left + column + GAP));
      // Width matters more than height for reading, and height beyond a
      // dozen lines is not worth giving up width for.
      const worth = room <= 0 ? room : column * column * Math.min(room, maxWidth * .7);
      if (!best || worth > best.worth) best = { width: column, room, worth };
    }
    return { width: best.width, room: best.room };
  }

  // Docks and clusters keep their designed size on ordinary desktops, shrink
  // with a small window, and grow gently on very large displays so they stay in
  // proportion to a giant table without taking room from it.
  function uiScale(width, height) {
    const large = Math.min(width / 2560, height / 1440);
    return large > 1 ? large ** .6 : Math.min(1, width / 1200, height / 700);
  }

  const api = { fitTable, fitDock, fitChat, tableBottomOver, uiScale, SHAPES, GAP, EDGE };
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.StacksTableFit = api;
  if (typeof document !== 'object') return;

  const area = document.getElementById('tableArea');
  if (!area) return;
  const find = selector => document.querySelector(selector);
  const chat = find('.chat-box');
  const seatActions = find('.table-actions-bar');
  const corners = [find('.table-identity'), find('.account-bar nav')].filter(Boolean);
  // Betting and seat buttons: used only by a seated player, but their corners
  // are kept clear for everyone (see fit below). The pre-action bar lies inside
  // the betting dock's rectangle and needs no room of its own.
  const betting = find('.controls-area');
  const playerDocks = [betting, seatActions].filter(Boolean);
  const live = panel => {
    const rect = panel.getBoundingClientRect();
    return { left: rect.left, right: rect.right, top: rect.top, bottom: rect.bottom };
  };
  let frame;
  function fit() {
    cancelAnimationFrame(frame);
    frame = requestAnimationFrame(() => {
      if (document.body.classList.contains('is-mobile')) {
        area.style.top = '';
        area.style.height = '';
        area.style.removeProperty('--table-scale');
        return;
      }
      const ui = uiScale(innerWidth, innerHeight);
      document.body.style.setProperty('--desktop-ui-scale', ui);
      const panels = corners.map(live);
      // The docks are reserved even while their buttons are hidden, and for
      // spectators too: neither a turn update nor sitting down may change the
      // table's size or position.
      if (seatActions) panels.push(live(seatActions));
      const solid = panels.filter(panel => panel.right > panel.left && panel.bottom > panel.top);
      let fitted;
      if (betting) {
        // The dock scales about its bottom-right corner, which therefore stays
        // put; its layout size is unaffected by the scale already applied.
        const { right, bottom } = live(betting);
        const dockAt = size => ({ right, bottom,
          left: right - betting.offsetWidth * ui * size, top: bottom - betting.offsetHeight * ui * size });
        const grown = fitDock(innerWidth, innerHeight, solid, dockAt);
        fitted = grown.fit;
        document.body.style.setProperty('--dock-scale', grown.dock);
      } else fitted = fitTable(innerWidth, innerHeight, solid);
      const { scale, centerY } = fitted;
      area.style.top = `${centerY - TABLE_HEIGHT * scale / 2}px`;
      area.style.height = `${TABLE_HEIGHT * scale}px`;
      area.style.setProperty('--table-scale', scale);
      const identity = corners[0]?.getBoundingClientRect();
      const badge = document.getElementById('spectatorBadge');
      if (badge && identity) badge.style.top = `${identity.bottom + 6}px`;
      if (!chat) return;
      // Chat gets no say in the table's size. Its feed takes the corner the
      // table has left, and fades out where it would run up against the table.
      const rect = chat.getBoundingClientRect();
      const style = getComputedStyle(chat);
      const design = (name, fallback) => (parseFloat(style.getPropertyValue(name)) || fallback) * ui;
      const maxWidth = design('--chat-max-width', 340);
      const column = fitChat(innerWidth, fitted, {
        left: rect.left, bottom: rect.bottom, composer: design('--composer-height', 48) + design('--feed-lift', 0),
        ceiling: (identity ? identity.bottom : 0) + 40 * ui,
        minWidth: design('--chat-min-width', 160), maxWidth, step: 10 * ui,
      });
      // The fade may brush the table's edge; the lines kept solid may not.
      const height = Math.max(design('--feed-min-height', 66), Math.min(design('--feed-max-height', 520), column.room + 28 * ui));
      chat.style.setProperty('--chat-width', `${column.width / ui}px`);
      chat.style.setProperty('--feed-height', `${height / ui}px`);
      chat.style.setProperty('--feed-clear', `${Math.max(0, column.room) / ui}px`);
    });
  }
  const resized = new ResizeObserver(fit);
  [...corners, ...playerDocks].forEach(panel => resized.observe(panel));
  if (seatActions) new MutationObserver(fit).observe(seatActions, { attributes: true, attributeFilter: ['class'] });
  window.addEventListener('resize', fit);
  window.addEventListener('table-layout-change', fit);
  fit();
})(typeof window === 'object' ? window : globalThis);
