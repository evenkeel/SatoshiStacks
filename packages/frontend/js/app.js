(() => {
'use strict';

// ============================================================
//  CONFIGURATION & CONSTANTS
// ============================================================
const NUM_SEATS = 6;

// ============================================================
//  TABLE CONFIGURATION — derive from URL
// ============================================================
const TABLE_CONFIGS = {
  playmoney: { id: 'playmoney', name: '50 / 100', emoji: '🎲', smallBlind: 50, bigBlind: 100, minBuyin: 2000, maxBuyin: 10000, mode: 'open', minPlayers: 2 },
  pond:  { id: 'pond',  name: '50 / 100',  emoji: '🐟', smallBlind: 50,   bigBlind: 100,   minBuyin: 2000,    maxBuyin: 10000,   mode: 'open',     minPlayers: 2 },
  reef:  { id: 'reef',  name: '250 / 500', emoji: '🦀', smallBlind: 250,  bigBlind: 500,   minBuyin: 10000,   maxBuyin: 50000,   mode: 'interest', minPlayers: 4 },
  deep:  { id: 'deep',  name: '500 / 1K',  emoji: '🦈', smallBlind: 500,  bigBlind: 1000,  minBuyin: 20000,   maxBuyin: 100000,  mode: 'interest', minPlayers: 4 },
  abyss: { id: 'abyss', name: '5K / 10K',  emoji: '🐋', smallBlind: 5000, bigBlind: 10000, minBuyin: 200000,  maxBuyin: 1000000, mode: 'interest', minPlayers: 4 },
};

function getTableIdFromPath() {
  const path = window.location.pathname.replace(/\/$/, '').split('/').pop();
  return TABLE_CONFIGS[path] ? path : 'pond';
}

const myTableId = getTableIdFromPath();
const myTableConfig = TABLE_CONFIGS[myTableId];

// ============================================================
//  MOBILE DETECTION
// ============================================================
const isMobileDevice = (() => {
  const ua = navigator.userAgent || '';
  const isTouchDevice = ('ontouchstart' in window) || (navigator.maxTouchPoints > 0);
  const isMobileUA = /Android|iPhone|iPod|webOS|BlackBerry|Opera Mini|IEMobile/i.test(ua);
  const isSmallScreen = Math.min(window.screen.width, window.screen.height) <= 500;
  return isTouchDevice && (isMobileUA || isSmallScreen);
})();

// Platform-specific detection for login method selection
const isAndroid = /Android/i.test(navigator.userAgent || '');
const isIOS = /iPhone|iPad|iPod/i.test(navigator.userAgent || '') ||
  (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);

// NIP-46 module ready promise
const nip46Ready = new Promise(resolve => {
  if (window.NostrNIP46?.loaded) resolve();
  else window.addEventListener('nip46-ready', resolve, { once: true });
});

if (isMobileDevice) {
  document.body.classList.add('is-mobile');

  // Track true visible height (accounts for Safari toolbar)
  const setMobileHeight = () => {
    document.documentElement.style.setProperty('--app-height', window.innerHeight + 'px');
  };
  setMobileHeight();
  window.addEventListener('resize', setMobileHeight);

  // Try Fullscreen API (works on Android Chrome, not iOS Safari)
  const el = document.documentElement;
  const rfs = el.requestFullscreen || el.webkitRequestFullscreen;
  if (rfs) {
    document.addEventListener('click', () => {
      if (!document.fullscreenElement) rfs.call(el).catch(() => {});
    }, { once: true });
  }

}

// ============================================================
//  SOUND EFFECTS (Web Audio API — no files needed)
// ============================================================
const AudioCtx = window.AudioContext || window.webkitAudioContext;
let audioCtx = null;

function getAudioCtx() {
  if (!audioCtx) audioCtx = new AudioCtx();
  if (audioCtx.state === 'suspended') audioCtx.resume();
  return audioCtx;
}

function isSoundEnabled(alertOnly) {
  if (typeof chatSettings === 'undefined' || chatSettings.sound === 'off') return false;
  if (alertOnly) return true; // alerts play on both 'alerts' and 'all'
  return chatSettings.sound === 'all';
}

const SFX = {
  yourTurn() {
    if (!isSoundEnabled(true)) return;
    const ctx = getAudioCtx();
    // Gentle two-note chime — warm sine tones (C5 → E5)
    [523, 659].forEach((freq, i) => {
      const osc = ctx.createOscillator();
      osc.type = 'sine';
      osc.frequency.value = freq;
      const gain = ctx.createGain();
      gain.gain.setValueAtTime(0.14, ctx.currentTime + i * 0.12);
      gain.gain.exponentialRampToValueAtTime(0.01, ctx.currentTime + i * 0.12 + 0.2);
      osc.connect(gain).connect(ctx.destination);
      osc.start(ctx.currentTime + i * 0.12);
      osc.stop(ctx.currentTime + i * 0.12 + 0.2);
    });
  },
  timeBankStart() {
    if (!isSoundEnabled(true)) return;
    const ctx = getAudioCtx();
    // Distinct single triangle-wave beep — A5, signals time bank activation
    const osc = ctx.createOscillator();
    osc.type = 'triangle';
    osc.frequency.value = 880;
    const gain = ctx.createGain();
    gain.gain.setValueAtTime(0.18, ctx.currentTime);
    gain.gain.exponentialRampToValueAtTime(0.01, ctx.currentTime + 0.15);
    osc.connect(gain).connect(ctx.destination);
    osc.start(ctx.currentTime);
    osc.stop(ctx.currentTime + 0.15);
  },
  countdownBeep() {
    if (!isSoundEnabled(true)) return;
    const ctx = getAudioCtx();
    // Short tick sound — warns before autofold
    const osc = ctx.createOscillator();
    osc.type = 'square';
    osc.frequency.value = 1200;
    const gain = ctx.createGain();
    gain.gain.setValueAtTime(0.1, ctx.currentTime);
    gain.gain.exponentialRampToValueAtTime(0.01, ctx.currentTime + 0.06);
    osc.connect(gain).connect(ctx.destination);
    osc.start(ctx.currentTime);
    osc.stop(ctx.currentTime + 0.06);
  },
};

// NOSTR auth state — persisted in localStorage
let mySessionToken = localStorage.getItem('ss_sessionToken') || null;
let myPubkeyHex = localStorage.getItem('ss_pubkeyHex') || null;
let myNpub = localStorage.getItem('ss_npub') || null;
let myNostrName = localStorage.getItem('ss_nostrName') || null;
let myNostrPicture = localStorage.getItem('ss_nostrPicture') || null;
let myUserId = myPubkeyHex; // hex pubkey is the userId
let myUsername = myNostrName || (myNpub ? myNpub.slice(0, 12) + '...' : 'Anon');

let socket = null;
let gameState = null;
let mySeat = null;          // 1-6 (assigned by server)
let prevGameState = null;    // Track previous state for animations
let preAction = null;        // Pre-action selection
let currentHandLog = [];     // Accumulates hand-log lines for current hand
let chipFlyTriggered = false; // Prevent multiple chip fly animations per hand
let savedPotForAnimation = 0; // Captures pot total before server zeroes it, for chip fly
let renderedPotChipCount = 0; // How many chips currently rendered in the pot pile DOM
let potPileRng = null;        // Persistent PRNG function for stable chip pile layout
let vacuumAnimating = false;  // Guard: prevent updatePot from clearing DOM during vacuum animation
let cachedHoleCards = null;    // Cache our hole cards so they survive state glitches
let isObserver = false;       // True when watching without a seat
let observerName = null;      // Random name assigned by server for observers
let pendingSeat = null;       // Seat index clicked (0-5) while waiting for auth/buy-in

// Login intent: 'sit' (default) or 'observe' (sign in as observer without sitting)
let loginIntent = 'sit';

// Waitlist state
let waitlistPosition = null;  // My position on the waitlist (1-based), null if not on it
let seatOfferActive = false;  // True when we've been offered a seat
let seatOfferTimer = null;    // Countdown interval for seat offer

// NIP-51: Follow/Mute list state
let myFollowSet = new Set();  // pubkeys I follow
let myMuteSet = new Set();    // pubkeys I've muted

// Badge icon map
const BADGE_ICONS = { 'card-player': '🃏', 'royal-flush': '👑' };

const SUITS = ['h','d','c','s'];
const RANKS = ['2','3','4','5','6','7','8','9','T','J','Q','K','A'];
const SUIT_SYM = { h:'\u2665', d:'\u2666', c:'\u2663', s:'\u2660' };
const RANK_DISP = { T:'10', J:'J', Q:'Q', K:'K', A:'A' };

const $ = id => document.getElementById(id);

// HTML-escape user-controlled strings to prevent XSS
function esc(str) {
  if (!str) return '';
  return String(str).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;').replace(/'/g,'&#39;');
}
// Truncate long names/npubs for nameplate display (max 10 chars)
function truncName(name) {
  if (!name) return '?';
  if (name.length <= 10) return name;
  return name.slice(0, 8) + '…';
}

// Chip denominations — sorted high-to-low for greedy breakdown
const CHIP_DEFS = [
  { value: 100000, label: '100K', fill: '#1B1B2F', text: '#F8F3EA' },
  { value: 50000,  label: '50K',  fill: '#4A0E4E', text: '#F8F3EA' },
  { value: 25000,  label: '25K',  fill: '#162447', text: '#F8F3EA' },
  { value: 10000,  label: '10K',  fill: '#B55239', text: '#F8F3EA' },
  { value: 5000,   label: '5K',   fill: '#2F3E5C', text: '#F8F3EA' },
  { value: 1000,   label: '1K',   fill: '#5A3D5C', text: '#F8F3EA' },
  { value: 500,    label: '500',  fill: '#C46E3F', text: '#F8F3EA' },
  { value: 100,    label: '100',  fill: '#3C8C84', text: '#F8F3EA' },
  { value: 50,     label: '50',   fill: '#D4A017', text: '#F8F3EA' },
  { value: 10,     label: '10',   fill: '#9FB8A5', text: '#F8F3EA' },
  { value: 5,      label: '5',    fill: '#8B7355', text: '#F8F3EA' },
  { value: 1,      label: '1',    fill: '#F3EBD9', text: '#F3EBD9' },
];

// Nameplate target positions (% on poker table), keyed by visual seat (1-6)
const NP_TARGETS = {
  1: { top: 2,  left: 62 },
  2: { top: 50, left: 84 },
  3: { top: 98, left: 62 },
  4: { top: 98, left: 38 },
  5: { top: 50, left: 16 },
  6: { top: 2,  left: 38 },
};

// Bet position targets (where bet chips sit on felt), keyed by visual seat (1-6)
const BET_TARGETS = {
  1: { top: 12, left: 62 },
  2: { top: 60, left: 84 },
  3: { top: 72, left: 60 },
  4: { top: 72, left: 40 },
  5: { top: 60, left: 16 },
  6: { top: 12, left: 38 },
};

// Avatar colors for each visual seat
const AVATAR_COLORS = ['#5b9ea6','#d4714e','#8cb49a','#e8a838','#9b7cb4','#5a7d9a'];

// ============================================================
//  CHIP RENDERING (from beautiful version)
// ============================================================
function getChipBreakdown(amount) {
  const result = [];
  let rem = Math.floor(amount);
  for (const def of CHIP_DEFS) {
    if (rem >= def.value) {
      const count = Math.floor(rem / def.value);
      result.push({ ...def, count });
      rem -= count * def.value;
    }
    if (rem === 0) break;
  }
  return result;
}

function renderChipSVG(def, size) {
  const s = size;
  const cx = s / 2, cy = s / 2;
  const outerR = s / 2 - 1;
  const innerR = outerR * 0.7;
  const fs = s < 18 ? s * 0.36 : s * 0.32;
  const stroke = '#3d3228';
  return `<svg width="${s}" height="${s}" viewBox="0 0 ${s} ${s}" xmlns="http://www.w3.org/2000/svg">
    <circle cx="${cx}" cy="${cy}" r="${outerR}" fill="${def.fill}" stroke="${stroke}" stroke-width="${s * 0.06}"/>
    <circle cx="${cx}" cy="${cy}" r="${innerR}" fill="none" stroke="${stroke}" stroke-width="${s * 0.04}" opacity="0.35"/>
    <text x="${cx}" y="${cy}" text-anchor="middle" dominant-baseline="central"
      font-family="'Nunito',sans-serif" font-weight="900" font-size="${fs}px"
      fill="${def.text}" stroke="${stroke}" stroke-width="${s * 0.02}"
      paint-order="stroke">${def.label}</text>
  </svg>`;
}

function renderChipStack(amount, chipSize, maxTotal) {
  if (!amount || amount <= 0) return '';
  const breakdown = getChipBreakdown(amount);
  if (breakdown.length === 0) return '';
  const chips = [];
  for (const denom of breakdown) {
    const show = Math.min(denom.count, maxTotal - chips.length);
    for (let j = 0; j < show; j++) chips.push(denom);
    if (chips.length >= maxTotal) break;
  }
  const offset = chipSize * 0.22;
  const colH = chipSize + (chips.length - 1) * offset;
  let html = `<div class="chip-stack"><div class="chip-stack-column" style="height:${colH}px">`;
  for (let j = 0; j < chips.length; j++) {
    html += `<div class="chip-stack-item" style="top:${j * offset}px;z-index:${chips.length - j}">${renderChipSVG(chips[j], chipSize)}</div>`;
  }
  html += '</div></div>';
  return html;
}

function layoutChipPile(chips, chipSize, seed) {
  if (chips.length === 0) return '';
  function rand() { seed = (seed * 16807 + 0) % 2147483647; return (seed - 1) / 2147483646; }
  const shuffled = [...chips];
  for (let i = shuffled.length - 1; i > 0; i--) {
    const j = Math.floor(rand() * (i + 1));
    [shuffled[i], shuffled[j]] = [shuffled[j], shuffled[i]];
  }
  const spreadX = Math.min(shuffled.length * 6, 120);
  const spreadY = Math.min(shuffled.length * 2, 25);
  let html = `<div class="chip-pile" style="width:${spreadX * 2 + chipSize}px;height:${spreadY * 2 + chipSize + 20}px;">`;
  const cx = spreadX + chipSize / 2;
  const cy = spreadY + chipSize / 2;
  for (let i = 0; i < shuffled.length; i++) {
    const layer = i / Math.max(shuffled.length - 1, 1);
    const tightness = 0.85 - layer * 0.55;
    const angle = rand() * Math.PI * 2;
    const dist = rand() * tightness;
    const x = cx + Math.cos(angle) * dist * spreadX - chipSize / 2;
    const y = cy + Math.sin(angle) * dist * spreadY - chipSize / 2;
    const rot = Math.floor(rand() * 360);
    html += `<div class="chip-pile-item" style="left:${x}px;top:${y}px;z-index:${i};transform:rotate(${rot}deg)">${renderChipSVG(shuffled[i], chipSize)}</div>`;
  }
  html += '</div>';
  return html;
}

// Stable PRNG factory — returns a function that produces deterministic values 0–1
function createPRNG(seed) {
  let s = Math.abs(seed) || 1;
  return function() {
    s = (s * 16807 + 0) % 2147483647;
    return (s - 1) / 2147483646;
  };
}

// Append new chips to an existing pile without touching existing DOM chips.
// rng must be the same persistent PRNG that was used for all prior chips.
function appendChipsToPile(newChips, container, totalCount, chipSize, rng) {
  // Get or create the .chip-pile div
  let pile = container.querySelector('.chip-pile');
  const spreadX = Math.min(totalCount * 6, 120);
  const spreadY = Math.min(totalCount * 2, 25);
  if (!pile) {
    pile = document.createElement('div');
    pile.className = 'chip-pile';
    container.appendChild(pile);
  }
  // Resize pile to accommodate total chip count
  pile.style.width = (spreadX * 2 + chipSize) + 'px';
  pile.style.height = (spreadY * 2 + chipSize + 20) + 'px';

  const cx = spreadX + chipSize / 2;
  const cy = spreadY + chipSize / 2;
  const startIdx = totalCount - newChips.length;

  for (let i = 0; i < newChips.length; i++) {
    const globalIdx = startIdx + i;
    const layer = globalIdx / Math.max(totalCount - 1, 1);
    const tightness = 0.85 - layer * 0.55;
    const angle = rng() * Math.PI * 2;
    const dist = rng() * tightness;
    const x = cx + Math.cos(angle) * dist * spreadX - chipSize / 2;
    const y = cy + Math.sin(angle) * dist * spreadY - chipSize / 2;
    const rot = Math.floor(rng() * 360);
    const el = document.createElement('div');
    el.className = 'chip-pile-item';
    el.style.cssText = `left:${x}px;top:${y}px;z-index:${globalIdx};transform:rotate(${rot}deg)`;
    el.innerHTML = renderChipSVG(newChips[i], chipSize);
    pile.appendChild(el);
  }
}

function renderChipPillIcon(amount, size) {
  if (!amount || amount <= 0) return renderChipSVG(CHIP_DEFS[CHIP_DEFS.length - 1], size);
  for (const def of CHIP_DEFS) {
    if (amount >= def.value) return renderChipSVG(def, size);
  }
  return renderChipSVG(CHIP_DEFS[CHIP_DEFS.length - 1], size);
}

// ============================================================
//  CARD RENDERING (from beautiful version)
// ============================================================
function isRed(s) { return s === 'h' || s === 'd'; }

// Pip grid layouts for number cards (positions on a 3-col x N-row grid)
// Each pip: [col 1-3, row position %, flipped]
const PIP_LAYOUTS = {
  '2': [[2,20,false],[2,80,true]],
  '3': [[2,15,false],[2,50,false],[2,85,true]],
  '4': [[1,25,false],[3,25,false],[1,75,true],[3,75,true]],
  '5': [[1,25,false],[3,25,false],[2,50,false],[1,75,true],[3,75,true]],
  '6': [[1,25,false],[3,25,false],[1,50,false],[3,50,false],[1,75,true],[3,75,true]],
  '7': [[1,25,false],[3,25,false],[2,37,false],[1,50,false],[3,50,false],[1,75,true],[3,75,true]],
  '8': [[1,25,false],[3,25,false],[2,37,false],[1,50,false],[3,50,false],[2,63,true],[1,75,true],[3,75,true]],
  '9': [[1,22,false],[3,22,false],[1,44,false],[3,44,false],[2,33,false],[1,66,true],[3,66,true],[1,88,true],[3,88,true]],
  'T': [[1,20,false],[3,20,false],[2,32,false],[1,42,false],[3,42,false],[1,58,true],[3,58,true],[2,68,true],[1,80,true],[3,80,true]]
};

function renderCardHTML(card, sizeClass) {
  if (!card || card === '??') return `<div class="card face-down ${sizeClass || ''}"></div>`;
  const r = card[0], s = card[1];
  const d = RANK_DISP[r] || r;
  const sym = SUIT_SYM[s];
  const color = isRed(s) ? 'red' : 'black';
  const extraClasses = sizeClass || '';

  // Small cards — keep compact
  if (extraClasses.includes('small')) {
    return `<div class="card ${extraClasses} ${color}">
      <span class="card-rank">${d}</span><span class="card-suit">${sym}</span>
    </div>`;
  }

  const corners = `<div class="card-corner top-left"><span class="card-rank">${d}</span><span class="card-suit">${sym}</span></div>` +
    `<div class="card-corner bottom-right"><span class="card-rank">${d}</span><span class="card-suit">${sym}</span></div>`;

  // Ace — large centered suit
  if (r === 'A') {
    return `<div class="card ${color} ${extraClasses} ace-card">${corners}
      <div class="card-center"><span class="card-pip">${sym}</span></div>
    </div>`;
  }

  // Face cards (J, Q, K) — large suit + ghosted letter
  if (r === 'J' || r === 'Q' || r === 'K') {
    return `<div class="card ${color} ${extraClasses} face-card">${corners}
      <div class="card-face-icon"><span class="card-face-letter">${d}</span></div>
      <div class="card-face-icon"><span class="card-face-suit">${sym}</span></div>
    </div>`;
  }

  // Number cards (2-10) — proper pip layout
  const layout = PIP_LAYOUTS[r];
  if (layout) {
    const colPos = {1: '20%', 2: '50%', 3: '80%'};
    let pipsHTML = '<div class="card-pips">';
    pipsHTML += layout.map(([col, row, flip]) =>
      `<span class="pip${flip ? ' flip' : ''}" style="position:absolute;left:${colPos[col]};top:${row}%;transform:translate(-50%,-50%)${flip ? ' rotate(180deg)' : ''}">${sym}</span>`
    ).join('');
    pipsHTML += '</div>';
    return `<div class="card ${color} ${extraClasses} pip-card">${corners}${pipsHTML}</div>`;
  }

  // Fallback
  return `<div class="card ${color} ${extraClasses}">${corners}
    <div class="card-center"><span class="card-pip">${sym}</span></div>
  </div>`;
}

function fmt(n) { return typeof n === 'number' ? n.toLocaleString() : '0'; }

// ============================================================
//  GUI ROTATION — player always sees themselves at position 3
// ============================================================
function calculateVisualPosition(actualSeat) {
  if (!mySeat) return actualSeat;
  const actual = actualSeat - 1;
  const my = mySeat - 1;
  const TARGET_POS = 2; // position 3 in 1-indexed
  const offset = TARGET_POS - my;
  let visual = (actual + offset + 6) % 6;
  return visual + 1;
}

function getVisualPosition(playerIndex) {
  if (!gameState || playerIndex === -1 || playerIndex == null) return null;
  const actualSeat = playerIndex + 1;
  return calculateVisualPosition(actualSeat);
}

// ============================================================
//  NOSTR AUTHENTICATION
// ============================================================

// NIP-46 state
let nip46Signer = null;
let nip46ClientSk = null;
let nip46AbortController = null;
const NIP46_RELAYS = ['wss://relay.nsec.app', 'wss://relay.damus.io'];

function showLoginOverlay() {
  const overlay = document.getElementById('loginOverlay');
  if (overlay) overlay.classList.remove('hidden');
  // Reset to method selection screen
  const methods = document.getElementById('loginMethods');
  const qrScreen = document.getElementById('loginQrScreen');
  const bunkerScreen = document.getElementById('loginBunkerScreen');
  if (methods) methods.classList.remove('hidden');
  if (qrScreen) qrScreen.classList.add('hidden');
  if (bunkerScreen) bunkerScreen.classList.add('hidden');
  // Cancel any pending NIP-46 connection
  if (nip46AbortController) {
    nip46AbortController.abort();
    nip46AbortController = null;
  }
  qrConnectionURI = null;
  setLoginStatus('', false);
  populateLoginMethods();
}

function hideLoginOverlay() {
  const overlay = document.getElementById('loginOverlay');
  if (overlay) overlay.classList.add('hidden');
}

function setLoginStatus(msg, isError = true) {
  const el = document.getElementById('loginStatus');
  if (el) {
    el.textContent = msg;
    el.style.color = isError ? 'var(--rust)' : 'var(--sage)';
  }
}

async function detectNostr(retries = 3) {
  for (let i = 0; i < retries; i++) {
    if (window.nostr) return true;
    await new Promise(r => setTimeout(r, 300));
  }
  return false;
}

// SVG icons for login buttons
const LOGIN_ICONS = {
  extension: '<svg class="btn-icon" viewBox="0 0 20 20" fill="none"><circle cx="10" cy="10" r="9" stroke="currentColor" stroke-width="1.5" fill="none"/><path d="M6 10.5C6 8.5 8 6 10 6s4 2.5 4 4.5-2 4.5-4 4.5-4-2.5-4-4.5z" fill="currentColor" opacity="0.3"/><circle cx="10" cy="10" r="2.5" fill="currentColor"/></svg>',
  qrcode: '<svg class="btn-icon" viewBox="0 0 20 20" fill="currentColor"><rect x="2" y="2" width="7" height="7" rx="1" stroke="currentColor" stroke-width="1.5" fill="none"/><rect x="11" y="2" width="7" height="7" rx="1" stroke="currentColor" stroke-width="1.5" fill="none"/><rect x="2" y="11" width="7" height="7" rx="1" stroke="currentColor" stroke-width="1.5" fill="none"/><rect x="4" y="4" width="3" height="3" rx="0.5"/><rect x="13" y="4" width="3" height="3" rx="0.5"/><rect x="4" y="13" width="3" height="3" rx="0.5"/><rect x="12" y="12" width="2" height="2"/><rect x="16" y="12" width="2" height="2"/><rect x="12" y="16" width="2" height="2"/><rect x="16" y="16" width="2" height="2"/><rect x="14" y="14" width="2" height="2"/></svg>',
  amber: '<svg class="btn-icon" viewBox="0 0 20 20" fill="none"><circle cx="10" cy="10" r="8" stroke="currentColor" stroke-width="1.5"/><path d="M10 4v4l3 2" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/><circle cx="10" cy="10" r="1.5" fill="currentColor"/></svg>',
  keyring: '<svg class="btn-icon" viewBox="0 0 20 20" fill="none"><circle cx="10" cy="7" r="4" stroke="currentColor" stroke-width="1.5"/><path d="M10 11v6" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/><path d="M10 14h2.5" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/><path d="M10 16h2" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/></svg>',
  bunker: '<svg class="btn-icon" viewBox="0 0 20 20" fill="none"><rect x="3" y="8" width="14" height="9" rx="2" stroke="currentColor" stroke-width="1.5"/><path d="M7 8V6a3 3 0 016 0v2" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/><circle cx="10" cy="13" r="1.5" fill="currentColor"/></svg>'
};

function populateLoginMethods() {
  const container = document.getElementById('loginMethods');
  if (!container) return;
  container.innerHTML = '';

  const hasExtension = !!window.nostr;

  if (!isMobileDevice) {
    // DESKTOP: Extension (if available) + QR Code + Bunker URL
    if (hasExtension) {
      container.innerHTML =
        `<button class="login-method-btn primary" data-action="nip07-login">${LOGIN_ICONS.extension} Browser Extension</button>` +
        `<button class="login-method-btn secondary" data-action="start-qr-login">${LOGIN_ICONS.qrcode} Connect with Phone</button>` +
        `<button class="login-method-btn secondary" data-action="show-bunker">${LOGIN_ICONS.bunker} Paste Bunker URL</button>`;
    } else {
      container.innerHTML =
        `<button class="login-method-btn primary" data-action="start-qr-login">${LOGIN_ICONS.qrcode} Connect with Phone</button>` +
        `<button class="login-method-btn secondary" data-action="nip07-login">${LOGIN_ICONS.extension} Browser Extension</button>` +
        `<button class="login-method-btn secondary" data-action="show-bunker">${LOGIN_ICONS.bunker} Paste Bunker URL</button>`;
    }
  } else if (isAndroid) {
    // ANDROID: Deep link (Amber/Primal/any NIP-46 signer) + Bunker URL fallback
    container.innerHTML =
      `<button class="login-method-btn primary" data-action="deep-link-login" data-provider="Nostr">${LOGIN_ICONS.amber} Sign in with Nostr</button>` +
      `<button class="login-method-btn secondary" data-action="show-bunker">${LOGIN_ICONS.bunker} Paste Bunker URL</button>`;
    if (hasExtension) {
      container.innerHTML +=
        `<button class="login-method-btn secondary" data-action="nip07-login">${LOGIN_ICONS.extension} Browser Extension</button>`;
    }
  } else if (isIOS) {
    // iOS: Deep link (Nostr Keyring/Primal/any NIP-46 signer) + Bunker URL fallback
    container.innerHTML =
      `<button class="login-method-btn primary" data-action="deep-link-login" data-provider="Nostr">${LOGIN_ICONS.keyring} Sign in with Nostr</button>` +
      `<button class="login-method-btn secondary" data-action="show-bunker">${LOGIN_ICONS.bunker} Paste Bunker URL</button>`;
    if (hasExtension) {
      container.innerHTML +=
        `<button class="login-method-btn secondary" data-action="nip07-login">${LOGIN_ICONS.extension} Browser Extension</button>`;
    }
  } else {
    // Fallback: show all options
    container.innerHTML =
      `<button class="login-method-btn primary" data-action="nip07-login">${LOGIN_ICONS.extension} Browser Extension</button>` +
      `<button class="login-method-btn secondary" data-action="start-qr-login">${LOGIN_ICONS.qrcode} Connect with Phone</button>` +
      `<button class="login-method-btn secondary" data-action="show-bunker">${LOGIN_ICONS.bunker} Paste Bunker URL</button>`;
  }

  // Update help text
  const helpEl = document.getElementById('loginHelp');
  if (helpEl) {
    if (!isMobileDevice) {
      helpEl.innerHTML = hasExtension
        ? 'Scan the QR code with <a href="https://github.com/greenart7c3/Amber" target="_blank" rel="noopener">Amber</a>, <a href="https://primal.net" target="_blank" rel="noopener">Primal</a>, or any NIP-46 signer'
        : 'Use <a href="https://github.com/greenart7c3/Amber" target="_blank" rel="noopener">Amber</a>, <a href="https://primal.net" target="_blank" rel="noopener">Primal</a>, or install <a href="https://chromewebstore.google.com/detail/nos2x/kpgefcfmnafjgpblomihpgmejjdanjjp" target="_blank" rel="noopener">nos2x</a>';
    } else if (isAndroid) {
      helpEl.innerHTML = 'Works with <a href="https://github.com/greenart7c3/Amber" target="_blank" rel="noopener">Amber</a>, <a href="https://primal.net" target="_blank" rel="noopener">Primal</a>, or any NIP-46 signer';
    } else if (isIOS) {
      helpEl.innerHTML = 'Works with <a href="https://apps.apple.com/app/nostr-keyring/id6446657094" target="_blank" rel="noopener">Nostr Keyring</a>, <a href="https://primal.net" target="_blank" rel="noopener">Primal</a>, or any NIP-46 signer';
    } else {
      helpEl.innerHTML = 'Requires a Nostr signer app or browser extension';
    }
  }
}

// Shared session storage helper
function storeAuthSession(verifyData) {
  mySessionToken = verifyData.sessionToken;
  myPubkeyHex = verifyData.pubkeyHex;
  myNpub = verifyData.npub;
  myNostrName = verifyData.profile.name;
  myNostrPicture = verifyData.profile.picture;
  myUserId = myPubkeyHex;
  myUsername = myNostrName || myNpub.slice(0, 12) + '...';

  localStorage.setItem('ss_sessionToken', mySessionToken);
  localStorage.setItem('ss_pubkeyHex', myPubkeyHex);
  localStorage.setItem('ss_npub', myNpub);
  if (myNostrName) localStorage.setItem('ss_nostrName', myNostrName);
  if (myNostrPicture) localStorage.setItem('ss_nostrPicture', myNostrPicture);
  if (verifyData.profile.lud16) localStorage.setItem('ss_lud16', verifyData.profile.lud16);

  // NIP-51: Fetch follow/mute lists in background
  fetchFollowAndMuteLists(myPubkeyHex);

  // NIP-47: Show wallet connect option in settings
  showNWCRow();
}

// Challenge-response auth using a signer object (window.nostr or NIP-46 BunkerSigner)
async function performChallengeAuth(signer) {
  // Step 1: Get challenge from server
  setLoginStatus('Requesting challenge...', false);
  const challengeRes = await fetch('/api/auth/challenge', { method: 'POST' });
  const challengeData = await challengeRes.json();
  if (!challengeData.success) throw new Error(challengeData.error || 'Failed to get challenge');

  // Step 2: Get pubkey from signer
  setLoginStatus('Requesting pubkey...', false);
  const pubkey = await signer.getPublicKey();

  // Step 3: Sign the challenge event
  setLoginStatus('Please approve the login request...', false);
  const eventTemplate = {
    kind: 22242,
    created_at: Math.floor(Date.now() / 1000),
    tags: [
      ['challenge', challengeData.nonce],
      ['relay', window.location.origin]
    ],
    content: ''
  };
  const signedEvent = await signer.signEvent(eventTemplate);

  // Step 4: Verify with server
  setLoginStatus('Verifying signature...', false);
  const verifyRes = await fetch('/api/auth/verify', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      challengeId: challengeData.challengeId,
      signedEvent
    })
  });
  const verifyData = await verifyRes.json();
  if (!verifyData.success) throw new Error(verifyData.error || 'Verification failed');

  return verifyData;
}

