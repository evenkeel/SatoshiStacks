# SatoshiStacks TODO

> Last updated: 2026-03-02
> Status: Live play-money beta (single table, ~10K lines of code)

---

## Security

- [ ] Add `NOSTR_SERVER_NSEC` placeholder to `.env.example` so new deploys know to set it
- [ ] Verify production `CORS_ORIGIN` is set to actual domain (defaults to `*` if unset)

---

## GUI Overhaul

- [ ] Overall visual polish — the UI works but needs a design pass
- [ ] Card animations refinement (deal, flip, community reveal)
- [ ] Chip stack visualization on player nameplates
- [ ] Winning hand highlight (dim non-winning community cards already works, expand this)
- [ ] Better showdown presentation (reveal sequence, hand name display)
- [ ] Pot size display improvements
- [ ] Table felt and seat layout polish
- [ ] Player avatar/nameplate redesign
- [ ] Responsive tablet layout (currently tuned for desktop + mobile, tablet is a gap)

---

## Mobile

- [ ] Polish landscape layout for various screen sizes
- [ ] Touch-friendly bet slider and action buttons
- [ ] Test on real iOS + Android devices (not just responsive mode)
- [ ] Portrait mode experience (currently forces landscape rotation prompt)
- [ ] Mobile chat UX improvements (currently modal overlay)

---

## Player Chat

- [x] Real player-to-player chat ~~(currently play-by-play only)~~
- [x] Observer chat with random names
- [x] NIP-51 mute filtering
- [ ] Chat moderation tools (report button, admin mute)
- [ ] Emoji picker
- [ ] Chat timestamps

---

## Spectator Mode

- [x] Observer auto-connect (see table immediately, no login required)
- [x] Random observer names (adjective + noun)
- [x] Observer chat with `[Name]` prefix
- [x] Click empty seat → login → buy-in flow
- [x] Spectator count badge on table ("N watching")
- [x] Waitlist system — queue for next available seat with 15s accept timer
- [x] Nostr-authenticated observers — sign in to show real profile, NIP-51 mute filtering
- [ ] Stream delay option for real-money (prevent ghosting/hole card leaks)
- [ ] Observer reactions (quick emoji reactions to big hands, visible to table)
- [ ] Let observers browse hand history (currently only visible to seated players)

---

## Testing & Quality

- [ ] Set up test framework (Jest or Vitest)
- [ ] Unit tests for hand evaluator (all hand rankings, edge cases, ties)
- [ ] Unit tests for side pot calculation
- [ ] Unit tests for betting validation (min raise, short all-in reopening)
- [ ] Integration tests for full hand lifecycle (deal → showdown)
- [ ] Soak test: 50+ hands continuous play, verify no state corruption
- [ ] Add ESLint + Prettier for consistent code style
- [ ] Set up GitHub Actions CI (lint + test on push)

---

## Reliability & Operations

- [ ] Structured logging (replace `console.log` with Winston or Pino, add log levels)
- [ ] Persist rate-limit state (currently in-memory, lost on restart)
- [ ] Add relay WebSocket connection timeouts (prevent resource leaks)
- [ ] Game state recovery after server restart (hands in progress are currently lost)
- [ ] Health check improvements (include memory usage, active connections)
- [ ] Application error monitoring (Sentry or similar)
- [ ] Log rotation configuration

---

## Lightning Integration

- [ ] Buy-in via Lightning invoice (sit down → invoice → pay → play)
- [ ] Auto-cashout on leave (sats sent to player's Lightning wallet via lud16)
- [ ] Error-only balance holding (no custodial accounts)
- [ ] NIP-57 / LNURL-pay integration for payouts
- [ ] Transaction audit trail
- [ ] Minimum/maximum buy-in denominated in sats

---

## Future Features

- [ ] Multi-table support (table lobby, table selection)
- [ ] Tournament mode (Sit & Go's, MTTs)
- [ ] Private/password-protected tables
- [ ] Player statistics page (lifetime stats, graphs)
- [ ] Hand history replayer (visual replay of saved hands)
- [ ] Straddle / optional bets
- [ ] Mobile-native client
- [ ] Rake system (when real money)

---

## Done

- [x] Core poker engine (6-max NL Hold'em with HU support)
- [x] NOSTR authentication (NIP-07 + NIP-46 bunker/QR)
- [x] Play-money chips with rebuy
- [x] Action timer + time bank (preflop/postflop pools, growth over hands)
- [x] Anti-rathole protection (2-hour window, forced stack return)
- [x] Sit-out / sit-back-in / stand-up mechanics
- [x] Dramatic all-in run-out animation
- [x] Chip vacuum animation (pot → winner)
- [x] Hand history logging (PokerStars-style format)
- [x] Admin dashboard (player management, abuse log, IP bans)
- [x] Production deployment (Hetzner VPS, Nginx, SSL, PM2)
- [x] Server hardening (UFW, fail2ban, SSH lockdown, kernel hardening)
- [x] Automated SQLite backups
- [x] CSP security headers (no unsafe-inline scripts)
- [x] NIP-58 badge system
- [x] NIP-51 follow/mute integration
- [x] Procedural sound effects (Web Audio API)
- [x] Reconnection handling with seat preservation
- [x] Auto-kick idle/busted players
