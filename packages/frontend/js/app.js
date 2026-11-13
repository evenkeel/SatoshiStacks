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
  station100: { id: 'station100', name: 'Station 100', emoji: '', smallBlind: 50, bigBlind: 100, minBuyin: 5000, maxBuyin: 10000, mode: 'open', minPlayers: 2, realMoney: true },
};

function getTableIdFromPath() {
  const path = window.location.pathname.replace(/\/$/, '').split('/').pop();
  return TABLE_CONFIGS[path] ? path : 'station100';
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
  return isMobileUA || (isTouchDevice && isSmallScreen);
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
let preActionToCall = null;  // Exact wager accepted when selecting Call
let currentHandLog = [];     // Accumulates hand-log lines for current hand
const potPile = window.StacksPotPile.create(); // Settled chips persist for the hand.
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

// ============================================================
//  CARD RENDERING (from beautiful version)
// ============================================================
// One vector deck is shared by the table and the deck preview.
const renderCardHTML = window.SatoshiDeck.renderCardHTML;
const tableMotion = window.StacksTableMotion.create({
  table: $('pokerTable'),
  seatElement: index => $(`nameplate-${calculateVisualPosition(index + 1)}`),
  betElement: index => $(`bet-${calculateVisualPosition(index + 1)}`),
  cardElement: index => $(`playerCards-${calculateVisualPosition(index + 1)}`),
  cardHTML: renderCardHTML,
  chipHTML: amount => renderChipStack(amount, 24, 3),
});

function fmt(n) { return window.StacksAmounts.format(n); }
function fmtNumber(n) { return Number(n || 0).toLocaleString(); }

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

// Keep keyboard focus inside an open dialog and return it to its trigger.
const dialogTriggers = new WeakMap();
const boundDialogs = new WeakSet();
function focusDialog(overlay) {
  if (!overlay) return;
  if (!dialogTriggers.has(overlay)) dialogTriggers.set(overlay, document.activeElement);
  const focusable = () => [...overlay.querySelectorAll('button, input, textarea, select, summary, a[href], [tabindex="0"]')]
    .filter(el => !el.disabled && el.getClientRects().length && getComputedStyle(el).visibility !== 'hidden');
  if (!boundDialogs.has(overlay)) {
    overlay.addEventListener('keydown', event => {
      if (event.key === 'Escape') {
        const close = overlay.querySelector('[data-action="login-cancel"], [data-action="close-wallet"], [data-action="close-profile"], #buyinCancelBtn');
        if (close) { event.preventDefault(); close.click(); }
      }
      if (event.key !== 'Tab') return;
      const items = focusable(), first = items[0], last = items[items.length - 1];
      if (!first) { event.preventDefault(); return; }
      if (event.shiftKey && (document.activeElement === first || !overlay.contains(document.activeElement))) {
        event.preventDefault(); last.focus();
      } else if (!event.shiftKey && (document.activeElement === last || !overlay.contains(document.activeElement))) {
        event.preventDefault(); first.focus();
      }
    });
    boundDialogs.add(overlay);
  }
  focusable()[0]?.focus();
}
function restoreDialogFocus(overlay) {
  if (!overlay) return;
  const trigger = dialogTriggers.get(overlay);
  dialogTriggers.delete(overlay);
  if (trigger?.isConnected) trigger.focus();
}

function showLoginOverlay() {
  stopLoginAttempt();
  clearCreatedAccount();
  clearImportedKey();
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
  focusDialog(overlay);
}

function hideLoginOverlay() {
  clearCreatedAccount();
  clearImportedKey();
  const overlay = document.getElementById('loginOverlay');
  if (overlay) overlay.classList.add('hidden');
  restoreDialogFocus(overlay);
}

function setLoginStatus(msg, isError = true) {
  const el = document.getElementById('loginStatus');
  if (el) {
    el.textContent = msg;
    el.style.color = isError ? '#efb59b' : '#b5d4c4';
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

  const primary = isMobileDevice
    ? `<button class="login-method-btn primary" data-action="deep-link-login">${LOGIN_ICONS.extension} Open signer app</button>`
    : `<button class="login-method-btn primary" data-action="nip07-login">${LOGIN_ICONS.extension} Use browser signer</button>`;
  container.innerHTML = primary +
    `<button class="login-method-btn secondary" data-action="start-qr-login">${LOGIN_ICONS.qrcode} Connect with QR code</button>` +
    `<button class="login-method-btn secondary" data-action="show-private-key">${LOGIN_ICONS.keyring} Use private key</button>` +
    `<button class="login-text-btn" data-action="create-nostr-account">Create a new account</button>` +
    `<details class="login-more"><summary>More options</summary>` +
    (isMobileDevice ? `<button class="login-text-btn" data-action="nip07-login">Use browser signer</button>` : '') +
    `<button class="login-text-btn" data-action="show-bunker">Connect with bunker URL</button></details>`;
}

let createdAccount = null;
function clearCreatedAccount() {
  createdAccount?.destroy();
  createdAccount = null;
  if ($('loginNewNsec')) { $('loginNewNsec').value = ''; $('loginNewNsec').type = 'password'; }
  if ($('loginNewNpub')) $('loginNewNpub').value = '';
  if ($('loginKeySaved')) $('loginKeySaved').checked = false;
  if ($('loginCreateContinue')) $('loginCreateContinue').disabled = true;
  if ($('loginRevealNsec')) {
    $('loginRevealNsec').textContent = 'Show nsec';
    $('loginRevealNsec').setAttribute('aria-pressed', 'false');
  }
  $('loginCreateScreen')?.classList.add('hidden');
}
async function createNostrAccount() {
  const attempt = beginLoginAttempt();
  try {
    setLoginStatus('Creating your account securely…', false);
    await loginStep(attempt, () => nip46Ready, 15000);
    if (loginAttempt !== attempt || attempt.controller.signal.aborted) return;
    clearCreatedAccount();
    createdAccount = window.StacksLocalAccount.create(window.NostrNIP46, window);
    $('loginNewNpub').value = createdAccount.npub;
    $('loginNewNsec').value = createdAccount.nsec();
    $('loginMethods').classList.add('hidden');
    $('loginCreateScreen').classList.remove('hidden');
    stopLoginAttempt();
    document.querySelectorAll('.login-method-btn').forEach(b => b.disabled = false);
    $('loginCreateContinue').disabled = true;
    setLoginStatus('Your account is ready!', false);
    $('loginRevealNsec').focus();
  } catch (error) { loginFailed(attempt, error); }
}
async function copyCreatedNsec() {
  const account = createdAccount;
  if (!account) return;
  try {
    await navigator.clipboard.writeText(account.nsec());
    if (createdAccount === account) setLoginStatus('Nsec copied. Save it somewhere safe, then confirm below.', false);
  } catch (_) {
    if (createdAccount !== account) return;
    $('loginNewNsec').type = 'text';
    $('loginRevealNsec').textContent = 'Hide nsec';
    $('loginRevealNsec').setAttribute('aria-pressed', 'true');
    $('loginNewNsec').focus();
    $('loginNewNsec').select();
    setLoginStatus('Clipboard unavailable. Copy the selected nsec and save it somewhere safe.');
  }
}
async function finishCreatedAccount() {
  if (!createdAccount || !$('loginKeySaved').checked || loginAttempt) return;
  const attempt = beginLoginAttempt();
  try {
    setLoginStatus('Signing in with your new account…', false);
    await finishLogin(attempt, createdAccount, 'local');
  } catch (error) {
    loginFailed(attempt, error);
    $('loginCreateContinue').disabled = !$('loginKeySaved').checked;
  }
}
document.getElementById('loginKeySaved')?.addEventListener('change', () => {
  $('loginCreateContinue').disabled = !createdAccount || !$('loginKeySaved').checked || !!loginAttempt;
});

function clearImportedKey() {
  if ($('loginImportNsec')) { $('loginImportNsec').value = ''; $('loginImportNsec').readOnly = false; }
  $('loginKeyScreen')?.classList.add('hidden');
}
function showPrivateKeyScreen() {
  stopLoginAttempt();
  clearCreatedAccount();
  clearImportedKey();
  $('loginMethods').classList.add('hidden');
  $('loginKeyScreen').classList.remove('hidden');
  $('loginKeySubmit').disabled = false;
  setLoginStatus('', false);
  $('loginImportNsec').focus();
}
async function submitPrivateKey(event) {
  event.preventDefault();
  if (loginAttempt) return;
  const attempt = beginLoginAttempt();
  $('loginImportNsec').readOnly = true;
  let signer = null;
  try {
    setLoginStatus('Signing in…', false);
    await loginStep(attempt, () => nip46Ready, 15000);
    if (loginAttempt !== attempt || attempt.controller.signal.aborted) return;
    // Decode directly from the field; never put the nsec in storage or a request.
    signer = window.StacksLocalAccount.fromNsec(window.NostrNIP46, $('loginImportNsec').value, window);
    $('loginImportNsec').value = '';
    attempt.localSigner = signer;
    await finishLogin(attempt, signer, 'private-key');
  } catch (error) {
    if (loginAttempt === attempt) { $('loginImportNsec').value = ''; $('loginImportNsec').readOnly = false; }
    loginFailed(attempt, new Error('Could not sign in. Check your nsec and connection, then try again.'));
  } finally {
    if (signer && localProfileSigner !== signer) signer.destroy();
  }
}
$('loginKeyScreen')?.addEventListener('submit', submitPrivateKey);
window.addEventListener('pagehide', () => { stopLoginAttempt(); clearCreatedAccount(); clearImportedKey(); });

let localProfileSigner = null;
function clearLocalProfileSigner() {
  localProfileSigner?.destroy();
  localProfileSigner = null;
}
window.addEventListener('pagehide', clearLocalProfileSigner);
const profileEditor = window.StacksProfile.createEditor({
  session: () => ({token:mySessionToken,pubkey:myPubkeyHex}),
  getSigner: () => localProfileSigner || (localStorage.getItem('ss_authMethod') === 'nip07' ? window.nostr : nip46Signer),
  focus: focusDialog,
  restore: restoreDialogFocus,
  onFund: amount => showAccountDeposit(amount),
  onSave(profile, availableSats) {
    availableCashoutSats = Number(availableSats || 0);
    myNostrName = profile.display_name || profile.name || null;
    myUsername = myNostrName || myNpub.slice(0,12) + '...';
    myNostrPicture = profile.picture || null;
    if (myNostrName) localStorage.setItem('ss_nostrName',myNostrName); else localStorage.removeItem('ss_nostrName');
    if (myNostrPicture) localStorage.setItem('ss_nostrPicture',myNostrPicture); else localStorage.removeItem('ss_nostrPicture');
    updateWalletButtons();
    requestWalletState();
  }
});

// Shared session storage helper
function storeAuthSession(verifyData) {
  lightningWallet.disconnect();
  mySessionToken = verifyData.sessionToken;
  myPubkeyHex = verifyData.pubkeyHex;
  myNpub = verifyData.npub;
  availableCashoutSats = verifyData.profile.availableSats || 0;
  myNostrName = verifyData.profile.name;
  myNostrPicture = verifyData.profile.picture;
  myUserId = myPubkeyHex;
  myUsername = myNostrName || myNpub.slice(0, 12) + '...';

  localStorage.setItem('ss_sessionToken', mySessionToken);
  localStorage.setItem('ss_pubkeyHex', myPubkeyHex);
  localStorage.setItem('ss_npub', myNpub);
  localStorage.removeItem('ss_nostrName');
  localStorage.removeItem('ss_nostrPicture');
  localStorage.removeItem('ss_lud16');
  if (myNostrName) localStorage.setItem('ss_nostrName', myNostrName);
  if (myNostrPicture) localStorage.setItem('ss_nostrPicture', myNostrPicture);
  if (verifyData.profile.lud16) localStorage.setItem('ss_lud16', verifyData.profile.lud16);

  // NIP-51: Fetch follow/mute lists in background
  fetchFollowAndMuteLists(myPubkeyHex);

  // Show connected-wallet controls
  showWalletControls();
  requestWalletState();
}

// Challenge-response auth using a signer object (window.nostr or NIP-46 BunkerSigner)
async function performChallengeAuth(signer, signal) {
  setLoginStatus(signer === createdAccount || loginAttempt?.localSigner === signer ? 'Signing in…' : 'Approve in your signer…', false);
  return window.StacksProviders.authenticate(signer, {
    origin: window.location.origin,
    signal,
    async requestChallenge() {
      const response = await fetch('/api/auth/challenge', { method: 'POST', signal });
      const data = await response.json();
      if (!data.success) throw new Error(data.error || 'Could not request sign-in');
      return data;
    },
    async verify(body) {
      const response = await fetch('/api/auth/verify', { method: 'POST', signal, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
      const data = await response.json();
      if (!data.success) throw new Error(data.error || 'Sign-in verification failed');
      return data;
    },
  });
}

// Each attempt owns its cancellation, relay pool, and signer. Switching methods
// or closing the dialog prevents a delayed approval from signing the user in.
let loginAttempt = null;
let qrConnectionURI = null;
function stopLoginAttempt() {
  const attempt = loginAttempt;
  loginAttempt = null;
  $('loginSignerLink')?.remove();
  attempt?.controller.abort();
  document.querySelectorAll('.login-method-btn').forEach(b => b.disabled = false);
  if (attempt && !attempt.completed) {
    attempt.localSigner?.destroy();
    try { attempt.signer?.close(); } catch (_) { /* already closed */ }
    attempt.pool?.close(attempt.relays || NIP46_RELAYS);
  }
}
function beginLoginAttempt() {
  stopLoginAttempt();
  const attempt = { controller: new AbortController(), completed: false };
  loginAttempt = attempt;
  document.querySelectorAll('.login-method-btn').forEach(b => b.disabled = true);
  return attempt;
}
function loginStep(attempt, operation, timeoutMs = 120000) {
  return window.StacksProviders.withTimeout(operation, {
    signal: attempt.controller.signal, timeoutMs,
    message: 'The signer did not respond in time. Unlock it and try again, or choose another sign-in method.'
  });
}
function loginFailed(attempt, error) {
  if (loginAttempt !== attempt || attempt.controller.signal.aborted) return;
  const message = error.message || 'Sign-in failed. Please try again.';
  setLoginStatus(message);
  const hint = $('loginQrHint');
  if (hint) hint.textContent = 'Connection not completed. Go back to try again.';
  stopLoginAttempt();
  document.querySelectorAll('.login-method-btn').forEach(b => b.disabled = false);
}
async function finishLogin(attempt, signer, method) {
  const data = await performChallengeAuth(signer, attempt.controller.signal);
  if (loginAttempt !== attempt || attempt.controller.signal.aborted) return;
  attempt.completed = true;
  nip46Signer = method === 'nip46' ? signer : null;
  storeAuthSession(data);
  localStorage.setItem('ss_authMethod', method);
  $('loginBunkerInput').value = '';
  qrConnectionURI = null;
  // Keep the local signer in page memory for optional profile edits. Clear its export
  // fields now, and erase the key itself on logout or page exit.
  const setupSigner = method === 'local' ? createdAccount : method === 'private-key' ? signer : null;
  clearLocalProfileSigner();
  localProfileSigner = setupSigner;
  if (setupSigner) createdAccount = null;
  hideLoginOverlay();
  // Authenticate the observer socket immediately, including the real-money
  // buy-in path; it must not remain attached to an anonymous observer.
  if (socket?.connected) socket.emit('observer-authenticate', { sessionToken: mySessionToken });
  const continueLogin = () => {
    if (loginIntent === 'observe') loginIntent = 'sit';
    else showBuyinDialog();
  };
  continueLogin();
}
async function handleNIP07Login() {
  const attempt = beginLoginAttempt();
  try {
    setLoginStatus('Looking for your browser signer…', false);
    if (!await loginStep(attempt, detectNostr, 5000)) throw new Error('No signer found. Unlock your extension, connect with QR code, or use your private key.');
    await finishLogin(attempt, window.nostr, 'nip07');
  } catch (error) { loginFailed(attempt, error); }
}
window.handleNIP07Login = handleNIP07Login;

async function startRemoteLogin(openApp = false) {
  const attempt = beginLoginAttempt();
  try {
    setLoginStatus('Loading phone sign-in…', false);
    await loginStep(attempt, nip46Ready, 15000);
    const { generateSecretKey, getPublicKey, BunkerSigner, createNostrConnectURI, SimplePool } = window.NostrNIP46;
    const key = generateSecretKey();
    const secret = Array.from(crypto.getRandomValues(new Uint8Array(16)), b => b.toString(16).padStart(2, '0')).join('');
    qrConnectionURI = createNostrConnectURI({ clientPubkey: getPublicKey(key), relays: NIP46_RELAYS,
      secret, name: 'Satoshi Stacks', url: window.location.origin });
    attempt.pool = new SimplePool();
    nip46AbortController = attempt.controller;
    $('loginMethods').classList.add('hidden');
    $('loginBunkerScreen').classList.add('hidden');
    $('loginQrScreen').classList.remove('hidden');
    const qr = $('loginQrContainer');
    qr.innerHTML = '';
    if (typeof QRCode !== 'undefined') new QRCode(qr, { text: qrConnectionURI, width: 200, height: 200,
      colorDark: '#182b3d', colorLight: '#ffffff', correctLevel: QRCode.CorrectLevel.M });
    else qr.textContent = 'QR code unavailable. Use Copy connection link or paste a bunker URL.';
    $('loginQrHint').textContent = 'Approve the connection, then the sign-in request in your signer.';
    setLoginStatus('Waiting for your phone signer…', false);
    const connected = BunkerSigner.fromURI(key, qrConnectionURI, { pool: attempt.pool }, attempt.controller.signal);
    $('loginSignerLink')?.remove();
    if (openApp) {
      // Keep a real user-activated link: an async library load may exhaust the
      // browser's popup activation before the connection URI is ready.
      const link=document.createElement('a');
      link.id='loginSignerLink'; link.className='login-method-btn primary';
      link.href=qrConnectionURI; link.target='_blank'; link.rel='noopener';
      link.textContent='Open signer app';
      qr.insertAdjacentElement('afterend',link);
      setLoginStatus('Open your signer app using the button below, then approve the connection.',false);
    }
    attempt.signer = await loginStep(attempt, connected);
    await finishLogin(attempt, attempt.signer, 'nip46');
  } catch (error) { loginFailed(attempt, error); }
}
function startQRCodeLogin() { return startRemoteLogin(false); }
window.startQRCodeLogin = startQRCodeLogin;
function startDeepLinkLogin() { return startRemoteLogin(true); }
window.startDeepLinkLogin = startDeepLinkLogin;

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
  stopLoginAttempt();
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
  stopLoginAttempt();
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
  const uri = $('loginBunkerInput').value.trim();
  if (!uri.startsWith('bunker://')) { setLoginStatus('Paste the bunker:// connection URL from your signer.'); return; }
  const attempt = beginLoginAttempt();
  try {
    setLoginStatus('Connecting to your signer…', false);
    await loginStep(attempt, nip46Ready, 15000);
    const { generateSecretKey, BunkerSigner, parseBunkerInput, SimplePool } = window.NostrNIP46;
    const profile = await loginStep(attempt, () => parseBunkerInput(uri), 15000);
    if (!profile?.pubkey || !profile.relays?.length) throw new Error('This bunker URL is missing its public key or relay.');
    attempt.pool = new SimplePool();
    attempt.relays = profile.relays;
    attempt.signer = BunkerSigner.fromBunker(generateSecretKey(), profile, { pool: attempt.pool });
    await loginStep(attempt, () => attempt.signer.connect());
    await finishLogin(attempt, attempt.signer, 'nip46');
  } catch (error) { loginFailed(attempt, error); }
}
window.submitBunkerLogin = submitBunkerLogin;

// Back button from bunker screen
function loginGoBack() {
  stopLoginAttempt();
  clearCreatedAccount();
  clearImportedKey();
  document.querySelectorAll('.login-method-btn').forEach(b => b.disabled = false);
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
  $('loginMethods').querySelector('button')?.focus();
}
window.loginGoBack = loginGoBack;

// Cancel login entirely — dismiss overlay, clear pending seat, stay as observer
function cancelLogin() {
  stopLoginAttempt();
  if (nip46AbortController) {
    nip46AbortController.abort();
    nip46AbortController = null;
  }
  nip46Signer = null;
  pendingSeat = null;
  pendingBuyIn = null;
  loginIntent = 'sit';
  hideLoginOverlay();
  loginGoBack();
}

function nostrLogout() {
  profileEditor.close({resume:false});
  clearLocalProfileSigner();
  handHistories.length = 0;
  historyOwner = null;
  histViewIdx = -1;
  renderHistoryView();
  stopLoginAttempt();
  if (mySessionToken) fetch('/api/auth/logout', { method: 'POST', headers: { 'x-session-token': mySessionToken }, keepalive: true }).catch(() => {});
  localStorage.removeItem('ss_sessionToken');
  localStorage.removeItem('ss_pubkeyHex');
  localStorage.removeItem('ss_npub');
  localStorage.removeItem('ss_nostrName');
  localStorage.removeItem('ss_nostrPicture');
  localStorage.removeItem('ss_lud16');
  localStorage.removeItem('ss_authMethod');
  localStorage.removeItem('ss_nwcUri');
  lightningWallet.disconnect();
  availableCashoutSats = 0;
  activeBuyinInvoice = null;
  activeBuyinDetails = null;
  walletView = null;
  walletRequestPending = false;
  closeWalletModal();
  mySessionToken = null;
  myPubkeyHex = null;
  myNpub = null;
  myNostrName = null;
  myNostrPicture = null;
  myUserId = null;
  myUsername = 'Anon';
  mySeat = null;
  gameState = null;
  cachedHoleCards = null;
  // Clear NIP-51 follow/mute state
  myFollowSet = new Set();
  myMuteSet = new Set();
  // Update wallet controls
  showWalletControls();
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
    socket.emit('leave-table', { tableId: myTableId });
    socket.disconnect();
    socket = null;
  }
  // Reconnect as observer so they still see the table
  connectAsObserver();
}
window.nostrLogout = nostrLogout;

// ============================================================
//  Connected Lightning wallet and account balance
// ============================================================
const lightningWallet = window.StacksProviders.createWallet(() => window.webln);
let walletBusy = false;
let availableCashoutSats = 0;
let activeBuyinInvoice = null;
let activeBuyinDetails = null;
let walletView = null;
let lastCashoutView = '';
let walletStateRequestedAt = 0;
let walletRequestPending = false;
// Remove obsolete placeholder credentials; the application no longer stores NWC secrets.
localStorage.removeItem('ss_nwcUri');

async function connectWallet() {
  if (walletBusy) return;
  if (lightningWallet.isConnected()) {
    lightningWallet.disconnect();
    updateWalletButtons();
    showToast('Wallet disconnected from this page. You can revoke site permissions in your extension.', 'info');
    return;
  }
  walletBusy = true;
  updateWalletButtons();
  try {
    const wallet = await lightningWallet.connect();
    showToast(`${wallet.name} connected. Each payment starts when you choose Pay.`, 'info');
  } catch (error) { showToast(error.message || 'Wallet connection declined'); }
  finally { walletBusy = false; updateWalletButtons(); }
}
window.connectWallet = connectWallet;

function updateWalletButtons() {
  const connected = lightningWallet.isConnected();
  for (const id of ['walletSettingsBtn', 'walletConnectBtn']) {
    const button = $(id);
    if (!button) continue;
    button.textContent = walletBusy ? 'Connecting…' : connected ? `${lightningWallet.name()} connected · Disconnect` : 'Connect Lightning wallet';
    button.disabled = walletBusy;
    button.classList.toggle('connected', connected);
  }
  const account = $('accountSignIn');
  if (account) { account.textContent = myUserId ? myUsername : 'Sign in with Nostr'; account.disabled = !!myUserId; }
  const cashout = $('recoverFundsBtn');
  if (cashout) { cashout.hidden = !myUserId || !isRealMoneyTable(); cashout.textContent = `Account · ${fmt(availableCashoutSats || 0)} sats`; }
  const signOut = $('accountSignOut');
  if (signOut) signOut.hidden = !myUserId;
  if ($('editProfileBtn')) $('editProfileBtn').hidden = !myUserId;
}
function showWalletControls() {
  const row = $('walletSettingRow');
  if (row) row.style.display = myUserId ? '' : 'none';
  updateWalletButtons();
}
function requestWalletState() {
  if (!socket?.connected || !mySessionToken || Date.now() - walletStateRequestedAt < 1000) return;
  walletStateRequestedAt = Date.now();
  socket.emit('wallet-state-request', { tableId: myTableId, sessionToken: mySessionToken });
}
// Reconciliation can finish without a new hand or socket event. Poll while the
// player is looking at their wallet; never dispatch money from this timer.
setInterval(() => {
  if (!document.hidden && mySessionToken && (walletView || activeBuyinInvoice)) requestWalletState();
}, 5000);

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
      if (res.status !== 401 && !data.success) throw new Error(data.error || 'Sign-in service temporarily unavailable');
      if (!data.success) {
        // Session expired — clear and show login
        nostrLogout();
        return false;
      }
      // Restore state from server
      myPubkeyHex = data.pubkeyHex;
      myNpub = data.npub;
      availableCashoutSats = data.profile.availableSats || 0;
      myNostrName = data.profile.name;
      myNostrPicture = data.profile.picture;
      myUserId = myPubkeyHex;
      myUsername = myNostrName || myNpub.slice(0, 12) + '...';
      // NIP-51: Fetch follow/mute lists in background
      fetchFollowAndMuteLists(myPubkeyHex);
      // Show connected-wallet controls
      showWalletControls();
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
      socket.emit('observe-table', { tableId: myTableId, sessionToken: mySessionToken || undefined, resumeSeat: !localStorage.getItem('ss_stoodUp') });
      requestWalletState();
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
    tableMotion.cancel();
    mySeat = newSeat;
    localStorage.removeItem('ss_stoodUp');
    isObserver = false;
    if (displayName) myUsername = displayName;
    // Close buy-in dialog / wallet modal if open
    hideBuyinDialog();
    closeWalletModal();
    showToast(`Playing as ${myUsername}`, 'info');
    updateWalletButtons();
    requestWalletState();
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
    myNostrPicture = picture || null;
    if (picture) localStorage.setItem('ss_nostrPicture', picture); else localStorage.removeItem('ss_nostrPicture');
    if (lud16) localStorage.setItem('ss_lud16', lud16); else localStorage.removeItem('ss_lud16');
    updateWalletButtons();
  });

  socket.on('game-state', (state) => {
    const motionBefore = tableMotion.capture();
    prevGameState = gameState;
    gameState = state;

    if (myUserId && historyOwner !== myUserId) loadHandHistories();

    if (state.handId && state.currentHandHistory) {
      const followLatest = histViewIdx === handHistories.length - 1;
      mergeHandHistories([{handId:state.handId, history:state.currentHandHistory, startedAt:state.handStartedAt, inProgress:state.handInProgress,personal:state.currentHandHistoryPersonal}]);
      if (followLatest) histViewIdx = handHistories.length - 1;
      renderHistoryView();
    }

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

    render();
    tableMotion.play(prevGameState, gameState, motionBefore);
    updateWalletButtons();
    const mode = $('tableModeLabel');
    if (mode) mode.textContent = `${state.realMoney ? 'Real sats' : 'Demo chips'} · ${fmt(state.smallBlind)} / ${fmt(state.bigBlind)} · Buy-in ${fmt(state.minBuyin)}–${fmt(state.maxBuyin)}`;
    requestWalletState();
  });

  socket.on('error', (error) => {
    walletRequestPending = false;
    if ($('walletModal') && !$('walletModal').classList.contains('hidden')) { walletView = 'error'; showWalletModal('Could not complete request', `<p role="alert">${esc(error.message)}</p><button class="wallet-btn" data-action="close-wallet">Close and try again</button>`); }
    showToast(error.message);
    requestWalletState();
  });
  socket.on('wallet-state', state => {
    if (state.tableId !== myTableId || state.userId !== myPubkeyHex) return;
    availableCashoutSats = state.availableSats || 0;
    if (['cashout','cashout-pending'].includes(walletView)) renderCashoutState(state);
    if (walletView === 'buyin-invoice' && activeBuyinDetails) {
      const deposit = (state.deposits || []).find(row => row.payment_hash === activeBuyinDetails.paymentHash);
      if (!deposit || deposit.status !== 'pending') {
        activeBuyinInvoice = null;
        activeBuyinDetails = null;
        if (mySeat) closeWalletModal();
        else { walletView = 'cashout'; renderCashoutState(state); }
      }
    }
    updateWalletButtons();
  });

  // ---- real-money wallet events ----
  socket.on('buyin-invoice', invoice => {
    if (invoice.userId && (invoice.userId !== myPubkeyHex || invoice.tableId !== myTableId)) return;
    walletRequestPending = false;
    showBuyinInvoice(invoice);
  });
  socket.on('account-buyin-confirmed', () => {
    closeWalletModal();
    requestWalletState();
    showToast('Buy-in transferred from your account.', 'info');
  });
  socket.on('account-table-cashout', ({ tableId, amountSats }) => {
    if (tableId !== myTableId) return;
    mySeat = null;
    localStorage.setItem('ss_stoodUp', '1');
    walletView = 'cashout';
    lastCashoutView = '';
    walletStateRequestedAt = 0;
    showWalletModal('Your SatoshiStacks account', '<p role="status">Checking your balance…</p>');
    connectAsObserver();
    showToast(`${fmt(amountSats)} sats returned to your account.`, 'info');
  });
  socket.on('account-deposit-confirmed', () => requestWalletState());
  socket.on('cashout-pending', () => {
    walletView = 'cashout-pending';
    showWalletModal('Withdrawal pending', '<p class="wallet-status" role="status">The withdrawal amount is reserved in your account. Waiting for the Lightning payment result…</p>');
    requestWalletState();
  });
  socket.on('cashout-result', (res) => {
    if (!res) return;
    availableCashoutSats = 0;
    requestWalletState();
    if (res.status === 'succeeded') { closeWalletModal(); showToast('Withdrawal confirmed — sent to your receiving wallet!', 'info'); }
    else if (res.status === 'in_flight') { walletView = 'cashout'; lastCashoutView = ''; fetchWalletState().then(renderCashoutState).catch(error => showToast(error.message)); }

  });
  socket.on('cashout-failed', ({ message }) => {
    closeWalletModal();
    requestWalletState();
    showToast(message || 'Payment failed — the amount was returned to your account.');
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

  // NIP-58: Badge awarded notification
  socket.on('badge-awarded', ({ badgeId, badgeName, badgeIcon }) => {
    showBadgeToast(badgeName, badgeIcon);
    addChatMessage('System', `🏆 You earned the ${badgeIcon} ${badgeName} badge!`, true);
  });

  // Real-time hand log
  socket.on('hand-log', ({ line, type }) => {
    if (!line || !line.trim()) return;
    addPlayByPlay(line);
    if (type === 'summary') {
      const result = summarizeHandResult(line);
      if (result) addChatMessage('Hand summary', result, true);
    }
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

  });

  socket.on('hand-complete', ({ history, handId }) => {
    if (history) {
      mergeHandHistories([{handId, history, startedAt:Date.now(),personal:true}]);
      histViewIdx = handHistories.length - 1;
      currentHandLog = [];
      renderHistoryView();
    }
  });

  socket.on('disconnect', () => {
    tableMotion.cancel();
    gameState = null;
    prevGameState = null;
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

// A waiting table should communicate its state without covering a live board.
function updateWaitingState() {
  const waiting = $('tableWaiting');
  if (!waiting || !gameState) return;
  const players = (gameState.players || []).filter(Boolean);
  const ready = players.filter(player => player.stack > 0 && !player.sittingOut && !player.busted);
  const show = !gameState.handInProgress && !(gameState.communityCards || []).length;
  waiting.hidden = !show;
  $('pokerTable')?.classList.toggle('is-waiting', show);
  const count = $('seatCount');
  if (count) count.textContent = `${players.length} / ${NUM_SEATS} seated`;
  if (!show) return;
  const me = players.find(player => player.userId === myUserId);
  let title = 'Waiting for players';
  let detail = 'Choose an open seat. Play starts with two players.';
  if (ready.length >= 2) {
    title = 'The next hand starts shortly';
    detail = 'Settle in. Your cards are on the way.';
  } else if (me && (me.sittingOut || me.busted)) {
    title = 'Ready when you are';
    detail = me.busted ? 'Choose your nameplate to buy back in.' : 'Choose Sit Back In when you’re ready to play.';
  } else if (me) {
    title = 'One more player to begin';
    detail = 'You’re seated. Play starts when another player joins.';
  } else if (players.length === NUM_SEATS) {
    title = 'Waiting for players to return';
    detail = 'The table is full. Play resumes when two players are ready.';
  } else if (ready.length === 1) {
    title = 'A seat is waiting for you';
    detail = 'One player is ready. Choose an open seat to join them.';
  }
  // Avoid repeat live-region announcements for unchanged server updates.
  if ($('waitingTitle').textContent !== title) $('waitingTitle').textContent = title;
  if ($('waitingDetail').textContent !== detail) $('waitingDetail').textContent = detail;
}

// ============================================================
//  MAIN RENDER — called on every game-state update
// ============================================================
function render() {
  if (!gameState) return; // Wait for game state

  // Reconcile local seated-state with the authoritative game-state. If the server
  // no longer has me in a seat (after cash-out, stand-up, logout, kick, or a Nostr
  // account switch), clear mySeat — otherwise the empty seats stay hidden and you
  // can't take/buy a seat again.
  if (mySeat && !(myUserId && gameState.players.some(p => p && p.userId === myUserId))) {
    mySeat = null;
  }

  updateWaitingState();

  // In observer mode (no seat), render table but skip player controls
  if (!mySeat) {
    renderSeats();
    updateNameplates();
    renderTableMarkers();
    renderCommunityCards();
    highlightWinningCards();
    updateBets();
    updatePot();
    const status = $('mobileTurnStatus');
    if (status) {
      status.textContent = gameState.players.every(Boolean) ? 'Table full · join the waitlist' : 'Choose an open seat to play';
      status.classList.remove('your-turn');
    }
    updateTableActions();
    // Hide player controls for observers
    const ca = document.querySelector('.controls-area');
    if (ca) ca.classList.remove('visible');
    const preBar = document.querySelector('.pre-action-bar');
    if (preBar) preBar.classList.remove('visible');
    updateSpectatorBadge();
    updateWaitlistUI();
    updateObserverAuthUI();
    return;
  }

  // Execute pre-action BEFORE rendering clears it
  if (gameState.yourTurn && preAction) {
    if (executePreAction()) return; // action sent, wait for next state
  }

  renderSeats();
  updateNameplates();
  renderTableMarkers();
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
    const signInLink = document.createElement('button');
    signInLink.type = 'button';
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
    document.getElementById('dealerStation').prepend(container);
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
        // Seated players cannot switch seats mid-game.
        seatEl.innerHTML = '';
      } else {
        // Render clickable empty seat avatar with "EMPTY SEAT" text
        seatEl.innerHTML = `
          <button type="button" class="empty-avatar" data-empty-seat="${idx}" aria-label="Take seat ${actualSeat}">
            <span class="empty-label">Take seat</span>
          </button>
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
    const cardsEl = $(`playerCards-${visualPos}`);
    if (!el || !cardsEl) continue;

    if (!player) {
      // No nameplate for empty seats — the avatar circle shows "EMPTY SEAT"
      el.className = `player-nameplate np-pos-${visualPos} empty-np`;
      el.removeAttribute('data-userid');
      el.removeAttribute('data-is-me');
      el.style.cursor = '';
      el.innerHTML = '';
      cardsEl.replaceChildren();
      delete cardsEl.dataset.cardKey;
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
    }

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
    const samePlayer = el.dataset.renderedUser === player.userId;
    const cardKey = JSON.stringify([gameState.handId || gameState.handCount, player.userId, cardsHTML]);
    cardsEl.className = `player-cards cards-pos-${visualPos}${isMe ? ' hero' : ''}`;
    if (cardsEl.dataset.cardKey !== cardKey) {
      cardsEl.innerHTML = cardsHTML;
      cardsEl.dataset.cardKey = cardKey;
    }
    const savedLifeBar = samePlayer ? el.querySelector('.np-life-bar') : null;
    el.dataset.renderedUser = player.userId;
    el.innerHTML = `
      ${sitOutBadge}
      <div class="np-life-bar" id="lifeBar-${visualPos}"></div>
      <div class="np-action" id="npAction-${visualPos}"></div>
      <div class="np-content">
        <span class="np-identity"><span class="np-name">${esc(truncName(player.nostrName || player.username))}</span>${myFollowSet.has(player.userId) && !isMe ? '<span class="np-friend" title="You follow this player">⭐</span>' : ''}${player.badges?.length ? `<span class="np-badges">${player.badges.map(b => BADGE_ICONS[b] || '').join('')}</span>` : ''}</span>
        <span class="np-amount">${fmt(player.stack)}</span>
      </div>
    `;
    if (savedLifeBar) el.querySelector('.np-life-bar')?.replaceWith(savedLifeBar);

    // Re-apply active badge after re-render (badges are stored in activeBadges{})
    applyBadge(visualPos);
  }
}

// Dealer button follows the dealer's visual seat, including after they fold.
function renderTableMarkers() {
  const container = $('tableMarkers');
  if (!container) return;
  const seat = gameState.dealerSeat;
  let html = '';
  if (gameState.handId && Number.isInteger(seat) && gameState.players[seat]) {
    const position = calculateVisualPosition(seat + 1);
    html = `<div class="marker-group marker-pos-${position}"><span class="table-marker dealer" role="img" aria-label="Dealer" title="Dealer">D</span></div>`;
  }
  if (container.innerHTML !== html) container.innerHTML = html;
}

// ============================================================
//  RENDER COMMUNITY CARDS — preserve cards across repeated server updates
// ============================================================
function renderCommunityCards() {
  const el = $('communityCards');
  if (!el) return;
  const cards = gameState.communityCards || [];
  const key = gameState.handId || String(gameState.handCount);
  if (el.dataset.hand !== key || [...el.children].some((child,i) => child.dataset.card !== cards[i])) {
    el.replaceChildren();
    el.dataset.hand = key;
  }
  for (let i=el.children.length;i<cards.length;i++) {
    const div = document.createElement('div');
    div.className = 'community-card';
    div.dataset.card = cards[i];
    div.innerHTML = renderCardHTML(cards[i]);
    el.appendChild(div);
  }
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
    const amount = $(`betAmount-${visualPos}`);
    if (!be) continue;

    if (!player || !player.currentBet || player.currentBet <= 0) {
      be.classList.remove('visible');
      if (amount) amount.textContent = '';
      if (bc) { bc.replaceChildren(); delete bc.dataset.amount; }
      continue;
    }

    be.classList.add('visible');
    be.setAttribute('aria-label', `${player.nostrName || player.username} bet ${fmt(player.currentBet)}`);
    if (amount) amount.textContent = fmt(player.currentBet);
    if (bc && bc.dataset.amount !== String(player.currentBet)) {
      bc.innerHTML = renderChipStack(player.currentBet, 22, 3);
      bc.dataset.amount = player.currentBet;
    }
  }
}

// ============================================================
//  RENDER POT (chip pile + label)
//  The server provides the exact amount and chip denominations.
//  The visual pile samples those chips into a bounded area above the board.
// ============================================================
function updatePot() {
  if (!gameState) return;
  const pot = gameState.pot || 0;
  const potChips = gameState.potChips || [];
  const totalWithBets = pot + (gameState.players || []).reduce((s, p) => s + (p ? p.currentBet || 0 : 0), 0);

  $('tablePotAmount').textContent = fmt(totalWithBets);
  const hasValue = totalWithBets > 0;
  $('tablePotLabel').classList.toggle('visible', hasValue);

  const chipsEl = $('tablePotChips');
  if (!chipsEl) return;
  const handKey = gameState.handId || `${gameState.tableId}:${gameState.handCount}`;
  const positions = potPile.update(potChips, handKey);
  chipsEl.classList.toggle('visible', positions.length > 0);
  window.StacksPotPile.updateElement(chipsEl, positions, renderChipSVG, handKey);
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
//  RENDER CONTROLS (non-linear slider, presets, action buttons)
// ============================================================
function renderControls() {
  const bc = $('betControls');
  const ca = document.querySelector('.controls-area');
  if (!bc || !ca) return;

  const myPlayer = gameState.players.find(p => p && p.userId === myUserId);
  const status = $('mobileTurnStatus');
  if (status) {
    const active = gameState.players[gameState.currentPlayerIndex];
    status.textContent = !myPlayer ? 'Choose an open seat to play' :
      myPlayer.busted ? 'Stack empty · add chips from your seat' :
      myPlayer.sittingOut ? 'Sitting out · return from Table options' :
      !gameState.handInProgress ? 'Waiting for the next hand' :
      myPlayer.folded ? 'You folded · next hand coming up' :
      myPlayer.allIn ? 'You’re all in' : gameState.yourTurn ? 'Your turn' :
      active ? `${truncName(active.nostrName || active.username || 'Player', 16)} is thinking…` : 'Hand in progress';
    status.classList.toggle('your-turn', !!gameState.yourTurn);
  }
  if (!myPlayer || !gameState.yourTurn || !gameState.handInProgress) {
    ca.classList.remove('visible');
    bc.innerHTML = '';
    return;
  }

  // The desktop fitter reserves space for the complete action panel. A height
  // limit derived from the previous table size can clip buttons before it fits.
  ca.style.maxHeight = '';
  ca.classList.add('visible');

  const maxBet = gameState.currentBetToCall ?? Math.max(0, ...gameState.players.filter(p => p).map(p => p.currentBet || 0));
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
  const canRaise = myPlayer.canRaise !== false && !allOpponentsAllIn && myPlayer.stack > toCall;

  const callText = canCheck ? 'Check' : (toCall >= myPlayer.stack ? 'All In' : `Call ${fmtNumber(toCall)}`);
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
      <input type="range" class="bet-slider" id="betSlider" aria-label="Raise amount" aria-valuetext="${fmtNumber(minR)}" min="0" max="${SLIDER_STEPS}" value="0" step="1">
      <input type="number" inputmode="numeric" class="bet-amount-input" id="betInput" aria-label="Bet or raise total" min="${minR}" max="${maxR}" value="${minR}">
    </div>` : ''}
    <div class="action-buttons">
      <button class="action-btn btn-fold" id="foldBtn">Fold</button>
      <button class="action-btn btn-check-call" id="ccBtn">${callText}</button>
      ${canRaise && maxR > minR ? `<button class="action-btn btn-raise" id="raiseBtn">${rLabel} ${fmtNumber(minR)}</button>` :
       (canRaise && toCall < myPlayer.stack && maxR > maxBet ? `<button class="action-btn btn-raise" id="raiseBtn">All In ${fmtNumber(myPlayer.stack)}</button>` : '')}
    </div>
  `;

  // Wire up action buttons
  $('foldBtn')?.addEventListener('click', () => sendAction('fold'));
  $('ccBtn')?.addEventListener('click', () => sendAction(canCheck ? 'check' : 'call'));

  const rb = $('raiseBtn'), sl = $('betSlider'), bi = $('betInput');
  function updateBetUI(v) {
    v = Math.max(minR, Math.min(maxR, Math.round(v)));
    if (sl) { sl.value = betToSlider(v); sl.setAttribute('aria-valuetext', fmtNumber(v)); }
    if (bi) bi.value = v;
    if (rb) rb.textContent = `${v >= maxR ? 'All In' : rLabel} ${fmtNumber(v)}`;
  }
  rb?.addEventListener('click', () => {
    // The numeric input is exact; mapping back from a curved slider can
    // round a preset down by several chips after the label shows its total.
    const bet = bi ? Math.max(minR, Math.min(maxR, Math.round(Number(bi.value) || minR))) : minR;
    sendAction('raise', bet);
  });
  sl?.addEventListener('input', () => updateBetUI(sliderToBet(parseInt(sl.value))));
  bi?.addEventListener('focus', () => bi.select());
  bi?.addEventListener('input', () => {
    const v = parseInt(bi.value);
    if (!isNaN(v)) {
      const clamped = Math.max(minR, Math.min(maxR, Math.round(v)));
      if (sl) { sl.value = betToSlider(clamped); sl.setAttribute('aria-valuetext', fmtNumber(clamped)); }
      if (rb) rb.textContent = `${clamped >= maxR ? 'All In' : rLabel} ${fmtNumber(clamped)}`;
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
  const maxBet = gameState.currentBetToCall ?? Math.max(0, ...gameState.players.filter(p => p).map(p => p.currentBet || 0));
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
    const callLabel = callAmt >= myPlayer.stack ? 'Call All-In' : `Call ${fmtNumber(callAmt)}`;
    let buttonsHTML = '';
    buttonsHTML += `<button class="pre-action-btn" data-pa="call">${callLabel}</button>`;
    buttonsHTML += '<button class="pre-action-btn" data-pa="fold">Fold</button>';
    bar.innerHTML = buttonsHTML;
    bar.querySelectorAll('.pre-action-btn').forEach(btn => {
      btn.addEventListener('click', () => {
        const pa = btn.dataset.pa;
        preAction = (preAction === pa) ? null : pa;
        preActionToCall = preAction === 'call' ? toCall : null;
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

  const maxBet = gameState.currentBetToCall ?? Math.max(0, ...gameState.players.filter(p => p).map(p => p.currentBet || 0));
  const toCall = maxBet - (myPlayer.currentBet || 0);
  const canCheck = toCall === 0;

  const pa = preAction;
  preAction = null;

  if (pa === 'call' && toCall > 0 && toCall === preActionToCall) { sendAction('call'); return true; }
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
    actionId: actionId,
    handCount: gameState?.handCount
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

function handleTimerStart(playerIndex, baseMs, timeBankMs, isPreflop) {
  clearTimer();
  timeRemaining = baseMs;
  currentTurnTime = baseMs;
  const visualPos = getVisualPosition(playerIndex);
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
  timeRemaining = timeBankMs;
  currentTurnTime = timeBankMs;
  const visualPos = getVisualPosition(playerIndex);
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
  for (let i = 1; i <= 6; i++) {
    const bar = $(`lifeBar-${i}`);
    if (bar) {
      bar.classList.remove('active');
      bar.style.width = '0%';
    }
  }
}

// ============================================================
//  CHAT SYSTEM
// ============================================================
const chatSettings = { sound: 'all', playerChat: true, playByPlay: false, autoMuck: true };

function summarizeHandResult(line) {
  // The server's final seat summaries already aggregate split and side-pot
  // payouts. Only summarize winners; never expose cards from a folded hand.
  const shown = /^Seat [1-6]: (.+) showed \[[^\]]+\] and won \((\d+)\) with (.+)$/.exec(line);
  const folded = /^Seat [1-6]: (.+) collected \((\d+)\)$/.exec(line);
  const match = shown || folded;
  if (!match) return null;
  const name = match[1].replace(/(?: \((?:button|small blind|big blind)\))+$/, '');
  const amount = '₿\u00a0' + Number(match[2]).toLocaleString('en-US');
  return shown ? `${name} won ${amount} chips with ${match[3]}.` :
    `${name} won ${amount} chips — everyone else folded.`;
}

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
let historyOwner = null;
let historyLoading = false;
let historyLastAttempt = 0;

function mergeHandHistories(records) {
  const selected = handHistories[histViewIdx]?.handId;
  const merged = new Map(handHistories.map(hand => [hand.handId, hand]));
  for (const hand of records) {
    if (merged.get(hand.handId)?.personal && !hand.personal) continue;
    merged.set(hand.handId, hand);
  }
  handHistories.splice(0, handHistories.length, ...[...merged.values()].sort((a,b)=>a.startedAt-b.startedAt));
  histViewIdx = selected ? handHistories.findIndex(hand=>hand.handId===selected) : handHistories.length-1;
}

async function loadHandHistories() {
  if (!mySessionToken || !myUserId || historyLoading || Date.now()-historyLastAttempt < 3000) return;
  const token = mySessionToken, owner = myUserId;
  historyLastAttempt = Date.now();
  historyLoading = true;
  try {
    const response = await fetch('/api/my/hands', {headers:{'x-session-token':token},cache:'no-store'});
    if (!response.ok) throw new Error('Could not load saved histories');
    const data = await response.json();
    if (mySessionToken !== token || myUserId !== owner) return;
    if (historyOwner && historyOwner !== owner) handHistories.length = 0;
    mergeHandHistories(data.hands);
    historyOwner = owner;
    renderHistoryView();
  } catch (error) {
    const label = $('histLabel');
    if (label && !handHistories.length) label.textContent = 'Saved histories unavailable — reopen to retry';
  } finally { historyLoading = false; }
}

function renderHistoryView() {
  const label = $('histLabel');
  const text = $('histText');
  const prev = $('histPrev');
  const next = $('histNext');
  if (!label || !text) return;

  if (handHistories.length === 0) {
    label.textContent = 'No hands yet';
    if ($('historyHandId')) $('historyHandId').textContent = '';
    text.textContent = '';
    if (prev) prev.disabled = true;
    if (next) next.disabled = true;
    return;
  }

  const idx = Math.max(0, Math.min(histViewIdx, handHistories.length - 1));
  histViewIdx = idx;
  label.textContent = `${idx + 1} / ${handHistories.length}${handHistories[idx].inProgress ? ' · In progress' : ''}`;
  const idLabel = $('historyHandId');
  if (idLabel) idLabel.textContent = handHistories[idx].handId || '';
  text.textContent = handHistories[idx].history;
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
      tabs.forEach(tt => {
        tt.classList.toggle('active', tt === tab);
        tt.setAttribute('aria-pressed', String(tt === tab));
      });
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
      if (t === 'history') { renderHistoryView(); loadHandHistories(); }
    });
  });

  // History navigation
  $('histPrev')?.addEventListener('click', () => {
    if (histViewIdx > 0) { histViewIdx--; renderHistoryView(); }
  });
  $('histNext')?.addEventListener('click', () => {
    if (histViewIdx < handHistories.length - 1) { histViewIdx++; renderHistoryView(); }
  });
  async function copyHistory(idOnly) {
    const hand = handHistories[histViewIdx];
    if (!hand) return;
    try {
      await navigator.clipboard.writeText(idOnly ? hand.handId : hand.history);
      showToast(idOnly ? 'Hand ID copied' : 'Hand history copied — ready to share', 'info');
    } catch (error) { showToast('Could not copy. Select the history text and copy it manually.'); }
  }
  $('histCopy')?.addEventListener('click', () => copyHistory(false));
  $('histCopyId')?.addEventListener('click', () => copyHistory(true));
  $('histLive')?.addEventListener('click', () => { histViewIdx = handHistories.length - 1; renderHistoryView(); });

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
    const collapsed = $('chatBox')?.classList.toggle('collapsed');
    const button = $('chatCollapseBtn');
    button?.setAttribute('aria-expanded', String(!collapsed));
    button?.setAttribute('aria-label', collapsed ? 'Expand chat panel' : 'Collapse chat panel');
  });

  // Settings toggles
  document.querySelectorAll('.setting-toggle').forEach(tog => {
    tog.addEventListener('click', () => {
      const key = tog.dataset.setting;
      if (!key) return;
      chatSettings[key] = !chatSettings[key];
      document.querySelectorAll(`.setting-toggle[data-setting="${key}"]`).forEach(button => {
        button.classList.toggle('on', chatSettings[key]);
        button.setAttribute('aria-checked', String(chatSettings[key]));
      });
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
      chatSettings.sound = next;
      document.querySelectorAll('.setting-cycle[data-setting="sound"]').forEach(button => {
        button.dataset.value = next;
        button.textContent = labels[next];
        button.setAttribute('aria-label', `Sounds: ${labels[next]}`);
      });
    });
  });
}

function openTableOptions() {
  const state = gameState || myTableConfig;
  const mode = gameState ? (state.realMoney ? 'Real sats' : 'Demo chips') : 'Connecting…';
  $('tableOptionsSummary').textContent = `${NUM_SEATS} seats · ${fmt(state.smallBlind)} / ${fmt(state.bigBlind)} blinds · ${mode}`;
  const dialog = $('tableOptions');
  if (!dialog.open) dialog.showModal();
}

function openTableHistory() {
  $('tableOptions').close();
  const panel = $('chatBox');
  panel.classList.remove('collapsed');
  $('chatCollapseBtn').setAttribute('aria-expanded', 'true');
  $('chatCollapseBtn').setAttribute('aria-label', 'Collapse chat panel');
  if (document.body.classList.contains('is-mobile')) {
    panel.classList.add('mobile-open');
    $('mobileChatBackdrop')?.classList.add('visible');
    $('mobileChatToggle')?.classList.add('chat-active');
    $('mobileChatToggle')?.setAttribute('aria-expanded', 'true');
    $('mobileChatToggle')?.setAttribute('aria-label', 'Close table chat');
    focusDialog(panel);
  }
  document.querySelector('.chat-tab[data-tab="history"]')?.click();
}

// ============================================================
//  MOBILE CHAT TOGGLE
// ============================================================
function initMobileChat() {
  // Initialize once on every device so resizing can reveal the same panel.
  // Create backdrop
  const backdrop = document.createElement('div');
  backdrop.className = 'mobile-chat-backdrop';
  backdrop.id = 'mobileChatBackdrop';
  document.body.appendChild(backdrop);

  // Create toggle button
  const chatToggle = document.createElement('button');
  chatToggle.className = 'mobile-chat-toggle';
  chatToggle.id = 'mobileChatToggle';
  chatToggle.textContent = 'Chat';
  chatToggle.setAttribute('aria-label', 'Open table chat');
  chatToggle.setAttribute('aria-controls', 'chatBox');
  chatToggle.setAttribute('aria-expanded', 'false');
  chatToggle.title = 'Toggle chat';
  document.body.appendChild(chatToggle);

  const chatBox = document.getElementById('chatBox');

  function openChat() {
    chatBox.classList.remove('collapsed');
    chatBox.classList.add('mobile-open');
    chatToggle.setAttribute('aria-expanded', 'true');
    chatToggle.setAttribute('aria-label', 'Close table chat');
    backdrop.classList.add('visible');
    chatToggle.classList.add('chat-active');
    chatToggle.classList.remove('has-unread');
    focusDialog(chatBox);
  }
  function closeChat() {
    const wasOpen = chatBox.classList.contains('mobile-open');
    chatBox.classList.remove('mobile-open');
    chatToggle.setAttribute('aria-expanded', 'false');
    chatToggle.setAttribute('aria-label', 'Open table chat');
    backdrop.classList.remove('visible');
    chatToggle.classList.remove('chat-active');
    if (wasOpen) restoreDialogFocus(chatBox);
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
  $('mobileChatClose').addEventListener('click', closeChat);
  document.addEventListener('keydown', e => {
    if (e.key === 'Escape' && chatBox.classList.contains('mobile-open')) { closeChat(); chatToggle.focus(); }
  });
  window.addEventListener('table-layout-change', closeChat);
}

function signalMobileUnread() {
  if (!document.body.classList.contains('is-mobile')) return;
  const chatBox = document.getElementById('chatBox');
  const toggle = document.getElementById('mobileChatToggle');
  if (toggle && chatBox && !chatBox.classList.contains('mobile-open')) {
    toggle.classList.add('has-unread');
  }
}

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
  // Real-money: standing up with chips means cashing out (you can't abandon sats).
  // Busted players (no chips) fall through to the normal stand-up.
  if (isRealMoneyTable() && mySeat) {
    const me = (gameState && gameState.players || []).find(p => p && p.userId === myUserId);
    if (me) { returnTableStack(); return; }
  }
  handleStandUpPlain();
};

function handleStandUpPlain() {
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
}

// ============================================================
//  REAL-MONEY WALLET (Lightning buy-in / cash-out)
// ============================================================
function isRealMoneyTable() {
  // Prefer the server's authoritative flag; fall back to the table config so a
  // seat-click works even before the first game-state arrives.
  return gameState ? !!gameState.realMoney : !!myTableConfig.realMoney;
}

function requestRealMoneyBuyin() {
  if (!socket) { showToast('Not connected — try again in a moment'); return; }
  if (!mySessionToken) { handleNostrLoginThenSit(); return; }
  const min = (gameState && gameState.minBuyin) || (myTableConfig && myTableConfig.minBuyin) || 5000;
  const max = (gameState && gameState.maxBuyin) || (myTableConfig && myTableConfig.maxBuyin) || 10000;
  const body =
    `<p id="buyinAccountBalance" role="status">Checking account balance…</p><div class="wallet-amount">Choose your buy-in</div>` +
    `<div class="wallet-buyin-value"><b id="rmBuyinAmt">${fmt(max)}</b> sats</div>` +
    `<input id="rmBuyinSlider" class="wallet-slider" aria-label="Buy-in amount in sats" type="range" min="${min}" max="${max}" step="100" value="${max}">` +
    `<div class="wallet-slider-ends"><span>${fmt(min)}</span><span>${fmt(max)}</span></div>` +
    `<button class="wallet-btn" data-action="generate-buyin-invoice">Buy in from account</button><button class="wallet-btn secondary" data-action="account-deposit">Deposit sats</button>`;
  showWalletModal('Buy in', body);
  fetchWalletState().then(state => { const label=$('buyinAccountBalance'); if (label) label.textContent=`Available in your account: ${fmt(state.availableSats)} sats`; }).catch(error=>showToast(error.message));
  const slider = document.getElementById('rmBuyinSlider');
  const amt = document.getElementById('rmBuyinAmt');
  if (slider && amt) slider.addEventListener('input', () => { amt.textContent = fmt(Number(slider.value)); });
}

function showAccountDeposit(defaultAmount = 10000) {
  walletView = 'deposit-amount';
  showWalletModal('Deposit sats', `<p>Deposits stay in your SatoshiStacks account until you buy in or withdraw.</p>
    <label for="accountDepositAmount">Amount in sats</label>
    <input id="accountDepositAmount" class="wallet-invoice-input" type="number" min="1" step="1" value="${Number.isSafeInteger(defaultAmount) && defaultAmount > 0 ? defaultAmount : 10000}">
    <button class="wallet-btn" data-action="account-deposit-invoice">Create Lightning invoice</button>`);
}
function requestAccountDeposit() {
  const amountSats = Number($('accountDepositAmount')?.value);
  if (!Number.isSafeInteger(amountSats) || amountSats <= 0) { showToast('Enter a positive whole number of sats.'); return; }
  if (!socket?.connected || !mySessionToken || walletRequestPending) return;
  walletRequestPending = true;
  socket.emit('account-deposit-request', {tableId:myTableId, sessionToken:mySessionToken, amountSats});
  walletView = 'deposit-preparing';
  showWalletModal('Deposit sats', '<p role="status">Creating your Lightning invoice…</p>');
  setTimeout(async () => {
    if (walletView !== 'deposit-preparing') return;
    walletRequestPending = false;
    try {
      const state = await fetchWalletState();
      const invoice = state.deposits.find(p => p.status === 'pending' && p.bolt11 && p.expiresAt > Date.now()/1000);
      if (invoice) showBuyinInvoice({bolt11:invoice.bolt11, amountSats:invoice.amount_sats, paymentHash:invoice.payment_hash, expiresAt:invoice.expiresAt});
      else { walletView = 'cashout'; lastCashoutView = ''; renderCashoutState(state); }
    } catch(error) { showToast(error.message); }
  }, 10000);
}
function returnTableStack() {
  if (!socket?.connected || !mySessionToken) return;
  socket.emit('table-cashout-request', { tableId:myTableId, sessionToken:mySessionToken });
}

async function generateBuyinInvoice() {
  if (walletRequestPending) return;
  if (!socket?.connected || !mySessionToken) { showToast('Reconnect and sign in before paying.'); return; }
  walletRequestPending = true;
  const token = mySessionToken;
  const amountSats = Number($('rmBuyinSlider')?.value);
  try {
    const funds = await fetchWalletState();
    if (token !== mySessionToken) throw new Error('Your account changed. Reopen your buy-in.');
    const pending = (funds.deposits || []).find(row => row.status === 'pending' && row.bolt11 && row.expiresAt > Date.now()/1000);
    if (pending && funds.availableSats < amountSats) { showBuyinInvoice({ bolt11:pending.bolt11, amountSats:pending.amount_sats, paymentHash:pending.payment_hash, expiresAt:pending.expiresAt }); return; }
    if (funds.availableSats < amountSats) { showAccountDeposit(amountSats - funds.availableSats); return; }

    walletView = 'buyin-preparing';
    showWalletModal('Buy in', '<div class="wallet-status" role="status">Moving sats from your account to the table…</div>');
    socket.emit('buyin-request', { tableId:myTableId, sessionToken:mySessionToken, amountSats });
    // Recover a lost seating response from authoritative state; never pay again.
    setTimeout(async () => {
      if (walletView !== 'buyin-preparing') return;
      try {
        const state = await fetchWalletState();
        if (state.seated) {
          socket.emit('observe-table', {tableId:myTableId,sessionToken:mySessionToken});
          closeWalletModal();
        } else {
          walletView='cashout'; lastCashoutView=''; renderCashoutState(state);
        }
      } catch (error) { showToast(error.message); }
      finally { walletRequestPending=false; }
    }, 10000);
  } catch(error) { showToast(error.message); }
  finally { walletRequestPending=false; }
}
function showBuyinInvoice(invoice) {
  const {bolt11, amountSats, expiresAt}=invoice;
  activeBuyinInvoice = bolt11;
  activeBuyinDetails = invoice;
  walletView = 'buyin-invoice';
  const expired = expiresAt && expiresAt <= Date.now()/1000;
  showWalletModal('Deposit to your account',
    `<div class="wallet-amount"><b class="wallet-balance">${fmt(amountSats)} sats</b></div>`+
    `<p class="wallet-status">Pay once using your browser wallet, or scan/copy this invoice in another wallet. Your account is credited after server confirmation. Then choose a table buy-in.</p>`+
    `<div class="wallet-qr" id="buyinQR"></div>`+
    `<button id="payBuyinBtn" class="wallet-btn" data-action="pay-buyin-wallet" ${expired?'disabled':''}>Pay with Lightning wallet</button>`+
    `<button class="wallet-btn secondary" data-action="copy-buyin-invoice">Copy Lightning invoice</button>`+
    `<p class="wallet-status" id="buyinInvoiceStatus" role="status">${expired?'This invoice has expired. Close and request a new deposit.':`Invoice expires ${new Date(expiresAt*1000).toLocaleTimeString([], {hour:'numeric',minute:'2-digit'})}. If payment is pending, wait for confirmation.`}</p>`);
  if (typeof QRCode !== 'undefined') new QRCode($('buyinQR'), {text:bolt11,width:180,height:180,correctLevel:QRCode.CorrectLevel.M});
  else $('buyinQR').textContent='Copy the invoice to pay in your wallet.';
}
async function copyBuyinInvoice() {
  if (!activeBuyinInvoice) return;
  try { await navigator.clipboard.writeText(activeBuyinInvoice); showToast('Lightning invoice copied.', 'info'); }
  catch (_) { showToast('Clipboard unavailable. Use your connected wallet or the QR code.'); }
}

async function fetchWalletState() {
  const target = socket, token = mySessionToken, pubkey = myPubkeyHex;
  if (!target?.connected || !token) throw new Error('Sign in and reconnect to check your balance');
  return new Promise((resolve, reject) => {
    const cleanup = () => { clearTimeout(timer); target.off('wallet-state', receive); target.off('disconnect', disconnected); };
    const timer = setTimeout(() => { cleanup(); reject(new Error('Balance request timed out — try again')); },10000);
    function disconnected() { cleanup(); reject(new Error('Connection lost. Reconnect to check your balance.')); }
    function receive(state) {
      if (state.tableId !== myTableId || state.userId !== pubkey) return;
      cleanup();
      if (token !== mySessionToken) reject(new Error('Your account changed. Reopen your wallet.'));
      else resolve(state);
    }
    target.on('wallet-state',receive);
    target.once('disconnect',disconnected);
    target.emit('wallet-state-request',{tableId:myTableId,sessionToken:token});
  });
}

function renderCashoutState(state) {
  if (!['cashout','cashout-pending'].includes(walletView)) return;
  const signature = JSON.stringify([state.availableSats,state.error,state.withdrawalsEnabled,state.depositsEnabled,state.payments,state.tableStackSats,state.seated,state.canReturnStack,state.transfers]);
  if (signature === lastCashoutView && walletView !== 'cashout-pending') return;
  lastCashoutView = signature;
  const invoice = $('cashoutInvoice')?.value;
  const withdrawalAmount = $('withdrawalAmount')?.value;
  walletView = 'cashout';
  showWalletModal('Your SatoshiStacks account', window.StacksWalletUI.cashoutHTML(state));
  if (withdrawalAmount && $('withdrawalAmount')) $('withdrawalAmount').value=withdrawalAmount;
  if (invoice && $('cashoutInvoice')) { $('cashoutInvoice').value=invoice; $('cashoutInvoice').closest('details').open=true; }
}
async function startCashout() {
  if (walletBusy || !socket?.connected || !mySessionToken) { showToast('Sign in and reconnect to view your balance.'); return; }
  walletBusy=true;
  walletView='cashout';
  lastCashoutView='';
  showWalletModal('Your SatoshiStacks account','<p class="wallet-status" role="status">Checking your balance…</p>');
  try {

    const funds=await fetchWalletState();
    renderCashoutState(funds);
  } catch(error) { showWalletModal('Your SatoshiStacks account',`<p class="wallet-status" role="alert">${esc(error.message)}</p><button class="login-back-btn" data-action="refresh-cashout">Try again</button>`); }
  finally { walletBusy=false; }
}
async function confirmCashout(usePastedInvoice=false) {
  if (walletBusy || !socket?.connected || !mySessionToken) return;
  const token=mySessionToken;
  const pasted=$('cashoutInvoice')?.value.trim().replace(/^lightning:/i,'');
  const amountSats=Number($('withdrawalAmount')?.value);
  walletBusy=true;
  document.querySelectorAll('#walletModal .wallet-btn').forEach(button=>button.disabled=true);
  try {
    const funds=await fetchWalletState();
    if (funds.error) throw new Error(funds.error);
    if (!funds.withdrawalsEnabled) throw new Error('Withdrawals are temporarily unavailable. Your balance remains recorded.');
    if (!funds.availableSats) throw new Error('No balance available. A previous payment may still be pending.');
    let bolt11=pasted;
    if (usePastedInvoice) {
      if (!bolt11 || !/^ln(?:bc|tb|bcrt|sb)[0-9a-z]+$/i.test(bolt11)) throw new Error('Paste a complete Lightning invoice from your receiving wallet.');
    } else {
      if (!lightningWallet.isConnected()) await lightningWallet.connect();
      if (localStorage.getItem('ss_authMethod')==='nip07') await window.StacksProviders.assertIdentity(window.nostr,myPubkeyHex);
      if (!Number.isSafeInteger(amountSats) || amountSats <= 0 || amountSats > funds.availableSats) throw new Error('Choose an amount within your available balance.');
      bolt11=await lightningWallet.invoice(amountSats);
    }
    if (token!==mySessionToken || !socket?.connected) throw new Error('Your session changed. Reconnect and check your balance before withdrawing.');
    walletView='cashout-pending';
    socket.emit('cashout-request',{tableId:myTableId,sessionToken:token,bolt11});
    showWalletModal('Withdrawal pending','<p class="wallet-status" role="status">Request sent. Waiting for the server to reserve your balance and confirm the Lightning payment…</p>');
  } catch(error) { showToast(error.message || 'Withdrawal canceled'); }
  finally { walletBusy=false; updateWalletButtons(); document.querySelectorAll('#walletModal .wallet-btn').forEach(button=>button.disabled=false); }
}

async function payBuyinWithWallet() {
  if (walletBusy || !activeBuyinInvoice) return;
  walletBusy = true;
  const token = mySessionToken, invoice = activeBuyinInvoice;
  if (activeBuyinDetails?.expiresAt <= Date.now()/1000) { walletBusy=false; showToast('This invoice has expired. Request a new deposit.'); return; }
  let submitted = false;
  const button = $('payBuyinBtn');
  if (button) { button.disabled = true; button.textContent = 'Approve in your wallet…'; }
  try {
    if (!lightningWallet.isConnected()) await lightningWallet.connect();
    if (localStorage.getItem('ss_authMethod') === 'nip07') await window.StacksProviders.assertIdentity(window.nostr, myPubkeyHex);
    if (token !== mySessionToken || invoice !== activeBuyinInvoice) throw new Error('Your account or invoice changed. Reopen your buy-in.');
    await lightningWallet.pay(invoice);
    submitted = true;
    if (button) { button.textContent='Waiting for confirmation…'; }
    const status=$('buyinInvoiceStatus');
    if (status) status.textContent='Payment submitted. Waiting for confirmation from the server.';
    showToast('Payment sent. Waiting for the server to confirm your deposit.', 'info');
  } catch (error) {
    const status=$('buyinInvoiceStatus');
    if (status) status.textContent='Payment has not been confirmed. Check your wallet before retrying. A settled payment will be recognized automatically.';
    showToast(error.message || 'Payment canceled');
  }
  finally {
    walletBusy = false;
    updateWalletButtons();
    if (button) { button.disabled = submitted; button.textContent = submitted ? 'Waiting for server confirmation…' : 'Pay with Lightning wallet'; }
  }
}

function showWalletModal(title, bodyHtml) {
  let el = document.getElementById('walletModal');
  if (!el) {
    el = document.createElement('div');
    el.id = 'walletModal';
    el.className = 'wallet-modal-overlay';
    document.body.appendChild(el);
  }
  el.innerHTML =
    `<div class="wallet-modal">` +
    `<button class="wallet-close" data-action="close-wallet" aria-label="Close wallet dialog">&times;</button>` +
    `<div class="wallet-title" id="walletDialogTitle">${title}</div>` +
    bodyHtml +
    `</div>`;
  el.setAttribute('role', 'dialog');
  el.setAttribute('aria-modal', 'true');
  el.setAttribute('aria-labelledby', 'walletDialogTitle');
  el.classList.remove('hidden');
  focusDialog(el);
}

function closeWalletModal() {
  walletRequestPending = false;
  walletView = null;
  lastCashoutView = '';
  const el = document.getElementById('walletModal');
  if (el) el.classList.add('hidden');
  restoreDialogFocus(el);
}

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
    // Real-money tables: take a seat by paying a Lightning invoice, not free chips.
    if (isRealMoneyTable()) {
      requestRealMoneyBuyin();
    } else {
      showBuyinDialog();
    }
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
  // Real-money: you can't top up for free — cash out and buy back in instead.
  if (isRealMoneyTable()) {
    showToast('Cash out and buy back in to change your stack');
    return;
  }
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
    <div style="font-size:14px;color:var(--warm-white);margin-bottom:16px;">Stack: ${fmt(player.stack)}</div>
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
  if (isRealMoneyTable()) { requestRealMoneyBuyin(); return; }
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
  if (display) display.textContent = fmt(myTableConfig.maxBuyin);

  overlay.classList.remove('hidden');
  focusDialog(overlay);
}

function hideBuyinDialog() {
  const overlay = $('buyinOverlay');
  if (overlay) overlay.classList.add('hidden');
  restoreDialogFocus(overlay);
  buyinMode = 'sit';
}

function initBuyinDialog() {
  const slider = $('buyinSlider');
  const display = $('buyinAmountDisplay');
  const sitBtn = $('buyinSitBtn');
  const cancelBtn = $('buyinCancelBtn');

  if (slider && display) {
    slider.addEventListener('input', () => {
      display.textContent = fmt(parseInt(slider.value));
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
  // Surface any runtime JS error as a visible toast instead of failing silently
  // (so a broken click can never look like "nothing happens" again).
  window.addEventListener('error', (e) => {
    try { showToast('⚠️ ' + (e.message || 'Script error'), 'error'); } catch (_) {}
    console.error('[GlobalError]', e.message, e.error && e.error.stack);
  });
  window.addEventListener('unhandledrejection', (e) => {
    try { showToast('⚠️ ' + ((e.reason && e.reason.message) || 'Async error'), 'error'); } catch (_) {}
    console.error('[UnhandledRejection]', e.reason);
  });

  // Set page title from table config
  document.title = `${myTableConfig.emoji ? myTableConfig.emoji + ' ' : ''}${myTableConfig.name} – Satoshi Stacks`;

  initChat();
  initBuyinDialog();
  initMobileChat();
  $('mobileAccountActions').addEventListener('click', e => {
    if (e.target.closest('button')) $('tableOptions').close();
  }, true);

  // Try to restore existing NOSTR session
  showWalletControls();
  if (await tryRestoreSession()) hideLoginOverlay();
  // Observation resumes an existing seat without issuing a fresh buy-in.
  connectAsObserver();
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
  if (actionEl.closest('#mobileAccountActions, #mobileSeatActions')) $('tableOptions').close();
  switch (action) {
    case 'table-options': openTableOptions(); break;
    case 'close-table-options': $('tableOptions').close(); break;
    case 'table-hand-history': openTableHistory(); break;
    case 'sit-back-in': handleSitBackIn(); break;
    case 'sit-out': handleSitOut(); break;
    case 'stand-up': handleStandUp(); break;
    case 'connect-wallet': window.connectWallet(); break;
    case 'sign-out': nostrLogout(); showToast('Signed out. Any funds remain recoverable with the same Nostr identity.', 'info'); break;
    case 'pay-buyin-wallet': payBuyinWithWallet(); break;
    case 'recover-funds': startCashout(); break;
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
    case 'observer-sign-in': handleObserverSignIn(); break;
    case 'edit-profile': profileEditor.open(); break;
    case 'account-deposit': showAccountDeposit(); break;
    case 'account-deposit-invoice': requestAccountDeposit(); break;
    case 'return-table-stack': returnTableStack(); break;
    case 'account-buyin': requestRealMoneyBuyin(); break;
    case 'generate-buyin-invoice': generateBuyinInvoice(); break;
    case 'confirm-cashout': confirmCashout(); break;
    case 'confirm-pasted-cashout': confirmCashout(true); break;
    case 'refresh-cashout': startCashout(); break;
    case 'copy-buyin-invoice': copyBuyinInvoice(); break;
    case 'close-wallet': closeWalletModal(); break;
    case 'submit-bunker': submitBunkerLogin(); break;
    case 'nip07-login': handleNIP07Login(); break;
    case 'show-private-key': showPrivateKeyScreen(); break;
    case 'create-nostr-account': createNostrAccount(); break;
    case 'copy-new-nsec': copyCreatedNsec(); break;
    case 'finish-create-account': finishCreatedAccount(); break;
    case 'toggle-new-nsec': {
      const input = $('loginNewNsec');
      const reveal = input.type === 'password';
      input.type = reveal ? 'text' : 'password';
      $('loginRevealNsec').textContent = reveal ? 'Hide nsec' : 'Show nsec';
      $('loginRevealNsec').setAttribute('aria-pressed', String(reveal));
      break;
    }
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