// === NIP-07 Browser Extension Login ===
async function handleNIP07Login() {
  // Disable all method buttons
  document.querySelectorAll('.login-method-btn').forEach(b => b.disabled = true);
  setLoginStatus('Checking for NOSTR extension...', false);

  const hasNostr = await detectNostr();
  if (!hasNostr) {
    setLoginStatus('No Nostr extension found. Install nos2x or another NIP-07 signer extension.');
    document.querySelectorAll('.login-method-btn').forEach(b => b.disabled = false);
    return;
  }

  try {
    const verifyData = await performChallengeAuth(window.nostr);
    storeAuthSession(verifyData);
    localStorage.setItem('ss_authMethod', 'nip07');
    setLoginStatus('Connected!', false);
    hideLoginOverlay();
    if (loginIntent === 'observe') {
      // Authenticate observer socket without sitting down
      if (socket) socket.emit('observer-authenticate', { sessionToken: mySessionToken });
      loginIntent = 'sit';
    } else {
      showBuyinDialog();
    }
  } catch (err) {
    console.error('[NIP-07] Login error:', err);
    setLoginStatus(err.message || 'Login failed');
    document.querySelectorAll('.login-method-btn').forEach(b => b.disabled = false);
  }
}
window.handleNIP07Login = handleNIP07Login;

