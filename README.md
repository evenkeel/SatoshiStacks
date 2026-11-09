# SatoshiStacks

Six-seat Texas Hold’em with Nostr sign-in and connected Lightning wallets.

Table: [satoshistacks.com/station100](https://satoshistacks.com/station100).

## Player flow

1. Watch without signing in.
2. Choose **Sign in with Nostr**. New players can choose **Create a Nostr account**, copy their nsec to a safe place, and confirm the backup before continuing. Optional free profile setup follows, with display name, bio, and HTTPS picture/website URLs. A custom `name@satoshistacks.com` identifier costs **10,000 sats once**, paid from the settled account balance with explicit purchase confirmation. Add sats through the existing account deposit flow if needed. Existing players can approve in Sidecar or another NIP-07 signer. Phone/NIP-46 signers remain available. **Edit profile** is available after sign-in.
3. Open **Account balance** and deposit sats through WebLN or by scanning/copying a Lightning invoice. Deposits credit the account only after LND confirms settlement. Pending invoices are reused after reconnecting.
4. Choose a table buy-in. Sats move from the account balance into the table stack without another Lightning payment.
5. Choose **Stand Up** or **Return table stack to account** after finishing the active hand. The remaining stack returns to the account immediately. Idle exits also return the stack to the account.
6. Withdraw any positive whole-sat amount within the available account balance through WebLN or a pasted receiving invoice. Table stacks and pending withdrawals remain separate.

Nostr signing authenticates identity; WebLN connects a wallet. Signing in creates or restores the account for that verified public key. Signing in never authorizes payment. New accounts are generated in the browser using nostr-tools' cryptographic key generator backed by `crypto.getRandomValues`; HTTPS (or a trustworthy localhost context) is required, with no weak-randomness fallback. The key export fields clear after sign-in. The new key remains only in page memory for profile edits until sign-out or page exit, when its byte buffer is zeroed. Canceling account creation also clears it. It is never sent to the server or saved in browser storage. Players must save their nsec themselves and can import it into a Nostr signer to return later. There is no backup, password reset, or key recovery/rotation. SatoshiStacks never requests an existing nsec or NWC connection secret.

Profile saves require an owner-signed Nostr kind-0 event. Unedited metadata is preserved, older relay responses cannot replace newer edits, and relay publication is reported only after an explicit acceptance. Purchases are atomic: name ownership, a 10,000-sat account debit, a durable receipt, and the profile commit together. Repeated requests and later profile edits never charge an existing owner again. Purchases require real-money mode and a ready wallet with no tripped circuit breaker; demo mode cannot sell names. Existing identifiers, including the manually assigned `allen` mapping, are grandfathered. Claims remain unique: one permanent identifier per public key, 3–30 lowercase letters/numbers/underscores/hyphens, with staff/system names reserved. `/.well-known/nostr.json?name=NAME` serves mappings with public CORS.

Owners can optionally receive Lightning payments at the same identifier by entering an existing, external Lightning address. The owner-signed profile commits to the forwarding destination in `satoshistacks_lightning_address`, and `lud16` advertises the purchased alias. The forwarding setting and its signed authorization are stored independently in `identifier_forwarding`, so profile edits in other clients cannot silently remove it. `/.well-known/lnurlp/NAME` serves the external provider's LNURL-pay information with its original callback and metadata unchanged; wallets pay that provider directly. These payments never enter the poker balance or the SatoshiStacks node. Zap support depends on the external provider. HTTPS, DNS/IP checks, pinned DNS connections, no redirects, time/size limits and rate limiting protect forwarding requests. Leaving the destination blank disables forwarding and restores the previous external `lud16` address. Identifiers are not email inboxes. Both well-known paths must reach this backend over HTTPS at `satoshistacks.com` for public discovery and receiving to work.

## Funds and recovery

**SatoshiStacks is custodial.** Real deposits go to the operator’s Lightning node. Account balances persist across logout, reconnection, and restart; they are private server records, not published to Nostr relays. Demo chips remain separate and cannot fund an account.

Account funds use the reserved `__account__` wallet-credit namespace and remain included in existing solvency/exposure checks. `account_transfers` records deposits, recoveries, table buy-ins, table returns, withdrawal reservations, and refunds. Lightning hashes and statuses remain in `ledger_entries`. Every table transfer commits with its snapshot in one SQLite transaction.

Existing table credits and settled, unseated deposits move into the account exactly once on authenticated access. Old pending table invoices settle into the account without automatically seating a player. Existing in-flight withdrawals continue through the original reconciliation path. Legacy `refund_pending` rows still require operator verification.

Withdrawals reserve only their requested account amount before sending. Definitive failures restore it once; ambiguous outcomes stay pending until LND reconciliation. Leaving a table requires no external payment. The operator must cover all liabilities and payment fees.

## Development

Use Node.js 24 (`.nvmrc`).

```sh
npm ci
cp packages/backend/.env.example packages/backend/.env
# Set a random ADMIN_TOKEN and local CORS_ORIGIN in .env.
npm run dev
```

Visit `http://localhost:3001/station100`. `REALMONEY_ENABLED=false` starts a labeled demo with no LND requirement.

```sh
NODE_ENV=production npm test
npm audit
```

Tests cover evaluation, betting, side pots, lifecycle, site-bound authentication, cancellation, session revocation, provider changes, payment timeouts, duplicate payouts, crash recovery, fractional-sat invoice rejection, late deposit settlement, snapshot rollback, and a 200-hand conservation simulation. Mocked-LND tests do not replace real signer/wallet and regtest verification.

## Architecture

- `packages/backend`: Express, Socket.IO, SQLite, authoritative engine, LND adapter, payments, authentication, and admin endpoints.
- `packages/frontend`: vanilla browser client, NIP-07 and WebLN adapters, NIP-46 fallback.
- `packages/shared`: secure shuffle and hand evaluation.
- `deployment`: provisioning, deployment, Nginx, and wallet release runbook.

Table motion follows server-state transitions: clockwise dealing, board reveals,
grouped bets and pot collection, and payouts to every winner. Repeated updates
and reconnects do not replay animations. Motion never delays actions; reduced-motion
preferences, tab visibility, resizing, and a new hand cancel transient overlays.
Player labels and avatars sit around the rail, separate from hole cards and
labeled wagers on the felt. The dealer button follows the dealer's seat; blind
markers are omitted. The pot uses a bounded sample of up to 24 chip icons above
the board, with the exact amount shown below it. The top-center chip tray opens
sound/chat settings and hand history.

Public player responses use a safe field allowlist. Relay profile events require a valid signature and matching author. Payouts no longer depend on profile Lightning addresses or an LNURL resolver.

## Release

Read [the wallet runbook](deployment/lightning-runbook.md) and [the sign-in/payment flow review](docs/wallet-flow-review.md). `/health` returns 503 when real-money mode lacks wallet readiness. `DEPOSITS_ENABLED` and `WITHDRAWALS_ENABLED` are independent switches applied on restart.

MVP scope: one Station 100 table, 50/100 blinds, 5,000–10,000-sat buy-in, watching, Nostr accounts, deposits, account-funded table buy-ins, poker, reconnect, internal table returns, and partial Lightning withdrawals. Defer tournaments, additional tables, and framework migration.

Mainnet readiness still requires actual Sidecar sign-in/payment/return testing, regtest recovery exercises, reconciliation of pre-existing funds, backup/restore rehearsal, and an approved operator configuration. Unit-test success does not establish those checks.

License: UNLICENSED.
