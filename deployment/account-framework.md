# Accounts before connecting Lightning

Players already have an account keyed by their verified Nostr public key. Sign-in,
profile editing and sign-out use the existing authentication flow; there is no
separate wallet password or key recovery service. The Account button is available
after sign-in on desktop and in the phone's Table options menu, including demo mode.

## What is ready

- Persistent available sats, distinct from demo chips and money at the table.
- Authenticated balance/activity reads even while payments are disabled or offline.
- Deposit invoices with fixed payment hashes, recovery after a lost response, and
  credit only after node-confirmed settlement. Reopening Deposit retrieves the
  outstanding invoice instead of creating a second one.
- Internal table buy-ins and returns, plus partial Lightning withdrawals through
  WebLN or a receiving invoice pasted from another wallet.
- Durable withdrawal reservations, duplicate-invoice protection, definitive-failure
  refunds, and reconciliation of uncertain results after disconnect/restart.
- Pending withdrawal totals across the entire ledger, independent of the recent
  history limit. No other player's activity is included in the account response.

`services/account-state.js` assembles the authenticated account view independently
of a connected node. `lightningStatus` is `disabled`, `offline`, `paused`, or `ready`;
`depositsEnabled` and `withdrawalsEnabled` independently control external actions.
`canBuyIn` controls account-funded seats. Demo table chips never appear as sats or
become returnable account funds. The server also enforces the payment gates.

## Node connection point

The existing `services/lightning.js` adapter implements LND; `services/payments.js`
receives it as the `lnd` dependency. The browser never receives node credentials.
No node or simulated balance is required for account management.

Keep `REALMONEY_ENABLED=false` until node setup and funded testing are complete.
Later, configure the LND host/port, TLS certificate, restricted macaroon, node public
key, network, exposure limits and routing-fee reserve in the server environment
using `packages/backend/.env.example`. Run the read-only
`npm run lnd:check --workspace=packages/backend` diagnostic. Follow
[the Lightning runbook](lightning-runbook.md) for the funded rehearsal,
then enable real-money mode and the independent deposit/withdrawal switches.
The existing maintenance loop verifies connectivity, reconciles the ledger and
checks solvency before making payments available.

A different Lightning implementation can replace the adapter while preserving its
invoice, payment-tracking, balance and subscription contract. In particular,
unknown outcomes must remain pending; they must never be reported as failures just
because an RPC timed out. The account schema and browser flow need not change.

Automated tests use a fake node. They verify accounting and integration behavior;
actual routing, liquidity and wallet interoperability require the funded rehearsal.

## Account-only money movement

The payments service rejects new table-scoped deposit and withdrawal requests.
Deposits credit the account without seating, even when a legacy table invoice
settles late. Buying in debits the account and commits the funded table snapshot
atomically. Returning a stack credits the account without an external payment.
Only available account sats can fund a new withdrawal; pending withdrawals and
table stacks cannot. A player may withdraw available account sats while playing.

No deposit timeout, disconnect or full table sends sats to a Nostr profile address.
The old profile-address auto-refund sweep was removed in commit `96698f6`.
The dispatcher additionally rejects deposit records and uses the persisted
withdrawal invoice. Already committed legacy withdrawals still reconcile;
legacy ambiguous auto-refunds require individual operator reconciliation.

The main navigation has no wallet-connection prerequisite. Invoice/QR and optional
WebLN are payment methods inside the account flow, not separate player accounts.