// === NIP-46 QR Code Login (Desktop — scan with phone signer) ===
let qrConnectionURI = null; // stored for "copy link" button

async function startQRCodeLogin() {
  try {
    await nip46Ready;
    const { generateSecretKey, getPublicKey, BunkerSigner, createNostrConnectURI, SimplePool } = window.NostrNIP46;

    // Switch to QR screen
    document.getElementById('loginMethods').classList.add('hidden');
    document.getElementById('loginBunkerScreen').classList.add('hidden');
    const qrScreen = document.getElementById('loginQrScreen');
    qrScreen.classList.remove('hidden');
    setLoginStatus('Generating connection code...', false);

    // Generate ephemeral keypair
    nip46ClientSk = generateSecretKey();
    const clientPkHex = getPublicKey(nip46ClientSk);

    // Generate random secret for anti-spoofing
    const secret = Array.from(crypto.getRandomValues(new Uint8Array(16)))
      .map(b => b.toString(16).padStart(2, '0')).join('');

    // Build nostrconnect:// URI
    qrConnectionURI = createNostrConnectURI({
      clientPubkey: clientPkHex,
      relays: NIP46_RELAYS,
      secret: secret,
      name: 'Satoshi Stacks',
      url: window.location.origin
    });

    // Render QR code
    const qrContainer = document.getElementById('loginQrContainer');
    qrContainer.innerHTML = '';
    new QRCode(qrContainer, {
      text: qrConnectionURI,
      width: 200,
      height: 200,
      colorDark: '#3d3228',
      colorLight: '#ffffff',
      correctLevel: QRCode.CorrectLevel.M
    });

    setLoginStatus('', false);
    document.getElementById('loginQrHint').textContent = 'Waiting for connection...';

    // Wait for signer to connect (2 minute timeout)
    nip46AbortController = new AbortController();
    const pool = new SimplePool();

    const timeoutId = setTimeout(() => {
      if (nip46AbortController) nip46AbortController.abort();
    }, 120000);

    nip46Signer = await BunkerSigner.fromURI(
      nip46ClientSk,
      qrConnectionURI,
      { pool },
      nip46AbortController.signal
    );

    clearTimeout(timeoutId);

    // Connected! Proceed with challenge-response auth
    setLoginStatus('Connected! Authenticating...', false);
    document.getElementById('loginQrHint').textContent = 'Connected! Authenticating...';

    const verifyData = await performChallengeAuth(nip46Signer);
    storeAuthSession(verifyData);
    localStorage.setItem('ss_authMethod', 'nip46');

    setLoginStatus('Connected!', false);
    hideLoginOverlay();
    if (loginIntent === 'observe') {
      // Authenticate observer socket without sitting down
      if (socket) socket.emit('observer-authenticate', { sessionToken: mySessionToken });
      loginIntent = 'sit';
    } else {
      showBuyinDialog();
    }

  } catch (err) {
    if (err.name === 'AbortError' || err.message?.includes('aborted')) {
      setLoginStatus('Connection timed out — try again or paste a bunker URL', true);
      document.getElementById('loginQrHint').textContent = 'Timed out';
    } else {
      console.error('[NIP-46] QR login error:', err);
      setLoginStatus(err.message || 'Connection failed', true);
      document.getElementById('loginQrHint').textContent = 'Connection failed';
    }
    nip46Signer = null;
    nip46ClientSk = null;
    qrConnectionURI = null;
  }
}
window.startQRCodeLogin = startQRCodeLogin;

function copyQRLink() {
  if (!qrConnectionURI) return;
  navigator.clipboard.writeText(qrConnectionURI).then(() => {
    const btn = document.getElementById('loginQrCopy');
    if (btn) {
      btn.textContent = 'Copied!';
      setTimeout(() => { btn.textContent = 'Copy connection link'; }, 2000);
    }
  }).catch(() => {
    // Fallback: select + copy
    const ta = document.createElement('textarea');
    ta.value = qrConnectionURI;
    ta.style.position = 'fixed';
    ta.style.opacity = '0';
    document.body.appendChild(ta);
    ta.select();
    document.execCommand('copy');
    document.body.removeChild(ta);
    const btn = document.getElementById('loginQrCopy');
    if (btn) {
      btn.textContent = 'Copied!';
      setTimeout(() => { btn.textContent = 'Copy connection link'; }, 2000);
    }
  });
}
window.copyQRLink = copyQRLink;

function switchToBunkerFromQR() {
  // Cancel pending QR connection
  if (nip46AbortController) {
    nip46AbortController.abort();
    nip46AbortController = null;
  }
  nip46Signer = null;
  nip46ClientSk = null;
  qrConnectionURI = null;
  // Hide QR, show bunker
  document.getElementById('loginQrScreen').classList.add('hidden');
  document.getElementById('loginBunkerScreen').classList.remove('hidden');
  document.getElementById('loginBunkerInput').value = '';
  document.getElementById('loginBunkerHint').textContent = '';
  setLoginStatus('', false);
  setTimeout(() => document.getElementById('loginBunkerInput')?.focus(), 100);
}
window.switchToBunkerFromQR = switchToBunkerFromQR;

// === NIP-46 Bunker URL Login ===
function showBunkerScreen() {
  document.getElementById('loginMethods').classList.add('hidden');
  document.getElementById('loginQrScreen')?.classList.add('hidden');
  document.getElementById('loginBunkerScreen').classList.remove('hidden');
  document.getElementById('loginBunkerInput').value = '';
  document.getElementById('loginBunkerHint').textContent = '';
  setLoginStatus('', false);
  // Focus the input after a tick
  setTimeout(() => document.getElementById('loginBunkerInput')?.focus(), 100);
}
window.showBunkerScreen = showBunkerScreen;

async function submitBunkerLogin() {
  const input = document.getElementById('loginBunkerInput');
  const hint = document.getElementById('loginBunkerHint');
  const submitBtn = document.getElementById('loginBunkerSubmit');
  const uri = (input?.value || '').trim();

  if (!uri) {
    hint.textContent = 'Please paste your bunker:// URL';
    hint.style.color = '#e57373';
    return;
  }
  if (!uri.startsWith('bunker://')) {
    hint.textContent = 'URL must start with bunker://';
    hint.style.color = '#e57373';
    return;
  }

  try {
    submitBtn.disabled = true;
    hint.style.color = 'var(--sage)';
    hint.textContent = 'Connecting to signer...';
    setLoginStatus('Connecting...', false);

    await nip46Ready;
    const { generateSecretKey, BunkerSigner, parseBunkerInput, SimplePool } = window.NostrNIP46;

    // Parse the bunker:// URI
    const bunkerProfile = await parseBunkerInput(uri);
    if (!bunkerProfile || !bunkerProfile.pubkey || !bunkerProfile.relays?.length) {
      throw new Error('Invalid bunker URL — could not parse pubkey or relay');
    }

    // Generate ephemeral client keypair
    nip46ClientSk = generateSecretKey();
    const pool = new SimplePool();

    // Connect to the signer (immediate — no waiting like QR)
    nip46Signer = BunkerSigner.fromBunker(nip46ClientSk, bunkerProfile, { pool });

    // NIP-46: Send connect request to the signer
    hint.textContent = 'Requesting permission from signer...';
    await nip46Signer.connect();

    // Proceed with challenge-response auth
    hint.textContent = 'Authenticating...';
    setLoginStatus('Authenticating...', false);

    const verifyData = await performChallengeAuth(nip46Signer);
    storeAuthSession(verifyData);
    localStorage.setItem('ss_authMethod', 'nip46');

    setLoginStatus('Connected!', false);
    hideLoginOverlay();
    if (loginIntent === 'observe') {
      // Authenticate observer socket without sitting down
      if (socket) socket.emit('observer-authenticate', { sessionToken: mySessionToken });
      loginIntent = 'sit';
    } else {
      showBuyinDialog();
    }

  } catch (err) {
    console.error('[NIP-46] Bunker login error:', err);
    hint.textContent = err.message || 'Connection failed';
    hint.style.color = '#e57373';
    setLoginStatus(err.message || 'Connection failed', true);
    nip46Signer = null;
    nip46ClientSk = null;
  } finally {
    if (submitBtn) submitBtn.disabled = false;
  }
}
window.submitBunkerLogin = submitBunkerLogin;

// === NIP-46 Deep Link Login (Amber / Nostr Keyring) ===
async function startDeepLinkLogin(appName) {
  try {
    await nip46Ready;
    const { generateSecretKey, getPublicKey, BunkerSigner, createNostrConnectURI, SimplePool } = window.NostrNIP46;

    // Disable buttons, show status
    document.querySelectorAll('.login-method-btn').forEach(b => b.disabled = true);
    setLoginStatus('Opening signer app...', false);

    // Generate ephemeral keypair
    nip46ClientSk = generateSecretKey();
    const clientPkHex = getPublicKey(nip46ClientSk);

    const secret = Array.from(crypto.getRandomValues(new Uint8Array(16)))
      .map(b => b.toString(16).padStart(2, '0')).join('');

    const connectionURI = createNostrConnectURI({
      clientPubkey: clientPkHex,
      relays: NIP46_RELAYS,
      secret: secret,
      name: 'Satoshi Stacks',
      url: window.location.origin
    });

    // Start listening on relay FIRST
    nip46AbortController = new AbortController();
    const pool = new SimplePool();
    const signerPromise = BunkerSigner.fromURI(
      nip46ClientSk,
      connectionURI,
      { pool },
      nip46AbortController.signal
    );

    // Open deep link (triggers Amber / Primal / Nostr Keyring / etc.)
    window.open(connectionURI, '_blank');

    setLoginStatus('Waiting for signer app to respond...', false);

    // Wait for connection
    nip46Signer = await signerPromise;

    // Connected! Proceed with challenge-response auth
    setLoginStatus('Connected! Authenticating...', false);

    const verifyData = await performChallengeAuth(nip46Signer);
    storeAuthSession(verifyData);
    localStorage.setItem('ss_authMethod', 'nip46');

    setLoginStatus('Connected!', false);
    hideLoginOverlay();
    if (loginIntent === 'observe') {
      // Authenticate observer socket without sitting down
      if (socket) socket.emit('observer-authenticate', { sessionToken: mySessionToken });
      loginIntent = 'sit';
    } else {
      showBuyinDialog();
    }

  } catch (err) {
    if (err.name === 'AbortError' || err.message?.includes('aborted')) {
      setLoginStatus('Connection cancelled', true);
    } else {
      console.error('[NIP-46] Deep link login error:', err);
      setLoginStatus(err.message || 'Failed to connect — try pasting a bunker URL instead', true);
    }
    nip46Signer = null;
    nip46ClientSk = null;
    document.querySelectorAll('.login-method-btn').forEach(b => b.disabled = false);
  }
}
window.startDeepLinkLogin = startDeepLinkLogin;

// Back button from bunker screen
function loginGoBack() {
  if (nip46AbortController) {
    nip46AbortController.abort();
    nip46AbortController = null;
  }
  nip46Signer = null;
  nip46ClientSk = null;
  qrConnectionURI = null;
  document.getElementById('loginQrScreen')?.classList.add('hidden');
  document.getElementById('loginBunkerScreen')?.classList.add('hidden');
  document.getElementById('loginMethods')?.classList.remove('hidden');
  setLoginStatus('', false);
}
window.loginGoBack = loginGoBack;

// Cancel login entirely — dismiss overlay, clear pending seat, stay as observer
function cancelLogin() {
  if (nip46AbortController) {
    nip46AbortController.abort();
    nip46AbortController = null;
  }
  nip46Signer = null;
  pendingSeat = null;
  pendingBuyIn = null;
  loginIntent = 'sit';
  hideLoginOverlay();
  resetLoginOverlay();
}

function nostrLogout() {
  localStorage.removeItem('ss_sessionToken');
  localStorage.removeItem('ss_pubkeyHex');
  localStorage.removeItem('ss_npub');
  localStorage.removeItem('ss_nostrName');
  localStorage.removeItem('ss_nostrPicture');
  localStorage.removeItem('ss_lud16');
  localStorage.removeItem('ss_authMethod');
  localStorage.removeItem('ss_nwcUri');
  mySessionToken = null;
  myPubkeyHex = null;
  myNpub = null;
  myNostrName = null;
  myNostrPicture = null;
  myUserId = null;
  myUsername = 'Anon';
  myTableInterested = false;
  mySeat = null;
  gameState = null;
  cachedHoleCards = null;
  // Clear NIP-51 follow/mute state
  myFollowSet = new Set();
  myMuteSet = new Set();
  // Hide NWC row + interest list
  showNWCRow();
  updateTableInterestOverlay();
  // Clean up NIP-46 state
  if (nip46Signer) {
    try { nip46Signer.close(); } catch (e) { /* ignore */ }
    nip46Signer = null;
  }
  nip46ClientSk = null;
  qrConnectionURI = null;
  if (nip46AbortController) {
    nip46AbortController.abort();
    nip46AbortController = null;
  }
  if (socket) {
    socket.emit('leave-table');
    socket.disconnect();
    socket = null;
  }
  // Reconnect as observer so they still see the table
  connectAsObserver();
}
window.nostrLogout = nostrLogout;

// ============================================================
//  NIP-47: Nostr Wallet Connect
// ============================================================
function connectNWC() {
  const existing = localStorage.getItem('ss_nwcUri');
  if (existing) {
    // Already connected — offer disconnect
    if (confirm('Disconnect Lightning wallet?')) {
      localStorage.removeItem('ss_nwcUri');
      updateNWCButton();
    }
    return;
  }
  const uri = prompt('Paste your nostr+walletconnect:// URI from your wallet (Alby, Mutiny, etc.):');
  if (!uri || !uri.startsWith('nostr+walletconnect://')) {
    if (uri) showToast('Invalid NWC URI — must start with nostr+walletconnect://');
    return;
  }
  localStorage.setItem('ss_nwcUri', uri);
  updateNWCButton();
  showToast('⚡ Lightning wallet connected!');
}
window.connectNWC = connectNWC;

function updateNWCButton() {
  const btn = $('nwcConnectBtn');
  if (!btn) return;
  const connected = !!localStorage.getItem('ss_nwcUri');
  btn.textContent = connected ? 'Connected ⚡' : 'Connect';
  btn.classList.toggle('connected', connected);
}

function showNWCRow() {
  const row = $('nwcSettingRow');
  if (row) row.style.display = myUserId ? '' : 'none';
  updateNWCButton();
}

// ============================================================
//  NIP-51: Follow/Mute List Fetching
// ============================================================
async function fetchFollowAndMuteLists(pubkeyHex) {
  if (!pubkeyHex) return;
  try {
    await nip46Ready;
    const NIP46 = window.NostrNIP46;
    if (!NIP46 || !NIP46.SimplePool) return;

    const pool = new NIP46.SimplePool();
    const relays = ['wss://relay.damus.io', 'wss://relay.nostr.band', 'wss://nos.lol', 'wss://relay.primal.net'];

    // Fetch kind 3 (follow list) and kind 10000 (mute list)
    const events = await Promise.race([
      pool.querySync(relays, { kinds: [3, 10000], authors: [pubkeyHex], limit: 2 }),
      new Promise((_, reject) => setTimeout(() => reject(new Error('timeout')), 5000))
    ]);

    for (const ev of events) {
      const pubkeys = (ev.tags || []).filter(t => t[0] === 'p' && t[1]).map(t => t[1]);
      if (ev.kind === 3) {
        myFollowSet = new Set(pubkeys);
        console.log(`[NIP-51] Loaded ${myFollowSet.size} follows`);
      } else if (ev.kind === 10000) {
        myMuteSet = new Set(pubkeys);
        console.log(`[NIP-51] Loaded ${myMuteSet.size} mutes`);
      }
    }

    pool.close(relays);
    // Re-render nameplates to show friend indicators
    if (gameState) render();
  } catch (e) {
    console.log(`[NIP-51] Failed to fetch lists: ${e.message}`);
  }
}

