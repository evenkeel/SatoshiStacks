# Real-Money Lightning — Operator Runbook

How to turn on real-money play safely. The code is built and gated behind
`REALMONEY_ENABLED` (default **off** — the live site stays play-money until you
flip it). Go **regtest → signet (optional) → low-cap mainnet**. Never skip regtest.

---

## 1. Bake a RESTRICTED macaroon (never use admin.macaroon)

The poker backend must only be able to: create invoices, watch for settlements,
send payments, track payments, and read node info/balance. It must **not** be able
to move on-chain funds, open/close channels, or change peers — so a server
compromise can't drain the node beyond the bounded hot-wallet float.

```bash
lncli bakemacaroon \
  info:read \
  invoices:read invoices:write \
  offchain:read offchain:write \
  --save_to ~/poker.macaroon
```

Grants: `getWalletInfo` (info:read), `AddInvoice` (invoices:write),
`SubscribeToInvoices`/`LookupInvoice` (invoices:read), `payViaPaymentRequest`
(offchain:write), `getPayment`/`ChannelBalance`/`decodePaymentRequest`
(offchain:read). Explicitly NOT `onchain:write`, channel ops, peers, or signer.

> If `decodePaymentRequest` is ever denied on your LND version, add `address:read`.

Copy the node's TLS cert too (read-only): `~/.lnd/tls.cert`.
Get the node's own pubkey (for the self-pay guard):
```bash
lncli getinfo | jq -r .identity_pubkey
```

---

## 2. Configure env (only matters when REALMONEY_ENABLED=true)

```bash
REALMONEY_ENABLED=true
WITHDRAWALS_ENABLED=true            # kill switch (set false to freeze cash-outs)
LIGHTNING_NETWORK=regtest           # regtest | signet | mainnet

LND_HOST=127.0.0.1                  # localhost if LND is on the same box
LND_PORT=10009
LND_MACAROON_PATH=/root/poker.macaroon
LND_TLS_CERT_PATH=/root/.lnd/tls.cert
LND_OWN_PUBKEY=<identity_pubkey from getinfo>

# Exposure caps — REQUIRED. Keep tiny for the first mainnet runs.
HOT_WALLET_CAP_SATS=1000000         # max single seat / per-tx ceiling
MAX_WITHDRAWAL_SATS=100000
MIN_WITHDRAWAL_SATS=1000
WITHDRAWAL_FEE_LIMIT_SATS=50
INVOICE_EXPIRY_SEC=600
```

The server **refuses to boot** with `REALMONEY_ENABLED=true` if any LND var or the
caps are missing (see `config.js` startup guard). With it false, none of this is
required and the site runs play-money exactly as today.

Also set `station100`'s buy-in to a tiny value for the first mainnet runs (e.g.
`maxBuyin: 1000` sats in `config.js`) so worst-case exposure is a few dollars.

---

## 3. Phase 0 — regtest end-to-end

Spin up a regtest LND + a second node to play the counterparty. Easiest is
[Polar](https://lightningpolar.com): create a network with 2 LND nodes + bitcoind,
open a channel between them, mine some blocks. Point `LND_*` at node 1 (the house);
use node 2 as the "player wallet".

Boot the poker server with the env above (`npm start` in `packages/backend`).
You should see `[Lightning] Connected to LND …` and `[Wallet] Real-money Lightning
wiring active`. Then exercise the full loop:

1. **Buy-in:** open `/station100`, sign in, click an empty seat → a QR + bolt11
   appears. Pay it from node 2 (`lncli payinvoice <bolt11>`). You should be seated
   automatically with a stack == the buy-in.
2. **Play** a hand (use a second browser/identity or a bot to get 2 players).
3. **Cash-out:** Stand Up → paste an invoice generated on node 2 for **exactly**
   your stack (`lncli addinvoice --amt <stack>`). Confirm node 2 receives it and
   `GET /api/admin/wallet` shows the withdrawal `succeeded` + the fee recorded.
4. **Accounting:** `curl -H "x-admin-token: $ADMIN_TOKEN" localhost:3001/api/admin/wallet`
   — verify `totals.owed` == sum of live stacks, deposits/withdrawals look right,
   `breaker.tripped=false`.

### Adversarial checks (must all hold)
- Cash-out invoice for **more than your stack** → rejected ("must equal your stack").
- Try to cash out **mid-hand** → rejected ("active hand").
- Submit the **same cash-out invoice twice** → second rejected.
- **Forced failure:** make node 2's invoice unpayable (e.g. no route / wrong
  network) → withdrawal goes `failed` → your chips are returned to the seat.
- **Crash mid-withdraw:** kill the server right after a cash-out is dispatched,
  restart → the reconciler resolves it via `getPayment` without double-paying.
- **Solvency breaker:** the 60s check trips and freezes withdrawals if the node
  can't cover `owed` (test by temporarily setting caps absurdly low / draining a
  channel).

---

## 4. Phase 1 — low-cap mainnet beta

- Switch `LIGHTNING_NETWORK=mainnet`, point at the real node (already has
  bidirectional liquidity), keep caps tiny, allowlist a few testers.
- Keep the hot-wallet float low; sweep excess to cold storage manually (the
  restricted macaroon can't do on-chain, so sweeps are a separate operator action).
- Watch `GET /api/admin/wallet` and the server logs (`[Wallet][ALERT] …`). The
  kill switch is `WITHDRAWALS_ENABLED=false` (freezes payouts instantly); a full
  freeze is `REALMONEY_ENABLED=false` + restart.

Deploy is unchanged (`git pull && npm install --production && pm2 restart`); the
only difference is the env on the box. `npm install --production` will pull
`ln-service` from the committed lockfile.

---

## Known Phase-1 simplifications (revisit later)
- Paid-but-never-seated deposit (player paid then disconnected / table full) is
  held as `settled_unseated` for **manual** refund — no LNURL auto-refund yet.
- Full stand-up cash-out only (no partial cash-out).
- Cash-out takes a pasted BOLT11 (no lud16/LNURL auto-resolution yet).
- Single backend process is assumed (the atomic-debit guarantee relies on it — do
  not horizontally scale the game server without revisiting concurrency).
