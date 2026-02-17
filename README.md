# SatoshiStacks

Play-money 6-max Texas Hold'em poker with NOSTR authentication. Built for Bitcoiners.

## Vision

Poker without custodial accounts, KYC, or rake. Sit down with sats, play, stand up with sats.

**Today:** Play-money beta — free chips, NOSTR login, zero friction.

**Tomorrow:** Lightning-native poker. Deposit via Lightning invoice to buy in. When you leave the table, sats go straight back to your NOSTR-associated Lightning wallet. No stored balances, no withdrawal flow, no custodial risk. The house never holds your money — only if a payout fails do we temporarily hold sats.

The goal is the simplest possible path from "I want to play poker" to cards in the air, powered by Bitcoin rails.

## What Works Right Now

- 6-max No-Limit Hold'em with proper blind structure
- NOSTR login via NIP-07 browser extensions (nos2x, Alby, etc.)
- Server-authoritative game engine — can't cheat from the browser
- Real-time multiplayer via WebSocket
- Hand history in PokerStars format
- Pot chip accumulation with visual denominations
- Side pots for multi-way all-ins
- 20-second action timer with auto-fold
- Disconnect handling with 60s reconnect grace
- Play-money auto-rebuy (10K chips when you bust)

## Architecture

```
packages/
├── backend/         Node.js server (Express + Socket.IO + SQLite)
│   ├── server.js        WebSocket server + NOSTR auth endpoints
│   ├── poker-game.js    Game engine
│   └── database.js      SQLite persistence
├── frontend/        Single-page UI (vanilla HTML/CSS/JS)
│   └── index.html       Complete game client
└── shared/          Crypto-secure deck + hand evaluator
```

**Server = single source of truth.** Deck shuffled with `crypto.randomBytes()`. All actions validated server-side. Players only see their own hole cards until showdown.

## Quick Start

```bash
cd packages/backend
cp .env.example .env
npm install
npm start
```

Open `http://localhost:3001` with a NIP-07 browser extension installed.

## Deployment

See `deployment/README.md` for full VPS setup:
- Server provisioning script (Node.js, PM2, Nginx, UFW, fail2ban)
- App deployment with PM2
- Nginx reverse proxy config
- SSL via Let's Encrypt

Runs on a $4/month VPS.

## Roadmap

**Beta (now)**
- [x] Core poker engine
- [x] NOSTR authentication
- [x] Play-money chips
- [x] Hand history
- [ ] Multi-client soak testing
- [ ] Mobile polish

**Lightning Integration**
- [ ] Buy-in via Lightning invoice (sit down → pay → play)
- [ ] Auto-cashout on leave (sats sent to NOSTR Lightning wallet)
- [ ] Error-only balance holding (no custodial accounts)
- [ ] NIP-57 / LNURL-pay integration for payouts

**Future**
- [ ] Multi-table support
- [ ] Tournament mode (SNGs, MTTs)
- [ ] Relay-based profile fetching (avatars, display names)
- [ ] Mobile-native client

## Tech Stack

Node.js, Express, Socket.IO, SQLite, nostr-tools, vanilla JS frontend. No frameworks, no build step, no dependencies you don't need.

## License

UNLICENSED