// ============================================================
//  NIP-58: Badge Toast
// ============================================================
function showBadgeToast(badgeName, badgeIcon) {
  const div = document.createElement('div');
  div.className = 'badge-toast';
  div.innerHTML = `🏆 Badge Earned!<br>${badgeIcon} ${esc(badgeName)}`;
  document.body.appendChild(div);
  setTimeout(() => div.remove(), 3200);
}

async function tryRestoreSession(retries = 2) {
  if (!mySessionToken) return false;
  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      const res = await fetch('/api/auth/session', {
        headers: { 'x-session-token': mySessionToken }
      });
      const data = await res.json();
      if (!data.success) {
        // Session expired — clear and show login
        nostrLogout();
        return false;
      }
      // Restore state from server
      myPubkeyHex = data.pubkeyHex;
      myNpub = data.npub;
      myNostrName = data.profile.name;
      myNostrPicture = data.profile.picture;
      myUserId = myPubkeyHex;
      myUsername = myNostrName || myNpub.slice(0, 12) + '...';
      // NIP-51: Fetch follow/mute lists in background
      fetchFollowAndMuteLists(myPubkeyHex);
      // NIP-47: Show wallet connect option
      showNWCRow();
      return true;
    } catch (err) {
      console.error(`[NOSTR] Session restore attempt ${attempt + 1} failed:`, err);
      if (attempt < retries) {
        await new Promise(r => setTimeout(r, 500 * (attempt + 1))); // 500ms, 1000ms backoff
        continue;
      }
      // All retries exhausted — connect as observer, don't nuke session
      // (user can try sitting down again manually)
      console.warn('[NOSTR] Session restore failed after retries — connecting as observer');
      return false;
    }
  }
  return false;
}

// ============================================================
//  OBSERVER MODE — watch table without authenticating
// ============================================================
function connectAsObserver() {
  isObserver = true;
  if (socket) { socket.disconnect(); socket = null; }
  socket = io(window.location.origin);
  window.socket = socket;

  socket.on('connect', () => {
    // On connect AND reconnect: if we have a seat, rejoin as player; otherwise observe
    if (mySeat && mySessionToken) {
      console.log('[Socket] Reconnecting as seated player (seat', mySeat, ')');
      socket.emit('join-table', {
        tableId: myTableId,
        sessionToken: mySessionToken,
        buyIn: myTableConfig.maxBuyin
      });
    } else {
      socket.emit('observe-table', { tableId: myTableId, sessionToken: mySessionToken || undefined });
    }
  });

  socket.on('observer-joined', ({ observerName: name, userId, nostrName, nostrPicture }) => {
    observerName = name;
    myUsername = nostrName || name;
    if (userId) myUserId = userId;
    updateConnectionStatus(true, myUsername);
  });

  // Share common socket event handlers
  setupCommonSocketHandlers();
}

// ============================================================
//  WEBSOCKET CONNECTION (authenticated player)
// ============================================================
function connectToServer() {
  // If already connected as observer, reuse socket — just emit join-table
  if (socket && socket.connected) {
    isObserver = false;
    const buyIn = pendingBuyIn || 10000;
    socket.emit('join-table', {
      tableId: myTableId,
      sessionToken: mySessionToken,
      preferredSeat: pendingSeat != null ? pendingSeat : undefined,
      buyIn
    });
    pendingSeat = null;
    pendingBuyIn = null;
    return;
  }

  if (socket) { socket.disconnect(); socket = null; }
  socket = io(window.location.origin);
  window.socket = socket;

  socket.on('connect', () => {
    updateConnectionStatus(true, myUsername || null);
    // On connect AND reconnect: always re-emit join-table to restore seat
    const buyIn = pendingBuyIn || 10000;
    socket.emit('join-table', {
      tableId: myTableId,
      sessionToken: mySessionToken,
      preferredSeat: pendingSeat != null ? pendingSeat : undefined,
      buyIn
    });
    pendingSeat = null;
    pendingBuyIn = null;
  });

  // Set up handlers shared with observer mode
  setupCommonSocketHandlers();
}

/**
 * Common socket event handlers — shared between observer and player modes
 */
function setupCommonSocketHandlers() {
  socket.on('seat-assigned', ({ seatIndex, displayName }) => {
    const newSeat = seatIndex + 1;
    if (mySeat && mySeat !== newSeat) {
      console.warn(`[Seat] Seat changed from ${mySeat} to ${newSeat}`);
    }
    mySeat = newSeat;
    isObserver = false;
    if (displayName) myUsername = displayName;
    // Close buy-in dialog if open
    hideBuyinDialog();
    showToast(`Playing as ${myUsername}`, 'info');
    // Request interest list data
    render();
  });

  socket.on('auth-error', ({ message }) => {
    showToast(message);
    nostrLogout();
  });

  // Server fetched our NOSTR profile from relays — update local state
  socket.on('profile-updated', ({ name, picture, lud16 }) => {
    if (name) {
      myUsername = name;
      myNostrName = name;
      localStorage.setItem('ss_nostrName', name);
      showToast(`Welcome, ${name}!`, 'info');
    }
    if (picture) {
      myNostrPicture = picture;
      localStorage.setItem('ss_nostrPicture', picture);
    }
    if (lud16) {
      localStorage.setItem('ss_lud16', lud16);
    }
  });

  socket.on('game-state', (state) => {
    prevGameState = gameState;
    gameState = state;

    // Extract waitlist position for this client
    waitlistPosition = state.waitlistPosition || null;

    // Cache our hole cards so they survive transient state glitches
    if (myUserId) {
      const me = (state.players || []).find(p => p && p.userId === myUserId);
      if (me) {
        const cards = me.holeCards;
        if (cards && cards.length === 2 && cards[0] !== '??' && cards[0]) {
          cachedHoleCards = [...cards];
        } else if (!cards || cards.length === 0) {
          cachedHoleCards = null;
        }
        if (cachedHoleCards && (!cards || cards.length === 0 || (cards.length === 2 && !cards[0]))) {
          me.holeCards = [...cachedHoleCards];
        }
      }
    }

    // Save pot total for chip fly animation
    const currentPot = (state.pot || 0) + (state.players || []).reduce((s, p) => s + (p ? p.currentBet || 0 : 0), 0);
    if (currentPot > 0) savedPotForAnimation = currentPot;
    render();
  });

  socket.on('error', (error) => {
    showToast(error.message);
  });

  socket.on('action-timer-start', ({ playerIndex, timeoutMs, timeBankMs, isPreflop }) => {
    handleTimerStart(playerIndex, timeoutMs, timeBankMs || 0, isPreflop);
  });

  socket.on('time-bank-start', ({ playerIndex, timeBankMs }) => {
    handleTimeBankStart(playerIndex, timeBankMs);
  });

  // Server-side chat messages (with NIP-51 mute filtering)
  socket.on('chat-message', ({ sender, senderId, text, isObserver: fromObserver, timestamp }) => {
    // NIP-51: Skip messages from muted users
    if (senderId && myMuteSet.has(senderId)) return;
    const prefix = fromObserver
      ? (senderId ? `${sender} [observer]` : `[${sender}]`)
      : sender;
    addChatMessage(prefix, text);
  });

  // Table navigator status (all tables)
  socket.on('tables-status', ({ tables }) => {
    cachedTablesStatus = tables || {};
    renderTableNavigator();
  });

  // Table interest updates (for interest-mode tables)
  socket.on('table-interest-update', ({ tableId, interestCount, interestNeeded, players, countdown }) => {
    if (tableId !== myTableId) return;
    tableInterestCount = interestCount;
    tableInterestNeeded = interestNeeded;
    tableInterestPlayers = players || [];
    // Check if we are in the interest list
    const obs = observerName; // our name
    myTableInterested = tableInterestPlayers.some(n => n === myUsername || n === myNostrName || n === observerName);
    if (countdown !== null && countdown !== undefined) {
      tableInterestCountdownSec = countdown;
    }
    updateTableInterestOverlay();
  });

  // Table interest countdown
  socket.on('table-interest-countdown', ({ tableId, seconds }) => {
    if (tableId !== myTableId) return;
    if (seconds === null || seconds === undefined) {
      // Countdown cancelled
      tableInterestCountdownSec = null;
      if (interestCountdownInterval) {
        clearInterval(interestCountdownInterval);
        interestCountdownInterval = null;
      }
      updateTableInterestOverlay();
      return;
    }
    tableInterestCountdownSec = seconds;
    updateTableInterestOverlay();
    // Tick down locally
    if (interestCountdownInterval) clearInterval(interestCountdownInterval);
    interestCountdownInterval = setInterval(() => {
      if (tableInterestCountdownSec !== null && tableInterestCountdownSec > 0) {
        tableInterestCountdownSec--;
        updateTableInterestOverlay();
      } else {
        clearInterval(interestCountdownInterval);
        interestCountdownInterval = null;
      }
    }, 1000);
  });

  // NIP-58: Badge awarded notification
  socket.on('badge-awarded', ({ badgeId, badgeName, badgeIcon }) => {
    showBadgeToast(badgeName, badgeIcon);
    addChatMessage('System', `🏆 You earned the ${badgeIcon} ${badgeName} badge!`, true);
  });

  // Real-time hand log
  socket.on('hand-log', ({ line, type }) => {
    if (!line || !line.trim()) return;
    if (type === 'header' && line.startsWith('Satoshi Stacks Hand')) {
      chipFlyTriggered = false;
      savedPotForAnimation = 0;
      vacuumAnimating = false;
    }
    addPlayByPlay(line);
    currentHandLog.push(line);

    if (type === 'action' && gameState) {
      const lower = line.toLowerCase();
      const colonIdx = line.indexOf(':');
      if (colonIdx > 0) {
        const name = line.substring(0, colonIdx).trim();
        const actionPart = line.substring(colonIdx + 1).trim();
        for (let i = 0; i < NUM_SEATS; i++) {
          const p = gameState.players[i];
          if (p && p.username === name) {
            const vp = calculateVisualPosition(i + 1);
            if (lower.includes('all-in')) {
              showBadge(vp, 'ALL IN', 'allin');
            } else if (lower.includes('folds')) {
              showBadge(vp, 'FOLD', 'fold');
            } else if (lower.includes('checks')) {
              showBadge(vp, 'CHECK', 'check');
            } else if (lower.includes('calls')) {
              const m = actionPart.match(/calls\s+([\d,]+)/i);
              showBadge(vp, m ? `CALL ${m[1]}` : 'CALL', 'call');
            } else if (lower.includes('bets')) {
              const m = actionPart.match(/bets\s+([\d,]+)/i);
              showBadge(vp, m ? `BET ${m[1]}` : 'BET', 'bet');
            } else if (lower.includes('raises')) {
              const m = actionPart.match(/to\s+([\d,]+)/i);
              showBadge(vp, m ? `RAISE TO ${m[1]}` : 'RAISE', 'raise');
            }
            break;
          }
        }
      }
    }
    if (type === 'winner' && gameState) {
      const match = line.match(/^(.+?)\s+collected/);
      if (match) {
        const name = match[1].trim();
        if (!chipFlyTriggered) {
          chipFlyTriggered = true;
          animateChipsToWinner(name);
        }
        for (let i = 0; i < NUM_SEATS; i++) {
          const p = gameState.players[i];
          if (p && p.username === name) {
            const vp = calculateVisualPosition(i + 1);
            showBadge(vp, 'Win');
            break;
          }
        }
      }
    }
  });

  socket.on('hand-complete', ({ history }) => {
    if (history) {
      handHistories.push(history);
      histViewIdx = handHistories.length - 1;
      currentHandLog = [];
      renderHistoryView();
    }
  });

  socket.on('disconnect', () => {
    updateConnectionStatus(false);
    if (mySeat) {
      showToast('Connection lost — reconnecting...', 'info');
    }
  });

  // Observer authenticated while watching
  socket.on('observer-authenticated', ({ observerName: name, userId, nostrName, nostrPicture }) => {
    observerName = name;
    myUsername = nostrName || name;
    myUserId = userId;
    showToast(`Signed in as ${myUsername}`, 'info');
    // NIP-51: Fetch follow/mute lists now that we have a pubkey
    if (userId) fetchFollowAndMuteLists(userId);
    // Request interest list data now that we're authenticated
    render();
  });

  // Waitlist: seat offered to us
  socket.on('seat-available', ({ tableId, timeoutMs }) => {
    seatOfferActive = true;
    showSeatOfferPrompt(timeoutMs);
  });

  // Waitlist: we accepted, now show buy-in
  socket.on('seat-offer-accepted', ({ tableId }) => {
    seatOfferActive = false;
    clearSeatOfferPrompt();
    showBuyinDialog();
  });
}

// ============================================================
//  MAIN RENDER — called on every game-state update
// ============================================================
function render() {
  if (!gameState) return; // Wait for game state

  // In observer mode (no seat), render table but skip player controls
  if (!mySeat) {
    renderSeats();
    updateNameplates();
    renderCommunityCards();
    highlightWinningCards();
    updateBets();
    updatePot();
    // Hide player controls for observers
    const ca = document.querySelector('.controls-area');
    if (ca) ca.classList.remove('visible');
    const preBar = document.querySelector('.pre-action-bar');
    if (preBar) preBar.classList.remove('visible');
    updateSpectatorBadge();
    updateWaitlistUI();
    updateObserverAuthUI();
    updateTableInterestOverlay();
    return;
  }

  // Execute pre-action BEFORE rendering clears it
  if (gameState.yourTurn && preAction) {
    if (executePreAction()) return; // action sent, wait for next state
  }

  renderSeats();
  updateNameplates();
  renderCommunityCards();
  highlightWinningCards();
  updateBets();
  updatePot();
  renderControls();
  renderPreActions();
  updateSitBackInButton();
  updateSitOutButton();
  updateSpectatorBadge();
}

// ============================================================
//  SPECTATOR COUNT BADGE
// ============================================================
function updateSpectatorBadge() {
  const count = gameState?.observerCount || 0;
  let badge = document.getElementById('spectatorBadge');
  if (count <= 0) {
    if (badge) badge.style.display = 'none';
    return;
  }
  if (!badge) {
    badge = document.createElement('div');
    badge.id = 'spectatorBadge';
    badge.className = 'spectator-badge';
    document.body.appendChild(badge);
  }
  badge.style.display = '';
  // Build content: "N watching" + optional sign-in link
  badge.textContent = `${count} watching`;
  // Append sign-in button inline if unauthenticated observer
  if (isObserver && !mySeat && !mySessionToken) {
    const signInLink = document.createElement('span');
    signInLink.id = 'observerSignInBtn';
    signInLink.className = 'observer-sign-in-link';
    signInLink.textContent = 'sign into chat';
    signInLink.dataset.action = 'observer-sign-in';
    badge.appendChild(document.createTextNode(' · '));
    badge.appendChild(signInLink);
  }
}

// ============================================================
//  OBSERVER SIGN-IN (now inline in spectator badge)
// ============================================================
function updateObserverAuthUI() {
  // Sign-in link is now rendered inline by updateSpectatorBadge()
  // This function is kept as a no-op so existing call sites don't break
}

// ============================================================
//  TABLE NAVIGATOR (top-right widget showing all tables)
// ============================================================
let cachedTablesStatus = {}; // { tableId: { playerCount, interestCount, interestedPlayers, handInProgress } }

function renderTableNavigator() {
  const el = document.getElementById('interestList');
  if (!el) return;
  // Hide navigator on the playmoney test table
  if (myTableId === 'playmoney') { el.classList.add('hidden'); return; }
  el.classList.remove('hidden');

  el.innerHTML =
    '<div class="interest-list-title">Game Interest</div>' +
    Object.values(TABLE_CONFIGS).filter(tc => tc.id !== 'playmoney').map(tc => {
      const status = cachedTablesStatus[tc.id] || {};
      const isCurrent = tc.id === myTableId;
      const playerCount = status.playerCount || 0;
      const interestCount = status.interestCount || 0;
      const interestedPlayers = status.interestedPlayers || [];

      let statusText;
      if (status.handInProgress || playerCount > 0) {
        statusText = `${playerCount} playing`;
      } else if (tc.mode === 'interest') {
        statusText = interestCount > 0 ? `${interestCount}/${tc.minPlayers}` : 'empty';
      } else {
        statusText = 'empty';
      }

      const namesHtml = interestedPlayers.length > 0
        ? `<div class="interest-player-names">${interestedPlayers.join(' · ')}</div>`
        : '';

      // Show interest join/leave button for interest-mode tables (not for the table you're viewing as observer — that has the overlay)
      const myName = myUsername || myNostrName || observerName;
      const amInterested = interestedPlayers.some(n => n === myName);
      let interestBtn = '';
      if (tc.mode === 'interest' && mySessionToken && !isCurrent) {
        if (amInterested) {
          interestBtn = `<button class="nav-interest-btn leave" data-action="nav-leave-interest" data-table-id="${tc.id}">Leave</button>`;
        } else {
          interestBtn = `<button class="nav-interest-btn join" data-action="nav-join-interest" data-table-id="${tc.id}">+ Join</button>`;
        }
      }

      // Only link to tables with active games (or open-mode tables)
      const hasActiveGame = status.handInProgress || playerCount > 0;
      const isClickable = tc.mode !== 'interest' || hasActiveGame;
      const labelHtml = isClickable
        ? `<a href="/${tc.id}" class="interest-label-link">${tc.emoji} ${tc.name}</a>`
        : `<span class="interest-label">${tc.emoji} ${tc.name}</span>`;

      return `<div class="interest-row${isCurrent ? ' active' : ''}" data-table="${tc.id}">
        <div class="interest-row-top">
          ${labelHtml}
          <span class="interest-count">${statusText}</span>
          ${interestBtn}
        </div>
        ${namesHtml}
      </div>`;
    }).join('');
}

