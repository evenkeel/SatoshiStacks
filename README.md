# SatoshiStacks

Six-seat Texas Hold’em with Nostr sign-in and connected Lightning wallets.

Table: [satoshistacks.com/station100](https://satoshistacks.com/station100).

## Player flow

1. Watch without signing in.
2. Choose **Sign in with Nostr** and approve in Sidecar or another NIP-07 signer. Phone/NIP-46 signers remain available.
3. Connect a Lightning wallet through WebLN. [Sidecar](https://sidecar.top) provides Nostr signing and a WebLN wallet backed by its wallet connection. Configure the wallet inside Sidecar; SatoshiStacks never requests an nsec or an NWC connection secret.
4. Choose a buy-in and approve **Pay with Lightning wallet**. Seating occurs only after LND confirms settlement.
5. Choose **Cash out to wallet** between hands. The wallet creates its receiving request in the background. Players never copy or paste invoices.

NIP-07 authenticates identity; WebLN connects the wallet. Signing in never authorizes payment. Browser payment success never credits chips without server confirmation. Wallets must support WebLN payments and receiving requests; verify your intended wallet before depositing.

## Funds and recovery

Real deposits go to the operator’s Lightning node while chips are in play. **This is a custodial table.** Failed payouts, idle exits, and unseated deposits remain recoverable balances until cash-out. The operator must cover all liabilities and payment fees.

Table mutations and snapshots commit in SQLite transactions, including idle tables and completed hands. A withdrawal reserves the balance and debited snapshot before sending. Definitive failures restore durable credit independently of seating and browser notifications. Unknown results remain pending until LND reconciliation; they are never automatically refunded on a timeout.

**Cash out / recover funds** works without a new seat or another deposit, including positive balances below the old minimum. Legacy `refund_pending` rows need operator reconciliation, not a blind retry.

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

Tests cover evaluation, betting, side pots, lifecycle, provider permissions, duplicate payouts, failed refund recovery, snapshot rollback, missed deposit settlement, and a 200-hand conservation simulation. Mocked-LND tests do not replace real signer/wallet and regtest verification.

## Architecture

- `packages/backend`: Express, Socket.IO, SQLite, authoritative engine, LND adapter, payments, authentication, and admin endpoints.
- `packages/frontend`: vanilla browser client, NIP-07 and WebLN adapters, NIP-46 fallback.
- `packages/shared`: secure shuffle and hand evaluation.
- `deployment`: provisioning, deployment, Nginx, and wallet release runbook.

Public player responses use a safe field allowlist. Relay profile events require a valid signature and matching author. Payouts no longer depend on profile Lightning addresses or an LNURL resolver.

## Release

Read [the wallet runbook](deployment/lightning-runbook.md). `/health` returns 503 when real-money mode lacks wallet readiness. `DEPOSITS_ENABLED` and `WITHDRAWALS_ENABLED` are independent switches applied on restart.

MVP scope: one Station 100 table, 50/100 blinds, 5,000–10,000-sat buy-in, watching, sign-in, poker, reconnect, and full-balance cash-out. Defer tournaments, additional tables, and framework migration.

Mainnet readiness still requires actual Sidecar sign-in/payment/return testing, regtest recovery exercises, reconciliation of pre-existing funds, backup/restore rehearsal, and an approved operator configuration. Unit-test success does not establish those checks.

License: UNLICENSED.
