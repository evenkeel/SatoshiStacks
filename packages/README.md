# SatoshiStacks Monorepo

**Phase 5: Server-Authoritative Play-Money Poker**

## Structure

```
packages/
├── backend/        - Node.js WebSocket server, game engine
├── frontend/       - Client UI (modified poker.html)
└── shared/         - Deck + hand evaluator (used by both)
```

## Architecture

**Server = Single Source of Truth**
- Shuffles deck with `crypto.randomBytes()` (not `Math.random()`)
- Validates all player actions
- Filters game state (players only see own hole cards)

**Client = Dumb Display Terminal**
- Renders UI based on server's game state
- Sends actions to server (fold/call/raise)
- Cannot cheat via browser inspection

## Setup

```bash
# Install all dependencies
npm run install:all

# Start development server
npm run dev

# Server runs on http://localhost:3000
```

## Phase 5.1 Status

**✅ Complete:**
- [x] Monorepo structure created
- [x] Deck module (shared) - crypto shuffle
- [x] Hand evaluator (shared) - 7-card to 5-card
- [x] PokerGame class (backend) - server-authoritative engine
- [x] WebSocket server (backend) - multiplayer state sync

**⏳ Next:**
- [ ] Modify poker.html → connect to WebSocket (remove local logic)
- [ ] Test multiplayer gameplay
- [ ] Add authentication (Phase 5.2)
- [ ] Build lobby UI (Phase 5.3)

## Security Features

- **Crypto-secure shuffle:** `crypto.randomBytes()` on server
- **Action validation:** Server checks all bets/raises
- **State filtering:** `getGameState(userId)` only shows player's cards
- **No client-side logic:** Client can't cheat

## Next Steps

1. Copy `poker.html` → `packages/frontend/`
2. Strip out game logic (deck, shuffle, betting)
3. Add Socket.IO client connection
4. Test with 2+ browser tabs (multiplayer)

---

**Real money/Lightning:** Deferred to future phases (after play-money testing complete)
