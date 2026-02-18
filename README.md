# SatoshiStacks

6-max Texas Hold'em poker with NOSTR authentication. Built for Bitcoiners.

**Live:** [satoshistacks.com/playmoney](https://satoshistacks.com/playmoney)

## Vision

Poker without custodial accounts, KYC, or rake. Sit down with sats, play, stand up with sats.

**Today:** Play-money beta -- free chips, NOSTR login, zero friction.

**Tomorrow:** Lightning-native poker. Deposit via Lightning invoice to buy in. When you leave the table, sats go straight back to your NOSTR-associated Lightning wallet. No stored balances, no withdrawal flow, no custodial risk. The house never holds your money. The goal is the simplest possible path from "I want to play poker" to cards in the air, powered by Bitcoin rails.

## Features

### Poker Engine
- 6-max No-Limit Hold'em with proper blind structure (heads-up and multi-way)
- Server-authoritative game engine -- all actions validated server-side, can't cheat from the browser
- Crypto-secure deck shuffle (`crypto.randomBytes()`)
- Side pots for multi-way all-ins
- Full hand evaluation (straights, flushes, full houses, etc. with proper tiebreakers)

### Timer & Time Bank
- 15-second base action timer per turn
- Independent pre-flop and post-flop time bank pools (15s each)
- Time bank auto-activates when base timer expires and you have chips in the pot
- Time bank grows +5s per 10 hands dealt at the table (capped at 60s)
- Auto-check on timeout when possible, auto-fold when you owe chips
- 1 timeout = sit out next hand (click "I'm Back" to rejoin)

### NOSTR Authentication
- Login via NIP-07 browser extensions (nos2x, Alby, etc.)
- Profile names and avatars pulled from NOSTR identity
- No accounts, no passwords, no email

### UI & Experience
- Real-time multiplayer via WebSocket (Socket.IO)
- Card deal animations (cards fly from dealer to players)
- Chip fly animations with visual denomination breakdowns
- Pot chip accumulation display
- Action badges (Check, Call, Raise, Fold) with animations
- Two-phase life bar timer (green/yellow/red for base, blue/purple for time bank)
- Gentle two-note chime when it's your turn
- Play-by-play hand log in real-time chat
- Full hand history with copy-to-clipboard
- Player profile popups with NOSTR info
- Sit out / sit back in
- Play-money auto-rebuy (10K chips when you bust) or manual rebuy
- Mobile-responsive layout

### Admin Dashboard
- Player management (view stats, ban/unban)
- IP ban system
- Abuse logging
- Active table monitoring
- Hand history search
- Protected by admin token authentication

## Architecture

```
packages/
├── backend/           Node.js server (Express + Socket.IO + SQLite)
│   ├── server.js          WebSocket server, NOSTR auth, admin API
│   ├── poker-game.js      Game engine (timer, time bank, side pots, hand history)
│   ├── database.js        SQLite persistence (players, hands, abuse log, IP bans)
│   └── admin.html         Admin dashboard UI
├── frontend/          Single-page game client (vanilla HTML/CSS/JS)
│   └── index.html         Complete game UI (~3100 lines, no build step)
└── shared/            Crypto-secure deck + hand evaluator
    ├── deck.js            52-card deck, crypto shuffle
    └── hand-evaluator.js  7-card evaluation, best 5-card hand
```

**Server = single source of truth.** Deck shuffled with `crypto.randomBytes()`. All actions validated server-side. Players only see their own hole cards until showdown.

## Quick Start

```bash
cd packages/backend
cp .env.example .env    # Edit with your ADMIN_TOKEN
npm install
npm start
```

Open `http://localhost:3001` with a NIP-07 browser extension installed.

### Environment Variables

```bash
PORT=3001                          # Server port
NODE_ENV=production                # development or production
CORS_ORIGIN=https://yourdomain.com # CORS allowed origins
ADMIN_TOKEN=your-secret-token      # Admin dashboard access token
```

## Deployment

Production runs on a Hetzner CPX11 VPS (~$5/month) with:
- **PM2** process manager
- **Nginx** reverse proxy with rate limiting
- **Let's Encrypt** SSL
- **UFW** firewall + **fail2ban** intrusion prevention
- **Automated SQLite backups**
- SSH key-only access with kernel hardening

See `deployment/` for setup scripts:
- `server-setup.sh` -- VPS provisioning (Node.js, PM2, Nginx, UFW, fail2ban)
- `deploy-app.sh` -- App deployment
- `nginx-config.template` -- Reverse proxy config
- `setup-ssl.sh` -- SSL certificate setup
- `harden.sh` -- Security hardening

## Tech Stack

Node.js, Express, Socket.IO, better-sqlite3, nostr-tools, vanilla JS frontend. No frameworks, no build step, no dependencies you don't need.

## Roadmap

**Done**
- [x] Core poker engine (6-max NL Hold'em with HU support)
- [x] NOSTR authentication (NIP-07)
- [x] Play-money chips with auto-rebuy
- [x] Hand history and pot tracking
- [x] Card deal and chip fly animations
- [x] Two-phase timer with time bank system
- [x] Sit out / sit back in with auto-timeout
- [x] Disconnect handling with 60s reconnect grace
- [x] Admin dashboard (player management, abuse log, IP bans)
- [x] Production deployment (Hetzner VPS, Nginx, SSL, PM2)
- [x] Server hardening (UFW, fail2ban, SSH lockdown, kernel hardening)
- [x] Automated SQLite backups

**Next**
- [ ] Multi-client soak testing (50+ hands, edge cases)
- [ ] Mobile layout polish
- [ ] Player chat (currently play-by-play only)
- [ ] Spectator mode

**Lightning Integration**
- [ ] Buy-in via Lightning invoice (sit down, pay, play)
- [ ] Auto-cashout on leave (sats to NOSTR Lightning wallet)
- [ ] Error-only balance holding (no custodial accounts)
- [ ] NIP-57 / LNURL-pay integration for payouts

**Future**
- [ ] Multi-table support
- [ ] Tournament mode (SNGs, MTTs)
- [ ] Mobile-native client

## License

UNLICENSED