// ============================================================
//  TABLE INTEREST OVERLAY (for interest-mode tables)
// ============================================================
let myTableInterested = false;
let tableInterestCount = 0;
let tableInterestNeeded = 4;
let tableInterestPlayers = [];
let tableInterestCountdownSec = null;
let interestCountdownInterval = null;

function updateTableInterestOverlay() {
  const overlay = document.getElementById('tableInterestOverlay');
  if (!overlay) return;

  // Only show on interest-mode tables when no game is active
  if (myTableConfig.mode !== 'interest') {
    overlay.classList.add('hidden');
    return;
  }

  // If there's an active game with players, hide the interest overlay
  if (gameState && gameState.players && gameState.players.some(p => p !== null)) {
    overlay.classList.add('hidden');
    return;
  }

  overlay.classList.remove('hidden');

  // Countdown active?
  if (tableInterestCountdownSec !== null && tableInterestCountdownSec > 0) {
    overlay.innerHTML = `
      <div class="table-interest-panel">
        <button class="interest-close-btn" data-action="close-interest-overlay">&times;</button>
        <div class="interest-emoji">${myTableConfig.emoji}</div>
        <div class="interest-table-name">${myTableConfig.name}</div>
        <div class="interest-countdown">⚡ Game starting in ${tableInterestCountdownSec}...</div>
      </div>
    `;
    return;
  }

  const authRequired = !mySessionToken;
  const btnAction = authRequired ? 'interest-sign-in' : (myTableInterested ? 'leave-table-interest' : 'join-table-interest');
  const btnText = authRequired ? 'Sign In to Join' : (myTableInterested ? 'Leave Interest List' : 'Join Interest List');

  const playersList = tableInterestPlayers.length > 0
    ? `<div class="interest-waiting">Waiting: ${tableInterestPlayers.join(' · ')}</div>`
    : '';

  overlay.innerHTML = `
    <div class="table-interest-panel">
      <button class="interest-close-btn" data-action="close-interest-overlay">&times;</button>
      <div class="interest-emoji">${myTableConfig.emoji}</div>
      <div class="interest-table-name">${myTableConfig.name}</div>
      <div class="interest-progress">${tableInterestCount} / ${tableInterestNeeded} players interested</div>
      ${playersList}
      <button class="interest-join-btn${myTableInterested ? ' active' : ''}" data-action="${btnAction}">${btnText}</button>
    </div>
  `;
}

// ============================================================
//  WAITLIST UI
// ============================================================
function updateWaitlistUI() {
  let container = document.getElementById('waitlistUI');

  // Only show for observers (not seated players)
  if (!gameState || mySeat) {
    if (container) container.style.display = 'none';
    return;
  }

  const isFull = gameState.players.every(p => p !== null);
  const waitlistCount = gameState.waitlistCount || 0;

  if (!isFull) {
    // Table has open seats — no waitlist needed
    if (container) container.style.display = 'none';
    return;
  }

  if (!container) {
    container = document.createElement('div');
    container.id = 'waitlistUI';
    container.className = 'waitlist-ui';
    document.getElementById('pokerTable').appendChild(container);
  }
  container.style.display = '';

  if (seatOfferActive) {
    // Seat offer prompt is showing — hide the waitlist UI
    container.style.display = 'none';
    return;
  }

  if (waitlistPosition) {
    container.innerHTML = `
      <div class="waitlist-status">Waitlist: #${waitlistPosition} of ${waitlistCount}</div>
      <button class="waitlist-btn leave-wl" data-action="leave-waitlist">Leave Waitlist</button>
    `;
  } else {
    container.innerHTML = `
      <div class="waitlist-status">Table is full (6/6)${waitlistCount > 0 ? ` \u2014 ${waitlistCount} waiting` : ''}</div>
      <button class="waitlist-btn join-wl" data-action="join-waitlist">Join Waitlist</button>
    `;
  }
}

// ============================================================
//  SEAT OFFER PROMPT (waitlist)
// ============================================================
function showSeatOfferPrompt(timeoutMs) {
  let remaining = Math.ceil(timeoutMs / 1000);

  let el = document.getElementById('seatOfferPrompt');
  if (!el) {
    el = document.createElement('div');
    el.id = 'seatOfferPrompt';
    el.className = 'seat-offer-prompt';
    document.body.appendChild(el);
  }

  function updatePrompt() {
    el.innerHTML = `
      <div class="seat-offer-title">A seat is available!</div>
      <div class="seat-offer-timer">${remaining}s</div>
      <button class="seat-offer-accept" data-action="waitlist-accept">Sit Down</button>
      <button class="seat-offer-decline" data-action="waitlist-decline">Pass</button>
    `;
  }
  updatePrompt();
  el.style.display = 'flex';

  SFX.yourTurn();

  if (seatOfferTimer) clearInterval(seatOfferTimer);
  seatOfferTimer = setInterval(() => {
    remaining--;
    if (remaining <= 0) {
      clearSeatOfferPrompt();
      seatOfferActive = false;
      waitlistPosition = null;
      render();
      return;
    }
    updatePrompt();
  }, 1000);
}

function clearSeatOfferPrompt() {
  if (seatOfferTimer) { clearInterval(seatOfferTimer); seatOfferTimer = null; }
  const el = document.getElementById('seatOfferPrompt');
  if (el) el.style.display = 'none';
}

// ============================================================
//  RENDER SEATS (avatars)
// ============================================================
function renderSeats() {
  for (let idx = 0; idx < NUM_SEATS; idx++) {
    const player = gameState.players[idx];
    const actualSeat = idx + 1;
    const visualPos = calculateVisualPosition(actualSeat);
    const seatEl = $(`seat-${visualPos}`);
    if (!seatEl) continue;

    if (!player) {
      seatEl.className = `seat seat-${visualPos}`;
      if (mySeat) {
        // Hide empty seats when player is already seated — no seat-switching mid-game
        seatEl.innerHTML = '';
      } else {
        // Render clickable empty seat avatar with "EMPTY SEAT" text
        seatEl.innerHTML = `
          <div class="empty-avatar" data-empty-seat="${idx}">
            <span class="empty-label">EMPTY<br>SEAT</span>
          </div>
        `;
      }
      continue;
    }

    const isActive = gameState.currentPlayerIndex === idx && gameState.handInProgress;
    const isMe = player.userId === myUserId;
    const avatarColor = isMe ? 'var(--mustard)' : AVATAR_COLORS[idx % AVATAR_COLORS.length];
    const displayName = esc(player.nostrName || player.username || '?');
    const picture = player.nostrPicture;
    // Only allow http/https image URLs (block javascript: etc.)
    const safePicture = picture && /^https?:\/\//i.test(picture) ? esc(picture) : null;
    const initial = displayName[0] ? displayName[0].toUpperCase() : '?';

    seatEl.className = `seat seat-${visualPos}${player.folded ? ' folded' : ''}`;
    const fallbackAvatar = `<div class="avatar-initial" style="background:${avatarColor};">${initial}</div>`;
    seatEl.innerHTML = `
      <div class="player-avatar-wrap ${isActive ? 'active-turn' : ''}">
        <div class="player-avatar" data-seat="${actualSeat}" data-userid="${esc(player.userId)}" data-is-me="${isMe}" style="cursor:pointer;">
          ${safePicture ? `<img src="${safePicture}" alt="" style="width:100%;height:100%;object-fit:cover;border-radius:50%;" onerror="this.style.display='none';this.nextElementSibling.style.display='flex'">${fallbackAvatar.replace('style="','style="display:none;')}` : fallbackAvatar}
        </div>
      </div>
    `;
  }
}

// ============================================================
//  RENDER NAMEPLATES (chip icon, name, stack, cards, dealer, badges)
// ============================================================
function updateNameplates() {
  for (let idx = 0; idx < NUM_SEATS; idx++) {
    const player = gameState.players[idx];
    const actualSeat = idx + 1;
    const visualPos = calculateVisualPosition(actualSeat);
    const el = $(`nameplate-${visualPos}`);
    if (!el) continue;

    if (!player) {
      // No nameplate for empty seats — the avatar circle shows "EMPTY SEAT"
      el.className = `player-nameplate np-pos-${visualPos} empty-np`;
      el.removeAttribute('data-userid');
      el.removeAttribute('data-is-me');
      el.style.cursor = '';
      el.innerHTML = '';
      continue;
    }

    const isActive = gameState.currentPlayerIndex === idx && gameState.handInProgress;
    const isMe = player.userId === myUserId;

    // Build cards HTML
    let cardsHTML = '';
    if (player.holeCards && player.holeCards.length === 2 && !player.folded) {
      const card1 = player.holeCards[0];
      const card2 = player.holeCards[1];
      if (card1 === '??' || card2 === '??') {
        cardsHTML = `<div class="np-cards">${renderCardHTML(null, 'small')}${renderCardHTML(null, 'small')}</div>`;
      } else {
        const sc = isMe ? '' : 'small';
        // During showdown, only highlight the WINNER's best 5-card hand
        const allDealt = gameState.communityCards && gameState.communityCards.length >= 5;
        const isWinner = player.wonPot;
        const bestCards = allDealt && isWinner && player.hand && player.hand.bestCards ? player.hand.bestCards : null;
        // Winners: dim hole cards not in bestCards. Losers: dim both hole cards entirely.
        const dim1 = allDealt && player.hand ? (bestCards ? (!bestCards.includes(card1) ? ' dimmed' : '') : ' dimmed') : '';
        const dim2 = allDealt && player.hand ? (bestCards ? (!bestCards.includes(card2) ? ' dimmed' : '') : ' dimmed') : '';
        cardsHTML = `<div class="np-cards">${renderCardHTML(card1, sc + dim1)}${renderCardHTML(card2, sc + dim2)}</div>`;
      }
    } else if (isMe && player.folded && player.holeCards && player.holeCards.length === 2 && player.holeCards[0] !== '??') {
      // Folded peek for hero
      cardsHTML = `<div class="np-cards folded-peek">${renderCardHTML(player.holeCards[0])}${renderCardHTML(player.holeCards[1])}</div>`;
    }

    // Dealer button
    const dealerHTML = gameState.dealerSeat === idx ? '<div class="np-dealer">D</div>' : '';

    // Sitting out / busted badge — position away from table center (outer edge of nameplate)
    const badgePos = (visualPos === 3 || visualPos === 4) ? 'badge-bottom' : 'badge-top';
    const sitOutBadge = player.busted
      ? `<div class="status-badge ${badgePos}">BUSTED</div>`
      : player.sittingOut
        ? `<div class="status-badge ${badgePos}">SITTING OUT</div>`
        : '';

    el.className = `player-nameplate np-pos-${visualPos}${isMe ? ' hero' : ''}${player.folded ? ' folded-np' : ''}${isActive ? ' active-np' : ''}`;
    el.setAttribute('data-userid', player.userId);
    el.setAttribute('data-is-me', isMe);
    el.style.cursor = 'pointer';
    el.innerHTML = `
      ${cardsHTML}
      ${dealerHTML}
      ${sitOutBadge}
      <div class="np-life-bar" id="lifeBar-${visualPos}"></div>
      <div class="np-action" id="npAction-${visualPos}"></div>
      <div class="np-content">
        <div class="np-icon">${renderChipPillIcon(player.stack, 24)}</div>
        <span class="np-name">${esc(truncName(player.nostrName || player.username))}</span>${myFollowSet.has(player.userId) && !isMe ? '<span class="np-friend" title="You follow this player">⭐</span>' : ''}${player.badges && player.badges.length ? `<span class="np-badges">${player.badges.map(b => BADGE_ICONS[b] || '').join('')}</span>` : ''}
        <div class="np-divider"></div>
        <div class="np-amount-wrap"><span class="np-amount">${fmt(player.stack)}</span></div>
      </div>
    `;

    // Re-apply active badge after re-render (badges are stored in activeBadges{})
    applyBadge(visualPos);
  }
}

// ============================================================
//  RENDER COMMUNITY CARDS (staggered animation)
// ============================================================
let lastCommunityCount = 0;

function renderCommunityCards() {
  const el = $('communityCards');
  if (!el) return;

  const cards = gameState.communityCards || [];
  const existing = el.children.length;

  // Only append NEW cards — never re-render existing ones (stagger effect)
  for (let i = existing; i < cards.length; i++) {
    const div = document.createElement('div');
    div.className = 'community-card';
    const delayInBatch = i < 3 ? (i * 0.08) : 0;
    div.style.animation = `dealCard 0.4s var(--ease) ${delayInBatch}s both`;
    div.innerHTML = renderCardHTML(cards[i]);
    el.appendChild(div);
  }

  // If cards cleared (new hand), clear DOM
  if (cards.length === 0 && existing > 0) {
    el.innerHTML = '';
  }

  lastCommunityCount = cards.length;
}

/**
 * Highlight winning hand cards on the community board during showdown.
 * Dims community cards that are NOT part of any winner's best 5-card hand.
 */
function highlightWinningCards() {
  if (!gameState || gameState.phase !== 'showdown') return;

  // Only dim cards after all 5 community cards are dealt (not during dramatic runout)
  if (!gameState.communityCards || gameState.communityCards.length < 5) return;

  // Collect bestCards ONLY from winners (not all showdown hands)
  const winningCards = new Set();
  gameState.players.forEach(p => {
    if (p && p.wonPot && p.hand && p.hand.bestCards) {
      p.hand.bestCards.forEach(c => winningCards.add(c));
    }
  });

  // If no evaluated hands yet, skip
  if (winningCards.size === 0) return;

  const el = $('communityCards');
  if (!el) return;
  const cards = gameState.communityCards || [];
  const children = el.children;

  for (let i = 0; i < children.length && i < cards.length; i++) {
    if (winningCards.has(cards[i])) {
      children[i].classList.remove('dimmed');
    } else {
      children[i].classList.add('dimmed');
    }
  }
}

// ============================================================
//  RENDER BETS (chip stacks per player)
// ============================================================
function updateBets() {
  for (let idx = 0; idx < NUM_SEATS; idx++) {
    const player = gameState.players[idx];
    const visualPos = calculateVisualPosition(idx + 1);
    const be = $(`bet-${visualPos}`);
    const bc = $(`betChips-${visualPos}`);
    if (!be) continue;

    if (!player || !player.currentBet || player.currentBet <= 0) {
      be.classList.remove('visible');
      if (bc) bc.innerHTML = '';
      continue;
    }

    be.classList.add('visible');
    if (bc) bc.innerHTML = renderChipStack(player.currentBet, 30, 5);
  }
}

// ============================================================
//  RENDER POT (chip pile + label)
//  Uses server-provided potChips array (actual accumulated chip
//  denomination objects) so every chip is always accounted for.
// ============================================================
function updatePot() {
  if (!gameState) return;
  if (vacuumAnimating) return; // Don't clear pot pile while vacuum animation is running
  const pot = gameState.pot || 0;
  const potChips = gameState.potChips || [];
  const totalWithBets = pot + (gameState.players || []).reduce((s, p) => s + (p ? p.currentBet || 0 : 0), 0);

  $('tablePotAmount').textContent = fmt(totalWithBets);
  const hasValue = totalWithBets > 0;
  $('tablePotLabel').classList.toggle('visible', hasValue);

  // Incremental pot chip pile — only append NEW chips, never re-render existing ones
  const chipsEl = $('tablePotChips');
  if (!chipsEl) return;

  const chipCount = potChips.length;

  if (chipCount === 0) {
    // No chips — clear everything
    chipsEl.classList.remove('visible');
    chipsEl.innerHTML = '';
    renderedPotChipCount = 0;
    potPileRng = null;
    return;
  }

  if (chipCount < renderedPotChipCount) {
    // Chip count decreased — new hand started, full reset and re-render
    chipsEl.innerHTML = '';
    renderedPotChipCount = 0;
    potPileRng = null;
  }

  if (chipCount > renderedPotChipCount) {
    // New chips to add — create PRNG if needed (seeded from dealerSeat for hand stability)
    if (!potPileRng) {
      const dealerSeat = gameState.dealerSeat || 1;
      potPileRng = createPRNG(dealerSeat + 1);
      // Fast-forward PRNG past already-rendered chips (3 rng calls per chip)
      for (let i = 0; i < renderedPotChipCount * 3; i++) potPileRng();
    }
    chipsEl.classList.add('visible');
    const newChips = potChips.slice(renderedPotChipCount);
    appendChipsToPile(newChips, chipsEl, chipCount, 30, potPileRng);
    renderedPotChipCount = chipCount;
  }
  // If chipCount === renderedPotChipCount → nothing to do, chips stay put
}

// ============================================================
//  ACTION BADGE SYSTEM (Fold / Check / Call / Raise / etc.)
//  Stores badge state separately so it survives nameplate re-renders.
// ============================================================
const activeBadges = {}; // { visualPos: { text, cls, expires, timer } }
function showBadge(visualPos, text, cssClass) {
  const cls = cssClass || text.toLowerCase().replace(/[^a-z]/g, '');
  // Clear any previous timer for this position
  if (activeBadges[visualPos] && activeBadges[visualPos].timer) {
    clearTimeout(activeBadges[visualPos].timer);
  }
  const duration = 1500; // 1.5s display time
  // Schedule active removal after duration
  const timer = setTimeout(() => {
    delete activeBadges[visualPos];
    const b = $(`npAction-${visualPos}`);
    if (b) b.className = 'np-action'; // remove 'visible' → triggers opacity transition to 0
  }, duration);
  activeBadges[visualPos] = { text, cls, expires: Date.now() + duration, timer };
  // Apply immediately to current DOM element
  const b = $(`npAction-${visualPos}`);
  if (b) {
    b.textContent = text;
    b.className = `np-action visible ${cls}`;
  }
}
// Called by updateNameplates after re-render to apply/clear badges
function applyBadge(visualPos) {
  const badge = activeBadges[visualPos];
  const b = $(`npAction-${visualPos}`);
  if (!b) return;
  if (badge && Date.now() < badge.expires) {
    b.textContent = badge.text;
    b.className = `np-action visible ${badge.cls}`;
  } else {
    delete activeBadges[visualPos];
    b.className = 'np-action';
  }
}

// ============================================================
//  CHIP VACUUM ANIMATION — chips fly directly from the pot pile
//  to the winner's nameplate like crumbs being vacuumed up.
//  Fixed 2000ms duration. Uses table-relative coordinates
//  (position:absolute inside .poker-table) to avoid the
//  transform-containing-block issue with position:fixed.
// ============================================================
function animateChipsToWinner(winnerName) {
  if (!gameState) return;
  const table = $('pokerTable');
  const potChipsEl = $('tablePotChips');
  if (!table || !potChipsEl) return;

  // Find winner's visual position
  let winnerVisualPos = null;
  for (let i = 0; i < NUM_SEATS; i++) {
    const p = gameState.players[i];
    if (p && p.username === winnerName) {
      winnerVisualPos = calculateVisualPosition(i + 1);
      break;
    }
  }
  if (!winnerVisualPos) return;

  // If pot pile has no visible content, nothing to animate
  const pile = potChipsEl.querySelector('.chip-pile');
  if (!potChipsEl.classList.contains('visible') || !pile) {
    return;
  }

  // Lock the pot pile so updatePot() doesn't clear it mid-animation
  vacuumAnimating = true;

  // Hide pot label
  const potLabel = $('tablePotLabel');
  if (potLabel) potLabel.classList.remove('visible');

  // Show badge
  showBadge(winnerVisualPos, 'Stacking');

  // --- Calculate destination: center of winner's nameplate, in table-relative px ---
  const npEl = $(`nameplate-${winnerVisualPos}`);
  if (!npEl) { vacuumAnimating = false; return; }
  const tableRect = table.getBoundingClientRect();
  const npRect = npEl.getBoundingClientRect();
  const destX = (npRect.left + npRect.width / 2) - tableRect.left;
  const destY = (npRect.top + npRect.height / 2) - tableRect.top;

  // --- Flat 2000ms timing ---
  const TOTAL_DURATION = 2000;
  const CHIP_FLIGHT = 500; // each chip's individual flight time
  const flightSec = '0.50s';

  // Collect chips
  const chips = [...pile.querySelectorAll('.chip-pile-item')];
  if (chips.length === 0) { vacuumAnimating = false; return; }

  // Stagger departures across (total - flight) so last chip arrives at 2000ms
  const staggerWindow = Math.max(0, TOTAL_DURATION - CHIP_FLIGHT);
  const stagger = chips.length > 1 ? staggerWindow / (chips.length - 1) : 0;

  // Allow chips to fly freely out of the pot container
  potChipsEl.style.overflow = 'visible';

  // --- Vacuum: reparent each chip to the table, fly to nameplate ---
  chips.forEach((chip, i) => {
    setTimeout(() => {
      // Snapshot chip's current screen position, convert to table-relative px
      const r = chip.getBoundingClientRect();
      const startX = (r.left + r.width / 2) - tableRect.left;
      const startY = (r.top + r.height / 2) - tableRect.top;

      // Reparent chip from .chip-pile to .poker-table so position:absolute
      // is relative to the table (same coordinate space as nameplates)
      chip.remove();
      table.appendChild(chip);

      // Place at starting position WITHOUT transition first
      chip.style.left = startX + 'px';
      chip.style.top = startY + 'px';
      chip.style.transform = 'translate(-50%, -50%)';

      // Double-rAF: first frame locks the start position in the layout,
      // second frame adds the transition and sets the destination.
      // Without this, the browser may skip the start position entirely.
      requestAnimationFrame(() => {
        chip.style.setProperty('--vac-dur', flightSec);
        chip.classList.add('vacuum-fly');
        requestAnimationFrame(() => {
          chip.style.left = destX + 'px';
          chip.style.top = destY + 'px';
          chip.style.opacity = '0';
        });
      });
    }, i * stagger);
  });

  // Hide the now-emptying pot container so any stray chip isn't visible at the old pot position
  const hideContainerAt = (chips.length - 1) * stagger + 50;
  setTimeout(() => { potChipsEl.classList.remove('visible'); }, hideContainerAt);

  // --- Cleanup after all chips have arrived ---
  setTimeout(() => {
    // Remove ALL chip-pile-items from the table (reparented + any strays)
    table.querySelectorAll('.chip-pile-item').forEach(c => c.remove());
    // Reset pot container
    potChipsEl.classList.remove('visible');
    potChipsEl.innerHTML = '';
    potChipsEl.style.overflow = '';
    renderedPotChipCount = 0;
    potPileRng = null;
    vacuumAnimating = false;
    savedPotForAnimation = 0;
  }, TOTAL_DURATION + 200);
}

// ============================================================
//  RENDER CONTROLS (non-linear slider, presets, action buttons)
// ============================================================
function renderControls() {
  const bc = $('betControls');
  const ca = document.querySelector('.controls-area');
  if (!bc || !ca) return;

  const myPlayer = gameState.players.find(p => p && p.userId === myUserId);
  if (!myPlayer || !gameState.yourTurn || !gameState.handInProgress) {
    ca.classList.remove('visible');
    bc.innerHTML = '';
    return;
  }

  // Position controls
  const tableEl = $('pokerTable');
  if (tableEl) {
    if (isMobileDevice) {
      // On mobile, controls overlay the bottom of the table
      ca.style.maxHeight = '';
    } else {
      const tRect = tableEl.getBoundingClientRect();
      const tableBottom = tRect.bottom + 22;
      const availHeight = window.innerHeight - tableBottom;
      ca.style.maxHeight = Math.max(availHeight, 60) + 'px';
    }
  }
  ca.classList.add('visible');

  const maxBet = Math.max(0, ...gameState.players.filter(p => p).map(p => p.currentBet || 0));
  const toCall = maxBet - (myPlayer.currentBet || 0);
  const canCheck = toCall === 0;

  // Use server's bigBlind or default
  const bigBlind = gameState.bigBlind || 100;
  const lastRaise = gameState.lastRaise || bigBlind;

  const minR = Math.min(maxBet + Math.max(bigBlind, lastRaise), myPlayer.stack + (myPlayer.currentBet || 0));
  const maxR = myPlayer.stack + (myPlayer.currentBet || 0);

  // Check if all opponents are all-in or folded — if so, player can only call/fold (no raise option)
  const opponents = gameState.players.filter((p, i) => p && p.userId !== myUserId && !p.folded);
  const allOpponentsAllIn = opponents.length > 0 && opponents.every(p => p.allIn);
  const canRaise = !allOpponentsAllIn && myPlayer.stack > toCall;

  const callText = canCheck ? 'Check' : (toCall >= myPlayer.stack ? 'All In' : `Call ${fmt(toCall)}`);
  const rLabel = maxBet === 0 ? 'Bet' : 'Raise';

  // Non-linear slider mapping
  const SLIDER_STEPS = 2000;
  const CURVE = 2;
  function sliderToBet(pos) {
    const t = pos / SLIDER_STEPS;
    return Math.round(minR + (maxR - minR) * Math.pow(t, CURVE));
  }
  function betToSlider(bet) {
    const t = (bet - minR) / (maxR - minR);
    return Math.round(SLIDER_STEPS * Math.pow(Math.max(0, t), 1 / CURVE));
  }

  // Total pot for pot-size calculations
  const totalPot = (gameState.pot || 0) + gameState.players.filter(p => p).reduce((s, p) => s + (p.currentBet || 0), 0);

  bc.innerHTML = `
    ${canRaise && maxR > minR ? `<div class="bet-presets">
      <button class="bet-preset" data-amt="${minR}">Min</button>
      <button class="bet-preset" data-amt="${Math.min(Math.floor(totalPot * 0.5 + maxBet), maxR)}">1/2 Pot</button>
      <button class="bet-preset" data-amt="${Math.min(totalPot + maxBet, maxR)}">Pot</button>
      <button class="bet-preset" data-amt="${maxR}">All In</button>
    </div>
    <div class="slider-row">
      <input type="range" class="bet-slider" id="betSlider" min="0" max="${SLIDER_STEPS}" value="0" step="1">
      <input type="number" class="bet-amount-input" id="betInput" min="${minR}" max="${maxR}" value="${minR}">
    </div>` : ''}
    <div class="action-buttons">
      <button class="action-btn btn-fold" id="foldBtn">Fold</button>
      <button class="action-btn btn-check-call" id="ccBtn">${callText}</button>
      ${canRaise && maxR > minR ? `<button class="action-btn btn-raise" id="raiseBtn">${rLabel} ${fmt(minR)}</button>` :
       (canRaise && toCall < myPlayer.stack && maxR > maxBet ? `<button class="action-btn btn-raise" id="raiseBtn">All In ${fmt(myPlayer.stack)}</button>` : '')}
    </div>
  `;

  // Wire up action buttons
  $('foldBtn')?.addEventListener('click', () => sendAction('fold'));
  $('ccBtn')?.addEventListener('click', () => sendAction(canCheck ? 'check' : 'call'));

  const rb = $('raiseBtn'), sl = $('betSlider'), bi = $('betInput');
  function updateBetUI(v) {
    v = Math.max(minR, Math.min(maxR, Math.round(v)));
    if (sl) sl.value = betToSlider(v);
    if (bi) bi.value = v;
    if (rb) rb.textContent = `${v >= maxR ? 'All In' : rLabel} ${fmt(v)}`;
  }
  rb?.addEventListener('click', () => {
    const bet = sl ? sliderToBet(parseInt(sl.value)) : (bi ? parseInt(bi.value) : minR);
    sendAction('raise', bet);
  });
  sl?.addEventListener('input', () => updateBetUI(sliderToBet(parseInt(sl.value))));
  bi?.addEventListener('focus', () => bi.select());
  bi?.addEventListener('input', () => {
    const v = parseInt(bi.value);
    if (!isNaN(v)) {
      const clamped = Math.max(minR, Math.min(maxR, Math.round(v)));
      if (sl) sl.value = betToSlider(clamped);
      if (rb) rb.textContent = `${clamped >= maxR ? 'All In' : rLabel} ${fmt(clamped)}`;
    }
  });
  bi?.addEventListener('blur', () => updateBetUI(parseInt(bi.value) || minR));
  document.querySelectorAll('.bet-preset').forEach(b => {
    b.addEventListener('click', () => {
      const v = Math.min(parseInt(b.dataset.amt), maxR);
      updateBetUI(v);
    });
  });
}

// ============================================================
//  PRE-ACTION SYSTEM
// ============================================================
function renderPreActions() {
  const bar = $('preActionBar');
  if (!bar) return;

  const myPlayer = gameState.players.find(p => p && p.userId === myUserId);
  const isMyTurn = gameState.yourTurn;

  // Hide pre-actions when it's our turn, hand over, folded, or all-in
  if (!myPlayer || isMyTurn || !gameState.handInProgress || myPlayer.folded || myPlayer.allIn) {
    bar.classList.remove('visible');
    if (!gameState.handInProgress || (myPlayer && myPlayer.folded)) {
      bar.innerHTML = '';
      preAction = null;
    }
    return;
  }

  // Only show pre-actions when there's a bet to face (guaranteed to act again).
  // If no one has bet (canCheck), hero might not need to act — hide pre-actions.
  const maxBet = Math.max(0, ...gameState.players.filter(p => p).map(p => p.currentBet || 0));
  const toCall = maxBet - (myPlayer.currentBet || 0);
  const canCheck = toCall === 0;

  if (canCheck) {
    bar.classList.remove('visible');
    bar.innerHTML = '';
    preAction = null;
    return;
  }

  bar.classList.add('visible');

  // Rebuild buttons when call amount changes (e.g., someone re-raises)
  const prevToCall = parseInt(bar.dataset.toCall || '0', 10);
  if (bar.children.length && prevToCall !== toCall) {
    bar.innerHTML = '';
    // Clear pre-action if call amount changed (player may want to reconsider)
    if (preAction === 'call') preAction = null;
  }
  bar.dataset.toCall = toCall;

  // Only rebuild DOM if buttons don't exist yet
  if (!bar.children.length) {
    const callAmt = Math.min(toCall, myPlayer.stack);
    const callLabel = callAmt >= myPlayer.stack ? 'Call All-In' : `Call ${fmt(callAmt)}`;
    let buttonsHTML = '';
    buttonsHTML += `<button class="pre-action-btn" data-pa="call">${callLabel}</button>`;
    buttonsHTML += '<button class="pre-action-btn" data-pa="fold">Fold</button>';
    bar.innerHTML = buttonsHTML;
    bar.querySelectorAll('.pre-action-btn').forEach(btn => {
      btn.addEventListener('click', () => {
        const pa = btn.dataset.pa;
        preAction = (preAction === pa) ? null : pa;
        bar.querySelectorAll('.pre-action-btn').forEach(b => {
          b.classList.toggle('active', b.dataset.pa === preAction);
        });
      });
    });
  }

  // Update active classes
  bar.querySelectorAll('.pre-action-btn').forEach(b => {
    b.classList.toggle('active', b.dataset.pa === preAction);
  });
}

// Execute pre-action when it becomes our turn
function executePreAction() {
  if (!preAction || !gameState.yourTurn) return false;
  const myPlayer = gameState.players.find(p => p && p.userId === myUserId);
  if (!myPlayer) return false;

  const maxBet = Math.max(0, ...gameState.players.filter(p => p).map(p => p.currentBet || 0));
  const toCall = maxBet - (myPlayer.currentBet || 0);
  const canCheck = toCall === 0;

  const pa = preAction;
  preAction = null;

  if (pa === 'call' && toCall > 0) { sendAction('call'); return true; }
  if (pa === 'fold') { sendAction('fold'); return true; }

  return false;
}

// ============================================================
//  SEND ACTION TO SERVER
// ============================================================
function sendAction(action, amount) {
  if (!socket) return;
  // Immediately clear the timer/lifebar on the frontend — don't wait for server round-trip
  clearTimer();
  // Generate unique actionId for deduplication (prevents double-submit)
  const actionId = crypto.randomUUID ? crypto.randomUUID() : (Date.now().toString(36) + Math.random().toString(36).slice(2));
  socket.emit('action', {
    tableId: myTableId,
    action: action,
    amount: amount || 0,
    actionId: actionId
  });
}

// ============================================================
//  ACTION TIMER (LIFE BAR)
// ============================================================
let actionTimer = null;
let timeRemaining = 0;
let currentTurnTime = 20000; // Updated from server timeoutMs each timer start

function lifeBarColor(pct, isTimeBank) {
  let r, g, b;
  if (isTimeBank) {
    // Time bank: blue/purple gradient
    const t = pct / 100;
    r = Math.round(80 + (120 - 80) * t);
    g = Math.round(100 + (140 - 100) * t);
    b = Math.round(200 + (240 - 200) * t);
  } else if (pct > 50) {
    const t = (pct - 50) / 50;
    r = Math.round(232 + (76 - 232) * t);
    g = Math.round(195 + (175 - 195) * t);
    b = Math.round(56 + (80 - 56) * t);
  } else {
    const t = pct / 50;
    r = Math.round(220 + (232 - 220) * t);
    g = Math.round(60 + (195 - 60) * t);
    b = Math.round(60 + (56 - 60) * t);
  }
  return `linear-gradient(135deg, rgba(${r},${g},${b},0.50), rgba(${r},${g},${b},0.35))`;
}

// Track time bank state for the active timer
let timerTimeBankMs = 0;
let timerIsPreflop = true;
let timerVisualPos = null;
let timerIsTimeBank = false;

function handleTimerStart(playerIndex, baseMs, timeBankMs, isPreflop) {
  clearTimer();
  timeRemaining = baseMs;
  currentTurnTime = baseMs;
  timerTimeBankMs = timeBankMs || 0;
  timerIsPreflop = isPreflop;
  timerIsTimeBank = false;
  const visualPos = getVisualPosition(playerIndex);
  timerVisualPos = visualPos;
  if (!visualPos) return;

  // Base timer runs silently — no lifebar shown.
  // Only the timebank lifebar is displayed (handled by handleTimeBankStart).

  // Play "your turn" chime if it's the local player's timer
  const timerPlayer = gameState && gameState.players[playerIndex];
  const isMyTimer = timerPlayer && timerPlayer.userId === myUserId;
  if (isMyTimer) SFX.yourTurn();

  const tick = () => {
    timeRemaining -= 100;
    if (timeRemaining <= 0) {
      clearTimer();
      return;
    }
    actionTimer = setTimeout(tick, 100);
  };
  actionTimer = setTimeout(tick, 100);
}

/**
 * Handle time bank activation from server — switch life bar to time bank phase
 */
function handleTimeBankStart(playerIndex, timeBankMs) {
  clearTimer();
  timerIsTimeBank = true;
  timeRemaining = timeBankMs;
  currentTurnTime = timeBankMs;
  const visualPos = getVisualPosition(playerIndex);
  timerVisualPos = visualPos;
  if (!visualPos) return;

  const bar = $(`lifeBar-${visualPos}`);
  if (bar) {
    bar.style.width = '100%';
    bar.classList.add('active');
    bar.style.background = lifeBarColor(100, true);
  }

  // Play time bank beep for the local player
  const tbPlayer = gameState && gameState.players[playerIndex];
  const isMyTB = tbPlayer && tbPlayer.userId === myUserId;
  if (isMyTB) SFX.timeBankStart();

  const tick = () => {
    timeRemaining -= 100;
    const pct = (timeRemaining / currentTurnTime) * 100;
    const bar = $(`lifeBar-${visualPos}`);
    if (bar) {
      bar.style.width = Math.max(0, pct) + '%';
      bar.classList.add('active');
      bar.style.background = lifeBarColor(pct, true);
    }
    // Countdown beeps for final 5 seconds (local player only)
    if (isMyTB && timeRemaining > 0 && timeRemaining <= 5000 && timeRemaining % 1000 < 100) {
      SFX.countdownBeep();
    }
    if (timeRemaining <= 0) {
      clearTimer();
      return;
    }
    actionTimer = setTimeout(tick, 100);
  };
  actionTimer = setTimeout(tick, 100);
}

function clearTimer() {
  if (actionTimer) {
    clearTimeout(actionTimer);
    actionTimer = null;
  }
  timerIsTimeBank = false;
  for (let i = 1; i <= 6; i++) {
    const bar = $(`lifeBar-${i}`);
    if (bar) {
      bar.classList.remove('active');
      bar.style.width = '0%';
    }
  }
}

// ============================================================
//  DEAL ANIMATION (cards fly from dealer to players)
// ============================================================
function animateDeal() {
  if (!gameState || !gameState.handInProgress) return;
  const table = $('pokerTable');
  if (!table) return;

  // Find dealer's visual position for origin
  const dealerVisual = getVisualPosition(gameState.dealerSeat);
  if (!dealerVisual) return;
  const origin = NP_TARGETS[dealerVisual];

  // Build dealing order: clockwise from left of dealer
  const dealOrder = [];
  let seat = gameState.dealerSeat;
  for (let t = 0; t < NUM_SEATS; t++) {
    seat = (seat + 1) % NUM_SEATS;
    const p = gameState.players[seat];
    if (p && !p.folded && p.holeCards && p.holeCards.length === 2) {
      dealOrder.push(seat);
    }
  }
  if (dealOrder.length === 0) return;

  // Two rounds
  const fullOrder = [...dealOrder, ...dealOrder];
  const STAGGER = 120;
  const FLIGHT = 250;

  fullOrder.forEach((playerIdx, i) => {
    const targetVisual = calculateVisualPosition(playerIdx + 1);
    const target = NP_TARGETS[targetVisual];

    setTimeout(() => {
      const flyEl = document.createElement('div');
      flyEl.className = 'deal-card-fly';
      flyEl.innerHTML = renderCardHTML(null, 'small');
      flyEl.style.top = origin.top + '%';
      flyEl.style.left = origin.left + '%';
      flyEl.style.transform = 'translate(-50%,-50%) scale(0.7) rotate(' + (Math.random() * 20 - 10) + 'deg)';
      table.appendChild(flyEl);

      requestAnimationFrame(() => {
        requestAnimationFrame(() => {
          flyEl.style.top = target.top + '%';
          flyEl.style.left = target.left + '%';
          flyEl.style.transform = 'translate(-50%,-50%) scale(1) rotate(0deg)';
        });
      });

      setTimeout(() => flyEl.remove(), FLIGHT + 50);
    }, i * STAGGER);
  });
}

// ============================================================
//  CHAT SYSTEM
// ============================================================
const chatSettings = { sound: 'all', playerChat: true, playByPlay: true, autoMuck: true };

function addChatMessage(author, text, isSystem) {
  const el = $('chatMessages');
  if (!el) return;
  const div = document.createElement('div');
  div.className = 'chat-msg' + (isSystem ? ' system-msg' : '');
  if (isSystem) {
    div.textContent = text;
  } else {
    div.innerHTML = `<span class="chat-author">${esc(author)}:</span> ${esc(text)}`;
  }
  el.appendChild(div);
  el.scrollTop = el.scrollHeight;
  while (el.children.length > 80) el.removeChild(el.firstChild);
  if (!isSystem) signalMobileUnread();
}

function addPlayByPlay(text) {
  if (!chatSettings.playByPlay) return;
  const el = $('chatMessages');
  if (!el) return;
  const div = document.createElement('div');
  div.className = 'chat-msg play-by-play';
  div.textContent = text;
  el.appendChild(div);
  el.scrollTop = el.scrollHeight;
  while (el.children.length > 80) el.removeChild(el.firstChild);
}

// ============================================================
//  HAND HISTORY SYSTEM
// ============================================================
const handHistories = [];
let histViewIdx = -1;

function renderHistoryView() {
  const label = $('histLabel');
  const text = $('histText');
  const prev = $('histPrev');
  const next = $('histNext');
  if (!label || !text) return;

  if (handHistories.length === 0) {
    label.textContent = 'No hands yet';
    text.textContent = '';
    if (prev) prev.disabled = true;
    if (next) next.disabled = true;
    return;
  }

  const idx = Math.max(0, Math.min(histViewIdx, handHistories.length - 1));
  histViewIdx = idx;
  label.textContent = `Hand ${idx + 1} / ${handHistories.length}`;
  text.textContent = handHistories[idx];
  if (prev) prev.disabled = idx <= 0;
  if (next) next.disabled = idx >= handHistories.length - 1;
}

// ============================================================
//  INIT CHAT (tabs, send, settings, history navigation)
// ============================================================
function initChat() {
  const tabs = document.querySelectorAll('.chat-tab');
  const bodies = {
    chat: $('chatMessages'),
    history: $('chatHistory'),
    settings: $('chatSettings'),
  };
  const inputArea = $('chatInputArea');

  tabs.forEach(tab => {
    tab.addEventListener('click', () => {
      const t = tab.dataset.tab;
      tabs.forEach(tt => tt.classList.toggle('active', tt === tab));
      Object.entries(bodies).forEach(([key, el]) => {
        if (!el) return;
        if (key === 'chat') {
          el.style.display = t === 'chat' ? 'flex' : 'none';
        } else {
          el.classList.toggle('visible', t === key);
          el.style.display = t === key ? 'flex' : 'none';
        }
      });
      if (inputArea) inputArea.style.display = t === 'chat' ? 'flex' : 'none';
      if (t === 'history') renderHistoryView();
    });
  });

  // History navigation
  $('histPrev')?.addEventListener('click', () => {
    if (histViewIdx > 0) { histViewIdx--; renderHistoryView(); }
  });
  $('histNext')?.addEventListener('click', () => {
    if (histViewIdx < handHistories.length - 1) { histViewIdx++; renderHistoryView(); }
  });
  $('histCopy')?.addEventListener('click', () => {
    if (handHistories.length === 0) return;
    const idx = Math.max(0, Math.min(histViewIdx, handHistories.length - 1));
    navigator.clipboard.writeText(handHistories[idx]).then(() => {
      const btn = $('histCopy');
      btn.classList.add('copied');
      btn.textContent = '\u2713';
      setTimeout(() => { btn.classList.remove('copied'); btn.textContent = '\uD83D\uDCCB'; }, 1500);
    }).catch(() => {});
  });

  // Send message (server-side relay)
  const input = $('chatInput');
  const sendMsg = () => {
    const text = input.value.trim();
    if (!text) return;
    if (socket && socket.connected) {
      socket.emit('chat-message', { text });
    }
    input.value = '';
  };
  $('chatSendBtn')?.addEventListener('click', sendMsg);
  input?.addEventListener('keydown', e => { if (e.key === 'Enter') sendMsg(); });

  // Collapse toggle
  $('chatCollapseBtn')?.addEventListener('click', () => {
    $('chatBox')?.classList.toggle('collapsed');
  });

  // Settings toggles
  document.querySelectorAll('.setting-toggle').forEach(tog => {
    tog.addEventListener('click', () => {
      tog.classList.toggle('on');
      const key = tog.dataset.setting;
      if (key) chatSettings[key] = tog.classList.contains('on');
      const box = $('chatBox');
      if (key === 'playerChat') box?.classList.toggle('hide-chat', !chatSettings.playerChat);
      if (key === 'playByPlay') box?.classList.toggle('hide-pbp', !chatSettings.playByPlay);
    });
  });

  // Sound cycle button (Off → Alerts → All → Off ...)
  document.querySelectorAll('.setting-cycle').forEach(btn => {
    btn.addEventListener('click', () => {
      const cycle = { off: 'alerts', alerts: 'all', all: 'off' };
      const labels = { off: 'Off', alerts: 'Alerts', all: 'All' };
      const cur = btn.dataset.value;
      const next = cycle[cur] || 'all';
      btn.dataset.value = next;
      btn.textContent = labels[next];
      chatSettings.sound = next;
    });
  });
}

// ============================================================
//  MOBILE CHAT TOGGLE
// ============================================================
function initMobileChat() {
  if (!isMobileDevice) return;

  // Create backdrop
  const backdrop = document.createElement('div');
  backdrop.className = 'mobile-chat-backdrop';
  backdrop.id = 'mobileChatBackdrop';
  document.body.appendChild(backdrop);

  // Create toggle button
  const chatToggle = document.createElement('button');
  chatToggle.className = 'mobile-chat-toggle';
  chatToggle.id = 'mobileChatToggle';
  chatToggle.innerHTML = '&#x1F4AC;';
  chatToggle.title = 'Toggle chat';
  document.body.appendChild(chatToggle);

  const chatBox = document.getElementById('chatBox');

  function openChat() {
    chatBox.classList.add('mobile-open');
    backdrop.classList.add('visible');
    chatToggle.classList.add('chat-active');
    chatToggle.classList.remove('has-unread');
  }
  function closeChat() {
    chatBox.classList.remove('mobile-open');
    backdrop.classList.remove('visible');
    chatToggle.classList.remove('chat-active');
  }

  chatToggle.addEventListener('click', (e) => {
    e.stopPropagation();
    if (chatBox.classList.contains('mobile-open')) {
      closeChat();
    } else {
      openChat();
    }
  });

  // Close on backdrop tap
  backdrop.addEventListener('click', closeChat);
}

function signalMobileUnread() {
  if (!isMobileDevice) return;
  const chatBox = document.getElementById('chatBox');
  const toggle = document.getElementById('mobileChatToggle');
  if (toggle && chatBox && !chatBox.classList.contains('mobile-open')) {
    toggle.classList.add('has-unread');
  }
}

// ============================================================
//  LIGHTNING BOLTS BACKGROUND
// ============================================================
const BOLT_PATHS = [
  { w: 60, h: 110, vb: '0 0 60 110', d: 'M35 2 L18 42 L32 42 L12 108' },
  { w: 80, h: 120, vb: '0 0 80 120', d: 'M45 2 L28 45 L42 45 L22 90 M42 45 L58 88' },
  { w: 50, h: 90,  vb: '0 0 50 90',  d: 'M30 4 L14 36 L28 32 L8 86' },
  { w: 35, h: 70,  vb: '0 0 35 70',  d: 'M20 2 L10 28 L22 28 L8 68' },
  { w: 55, h: 100, vb: '0 0 55 100', d: 'M32 3 L15 40 L30 38 L10 97' },
  { w: 40, h: 75,  vb: '0 0 40 75',  d: 'M25 2 L12 30 L24 28 L8 73' },
  { w: 70, h: 110, vb: '0 0 70 110', d: 'M40 3 L25 42 L38 40 L18 80 M38 40 L55 78' },
];

function spawnBolt() {
  const container = $('bgDecor');
  if (!container) return;
  const bp = BOLT_PATHS[Math.floor(Math.random() * BOLT_PATHS.length)];
  const scale = 0.7 + Math.random() * 0.6;
  const rot = -40 + Math.random() * 80;
  const x = 3 + Math.random() * 94;
  const y = 3 + Math.random() * 94;
  const sw = (1.5 + Math.random() * 1.5).toFixed(1);
  const alpha = (0.12 + Math.random() * 0.10).toFixed(2);

  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  svg.setAttribute('width', Math.round(bp.w * scale));
  svg.setAttribute('height', Math.round(bp.h * scale));
  svg.setAttribute('viewBox', bp.vb);
  svg.setAttribute('fill', 'none');
  svg.style.cssText = `top:${y}%;left:${x}%;transform:rotate(${rot}deg);`;

  const path = document.createElementNS('http://www.w3.org/2000/svg', 'path');
  path.setAttribute('d', bp.d);
  path.setAttribute('stroke', `rgba(232,168,56,${alpha})`);
  path.setAttribute('stroke-width', sw);
  path.setAttribute('stroke-linecap', 'round');
  path.setAttribute('stroke-linejoin', 'round');
  svg.appendChild(path);
  container.appendChild(svg);

  requestAnimationFrame(() => {
    svg.classList.add('bolt-visible');
    const holdTime = 800 + Math.random() * 1500;
    setTimeout(() => {
      svg.classList.remove('bolt-visible');
      svg.classList.add('bolt-fade');
      setTimeout(() => svg.remove(), 1600);
    }, holdTime);
  });
}

function scheduleBolt() {
  const delay = 3000 + Math.random() * 6000;
  setTimeout(() => {
    spawnBolt();
    scheduleBolt();
  }, delay);
}

// ============================================================
//  RESIZE / ORIENTATION HANDLERS
// ============================================================
let resizeTimer;

function checkOrientation() {
  if (!isMobileDevice) return;
  const overlay = document.getElementById('rotateOverlay');
  if (!overlay) return;
  const isPortrait = window.innerHeight > window.innerWidth;
  if (isPortrait) {
    overlay.classList.add('visible');
  } else {
    overlay.classList.remove('visible');
  }
}

window.addEventListener('resize', () => {
  clearTimeout(resizeTimer);
  resizeTimer = setTimeout(() => {
    checkOrientation();
    if (gameState) render();
  }, 100);
});
window.addEventListener('orientationchange', () => {
  setTimeout(() => {
    checkOrientation();
    if (gameState) render();
  }, 300);
});

// ============================================================
//  CONNECTION STATUS
// ============================================================
function updateConnectionStatus(connected, name) {
  const statusEl = $('connectionStatus');
  const textEl = $('connectionText');
  if (connected) {
    statusEl.style.background = 'var(--sage)';
    textEl.textContent = name ? `\u25CF  Connected as ${name}` : '\u25CF  Connected';
    statusEl.style.display = 'block';
    setTimeout(() => { statusEl.style.display = 'none'; }, 3000);
  } else {
    statusEl.style.background = 'var(--rust)';
    textEl.textContent = '\u25CF  Disconnected';
    statusEl.style.display = 'block';
  }
}

// ============================================================
//  TOAST NOTIFICATIONS
// ============================================================
function showToast(message, type) {
  const container = $('toastContainer');
  if (!container) return;
  const toast = document.createElement('div');
  toast.style.cssText = `
    padding: 12px 20px;
    border-radius: 8px;
    font-size: 13px;
    font-weight: 700;
    color: var(--warm-white);
    background: ${type === 'info' ? 'var(--sage)' : 'var(--rust)'};
    box-shadow: 0 4px 12px rgba(0,0,0,0.3);
    animation: slideIn 0.3s ease;
    max-width: 300px;
  `;
  toast.textContent = message;
  container.appendChild(toast);
  setTimeout(() => {
    toast.style.animation = 'slideOut 0.3s ease';
    setTimeout(() => toast.remove(), 300);
  }, 4000);
}

// ============================================================
//  SIT BACK IN
// ============================================================
window.handleSitBackIn = function() {
  if (!socket) return;
  socket.emit('sit-back-in', { tableId: myTableId });
  $('sitBackInBtn').style.display = 'none';
};

function updateSitBackInButton() {
  const btn = $('sitBackInBtn');
  if (!btn || !gameState) return;
  const myPlayer = gameState.players?.find(p => p && p.userId === myUserId);
  // Show sit-back-in only for sitting out (not busted — busted players click nameplate to rebuy)
  btn.style.display = (myPlayer && myPlayer.sittingOut && !myPlayer.busted) ? 'block' : 'none';
}

// ============================================================
//  VOLUNTARY SIT OUT
// ============================================================
window.handleSitOut = function() {
  if (!socket) return;
  socket.emit('sit-out', { tableId: myTableId });
};

// ============================================================
//  STAND UP (leave seat, become observer)
// ============================================================
window.handleStandUp = function() {
  if (!socket) return;
  mySeat = null;
  localStorage.setItem('ss_stoodUp', '1');

  let left = false;
  function finishStandUp() {
    if (left) return;
    left = true;
    if (socket) {
      socket.disconnect();
      socket = null;
    }
    connectAsObserver();
  }

  // Wait for server ack before disconnecting so leave-table is actually processed
  socket.emit('leave-table', { tableId: myTableId }, finishStandUp);
  // Fallback: if ack never arrives (network issue), disconnect after 2s
  setTimeout(finishStandUp, 2000);
};

// ============================================================
//  TABLE ACTIONS VISIBILITY (Sit Out + Stand Up bar)
// ============================================================
function updateTableActions() {
  const bar = $('tableActionsBar');
  const sitOutBtn = $('sitOutBtn');
  const standUpBtn = $('standUpBtn');
  if (!bar || !sitOutBtn || !standUpBtn || !gameState) return;

  const myPlayer = gameState.players?.find(p => p && p.userId === myUserId);

  // Not seated → hide entire bar
  if (!myPlayer) {
    bar.classList.remove('visible');
    return;
  }

  // Seated → show bar (Stand Up is always available)
  bar.classList.add('visible');
  standUpBtn.style.display = 'block';

  // Sit Out button: only when actively playing (not sitting out, not busted)
  if (myPlayer.sittingOut || myPlayer.busted) {
    sitOutBtn.style.display = 'none';
  } else if (myPlayer.sittingOutNextHand) {
    sitOutBtn.style.display = 'block';
    sitOutBtn.textContent = 'Cancel Sit Out';
    sitOutBtn.className = 'table-action-btn cancel-sit-out';
  } else {
    sitOutBtn.style.display = 'block';
    sitOutBtn.textContent = 'Sit Out Next Hand';
    sitOutBtn.className = 'table-action-btn';
  }
}

// Keep old name as alias for any existing calls
function updateSitOutButton() { updateTableActions(); }

// ============================================================
//  AVATAR / NAMEPLATE CLICK HANDLERS
// ============================================================

// Delegated click handler for EMPTY seats
document.addEventListener('click', (e) => {
  const emptySeatEl = e.target.closest('[data-empty-seat]');
  if (!emptySeatEl) return;

  const seatIdx = parseInt(emptySeatEl.dataset.emptySeat, 10);
  if (isNaN(seatIdx) || seatIdx < 0 || seatIdx >= NUM_SEATS) return;

  // Already seated? Ignore
  if (mySeat) return;

  pendingSeat = seatIdx;

  if (mySessionToken) {
    // Already authenticated — show buy-in dialog
    showBuyinDialog();
  } else {
    // Need to authenticate first
    handleNostrLoginThenSit();
  }
});

// Delegated click handler for avatars and nameplates
document.addEventListener('click', (e) => {
  // Check for empty seat clicks first (handled above)
  if (e.target.closest('[data-empty-seat]')) return;

  // Find the clicked avatar or nameplate
  const avatar = e.target.closest('.player-avatar[data-userid]');
  const nameplate = e.target.closest('.player-nameplate[data-userid]');
  const target = avatar || nameplate;
  if (!target) return;

  const userId = target.dataset.userid;
  const isMe = target.dataset.isMe === 'true';

  if (isMe) {
    // Clicking your own avatar/nameplate → rebuy option
    showRebuyDialog();
  } else {
    // Clicking another player → show profile popup
    showPlayerProfile(userId);
  }
});

function showRebuyDialog() {
  if (!gameState || !socket) return;
  const myPlayer = gameState.players?.find(p => p && p.userId === myUserId);
  if (!myPlayer) return;

  if (myPlayer.stack >= 10000) {
    showToast('Stack is already at 10,000');
    return;
  }

  // Show buy-in dialog for rebuy
  buyinMode = 'rebuy';
  showBuyinDialog();
}

function showPlayerProfile(userId) {
  if (!gameState) return;
  const player = gameState.players?.find(p => p && p.userId === userId);
  if (!player) return;

  const displayName = player.nostrName || player.username || 'Unknown';
  const npubShort = player.userId ? 'npub1' + player.userId.slice(0, 8) + '...' : '';

  // Remove existing popup if any
  const existing = document.getElementById('playerProfilePopup');
  if (existing) existing.remove();

  const popup = document.createElement('div');
  popup.id = 'playerProfilePopup';
  popup.style.cssText = `
    position:fixed;top:50%;left:50%;transform:translate(-50%,-50%);
    background:var(--felt-dark);border:2px solid var(--outline);border-radius:16px;
    padding:24px 32px;z-index:2000;box-shadow:0 12px 40px rgba(0,0,0,0.6);
    text-align:center;min-width:240px;font-family:inherit;
  `;

  // Use player's actual seat-based avatar color instead of hardcoded [0]
  const playerIdx = gameState.players.findIndex(p => p && p.userId === userId);
  const avatarColor = playerIdx >= 0 ? AVATAR_COLORS[playerIdx % AVATAR_COLORS.length] : AVATAR_COLORS[0];
  const safeDisplayName = esc(displayName);
  const initial = displayName[0]?.toUpperCase() || '?';
  const picture = player.nostrPicture;
  const safePic = picture && /^https?:\/\//i.test(picture) ? picture : null;
  const avatarHTML = safePic
    ? `<img src="${esc(safePic)}" style="width:64px;height:64px;border-radius:50%;object-fit:cover;border:3px solid var(--outline);">`
    : `<div style="width:64px;height:64px;border-radius:50%;background:${avatarColor};display:flex;align-items:center;justify-content:center;font-size:28px;font-weight:900;color:var(--text-dark);border:3px solid var(--outline);margin:0 auto;">${esc(initial)}</div>`;

  // Sanitize userId (hex pubkey should only contain [0-9a-f])
  const safeUserId = player.userId.replace(/[^0-9a-f]/gi, '');

  popup.innerHTML = `
    <div style="margin-bottom:12px;">${avatarHTML}</div>
    <div style="font-size:18px;font-weight:800;color:var(--warm-white);margin-bottom:4px;">${safeDisplayName}</div>
    <div style="font-size:12px;color:var(--muted);margin-bottom:12px;font-family:monospace;">${esc(npubShort)}</div>
    <div style="font-size:14px;color:var(--warm-white);margin-bottom:16px;">Stack: ${player.stack.toLocaleString()}</div>
    <div style="display:flex;gap:8px;justify-content:center;">
      <button data-action="view-nostr-profile" data-user-id="${safeUserId}"
        style="padding:8px 16px;border-radius:8px;border:2px solid var(--outline);background:var(--navy);color:var(--warm-white);font-weight:700;font-size:13px;cursor:pointer;">
        View on NOSTR
      </button>
      <button data-action="close-profile-popup"
        style="padding:8px 16px;border-radius:8px;border:2px solid var(--outline);background:var(--rust);color:var(--warm-white);font-weight:700;font-size:13px;cursor:pointer;">
        Close
      </button>
    </div>
  `;

  document.body.appendChild(popup);

  // Close on click outside
  setTimeout(() => {
    document.addEventListener('click', function closer(ev) {
      if (!popup.contains(ev.target)) {
        popup.remove();
        document.removeEventListener('click', closer);
      }
    });
  }, 100);
}

// showToast is defined above (line 3099) — removed duplicate

// ============================================================
//  BUY-IN DIALOG
// ============================================================
let pendingBuyIn = null;
let buyinMode = 'sit'; // 'sit' or 'rebuy'

function showBuyinDialog() {
  const overlay = $('buyinOverlay');
  const slider = $('buyinSlider');
  const display = $('buyinAmountDisplay');
  const title = overlay?.querySelector('.buyin-title');

  if (!overlay || !slider) return;

  // Set dialog mode
  if (buyinMode === 'rebuy') {
    if (title) title.textContent = 'Reload your stack';
  } else {
    if (title) title.textContent = 'Choose your buy-in';
  }

  // Set slider range from table config
  slider.min = myTableConfig.minBuyin;
  slider.max = myTableConfig.maxBuyin;
  slider.step = Math.max(500, Math.floor(myTableConfig.minBuyin / 2));
  slider.value = myTableConfig.maxBuyin;
  if (display) display.textContent = myTableConfig.maxBuyin.toLocaleString();

  overlay.classList.remove('hidden');
}

function hideBuyinDialog() {
  const overlay = $('buyinOverlay');
  if (overlay) overlay.classList.add('hidden');
  buyinMode = 'sit';
}

function initBuyinDialog() {
  const slider = $('buyinSlider');
  const display = $('buyinAmountDisplay');
  const sitBtn = $('buyinSitBtn');
  const cancelBtn = $('buyinCancelBtn');

  if (slider && display) {
    slider.addEventListener('input', () => {
      display.textContent = parseInt(slider.value).toLocaleString();
    });
  }

  if (sitBtn) {
    sitBtn.addEventListener('click', () => {
      const amount = parseInt(slider?.value || myTableConfig.maxBuyin);

      if (buyinMode === 'rebuy') {
        // Rebuy mode — emit rebuy with chosen amount
        if (socket) {
          socket.emit('rebuy', { tableId: myTableId, buyIn: amount });
        }
        hideBuyinDialog();
      } else {
        // Sit-down mode — join table with chosen buy-in
        pendingBuyIn = amount;
        localStorage.removeItem('ss_stoodUp');
        hideBuyinDialog();
        connectToServer();
      }
    });
  }

  if (cancelBtn) {
    cancelBtn.addEventListener('click', () => {
      pendingSeat = null;
      pendingBuyIn = null;
      hideBuyinDialog();
    });
  }
}

/**
 * Nostr login flow triggered by clicking an empty seat.
 * After successful auth, shows buy-in dialog.
 */
async function handleNostrLoginThenSit() {
  loginIntent = 'sit';
  // Show the login overlay with method selection
  // pendingSeat is already set by the click handler
  // When any login method completes, showBuyinDialog() will run
  showLoginOverlay();
}

// Sign in as observer (show Nostr profile without sitting down)
function handleObserverSignIn() {
  loginIntent = 'observe';
  pendingSeat = null;
  showLoginOverlay();
}

// ============================================================
//  INIT
// ============================================================
async function init() {
  // Set page title from table config
  document.title = `${myTableConfig.emoji} ${myTableConfig.name} – Satoshi Stacks`;

  initChat();
  initBuyinDialog();
  scheduleBolt();
  checkOrientation();
  initMobileChat();
  renderTableNavigator();
  updateTableInterestOverlay();

  // Try to restore existing NOSTR session
  const hasSession = await tryRestoreSession();
  if (hasSession) {
    hideLoginOverlay();
    // If player voluntarily stood up, reconnect as observer — don't auto-rejoin
    if (localStorage.getItem('ss_stoodUp')) {
      connectAsObserver();
    } else {
      connectToServer();
    }
  } else {
    // No session — connect as observer (see table immediately)
    connectAsObserver();
  }
}

if (document.readyState === 'loading') {
  window.addEventListener('DOMContentLoaded', init);
} else {
  init();
}

// Event delegation for data-action buttons (eliminates inline onclick handlers)
document.addEventListener('click', (e) => {
  const actionEl = e.target.closest('[data-action]');
  if (!actionEl) return;

  const action = actionEl.dataset.action;
  switch (action) {
    case 'sit-back-in': handleSitBackIn(); break;
    case 'sit-out': handleSitOut(); break;
    case 'stand-up': handleStandUp(); break;
    case 'connect-nwc': window.connectNWC(); break;
    case 'copy-qr-link': copyQRLink(); break;
    case 'switch-to-bunker': switchToBunkerFromQR(); break;
    case 'login-go-back': loginGoBack(); break;
    case 'login-cancel': cancelLogin(); break;
    case 'join-waitlist':
      if (socket) socket.emit('join-waitlist', { tableId: myTableId });
      break;
    case 'leave-waitlist':
      if (socket) socket.emit('leave-waitlist', { tableId: myTableId });
      waitlistPosition = null;
      break;
    case 'waitlist-accept':
      if (socket) socket.emit('waitlist-accept', { tableId: myTableId });
      break;
    case 'waitlist-decline':
      if (socket) socket.emit('leave-waitlist', { tableId: myTableId });
      clearSeatOfferPrompt();
      seatOfferActive = false;
      waitlistPosition = null;
      break;
    case 'join-table-interest':
      if (socket) socket.emit('join-table-interest', { tableId: myTableId });
      myTableInterested = true;
      // Auto-close overlay so the user can see table action
      document.getElementById('tableInterestOverlay')?.classList.add('hidden');
      break;
    case 'leave-table-interest':
      if (socket) socket.emit('leave-table-interest', { tableId: myTableId });
      myTableInterested = false;
      updateTableInterestOverlay();
      break;
    case 'nav-join-interest': {
      const tid = actionEl.dataset.tableId;
      if (socket && tid) socket.emit('join-table-interest', { tableId: tid });
      break;
    }
    case 'nav-leave-interest': {
      const tid = actionEl.dataset.tableId;
      if (socket && tid) socket.emit('leave-table-interest', { tableId: tid });
      break;
    }
    case 'close-interest-overlay':
      document.getElementById('tableInterestOverlay')?.classList.add('hidden');
      break;
    case 'interest-sign-in':
      loginIntent = 'observe';
      showLoginOverlay();
      break;
    case 'observer-sign-in': handleObserverSignIn(); break;
    case 'submit-bunker': submitBunkerLogin(); break;
    case 'nip07-login': handleNIP07Login(); break;
    case 'start-qr-login': startQRCodeLogin(); break;
    case 'show-bunker': showBunkerScreen(); break;
    case 'deep-link-login': startDeepLinkLogin(actionEl.dataset.provider || 'Nostr'); break;
    case 'view-nostr-profile': {
      const uid = actionEl.dataset.userId;
      if (uid) window.open('https://njump.me/' + uid, '_blank');
      const popup = document.getElementById('playerProfilePopup');
      if (popup) popup.remove();
      break;
    }
    case 'close-profile-popup': {
      const popup = document.getElementById('playerProfilePopup');
      if (popup) popup.remove();
      break;
    }
  }
});

})();
