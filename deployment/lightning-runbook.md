# Connected-wallet release runbook

## Payment architecture

NIP-07 signs the login challenge. Sidecar’s WebLN provider connects its wallet. The browser uses `sendPayment` for buy-in and `makeInvoice` for receiving a cash-out in the background; players never enter invoices. Keys and NWC secrets stay in the signer/wallet.

The operator’s LND node and ledger remain necessary: the table holds deposits while chips change hands, then pays the final balance. Browser wallet success is not authoritative confirmation.

Removed: placeholder NWC URI storage, profile-lud16 cash-outs, automatic LNURL refunds/address resolution, manual invoice controls, unused development browser tooling. Failed payouts and unseated deposits become recoverable balances instead of blind address-based sends.

## Configuration

Use Node 24 and root `npm ci`. Copy `.env.example`; set a random administrator token, exact CORS origins, and initially REALMONEY_ENABLED=false.

For funded testing configure LND connection, certificate, restricted macaroon, own pubkey, network, expiry, and fee budget. The macaroon must permit the adapter’s invoice creation/subscription/lookup/decode, wallet info, channel balance, payment send, and payment-status operations. Verify least privilege against the actual node; never use an admin macaroon.

HOT_WALLET_CAP_SATS covers held liabilities plus outstanding issued invoices. MAX_WITHDRAWAL_SATS must cover that cap so a full balance can exit. Full-balance withdrawals have no minimum. Maintain a fee reserve. The adapter verifies node identity; separately verify actual network and channel liquidity.

DEPOSITS_ENABLED=false pauses new buy-ins; WITHDRAWALS_ENABLED=false pauses new cash-outs. Restart to apply. Committed payments still reconcile; switches cannot revoke a payment already submitted to LND.

## Release rehearsal

1. Back up SQLite using its backup command, including committed WAL data. Record code SHA and configuration without secrets.
2. In regtest, sign in with Sidecar, connect the wallet, choose a buy-in, and approve payment. Verify one settled deposit and one funded seat.
3. Repeat requests before settlement; verify reuse of the same pending invoice. Verify late/extra payments remain liabilities.
4. Play with two to six users. Attempt concurrent cash-outs mid-hand and between hands. Mid-hand requests fail; an idle balance reserves once.
5. Cash out through the wallet. Verify the exact amount and intended receiving wallet against the successful server ledger and fee.
6. Force definitive payout failure, disconnect, and fill the table. Credit must remain withdrawable without another seat or deposit.
7. Interrupt communication while LND may be paying. Confirm in_flight remains held and periodic reconciliation learns the actual outcome without duplicate credit.
8. Restart after deposit, between hands, during betting, after reservation, and during send. Reconcile all snapshots and liabilities. Restored players sit out until reconnect.
9. Exercise switches, insufficient liquidity, fees, and solvency. Real-money readiness failure must return health status 503.
10. Restore a backup in isolation, rehearse rollback, and complete mobile signing/wallet return before opening access.

## Operations and migration

Use `/api/admin/wallet` with the x-admin-token header. Owed includes live stacks/bets/pots, reserved/in-flight/failed withdrawals, held deposits, and wallet credits. Refund credit is transactional; notification success never controls accounting.

Maintenance checks LND, repairs invoice subscription after errors, looks up pending deposits, reconciles payouts, checks solvency, and releases old unseated deposits into independently withdrawable credits. Unknown outcomes stay held. Legacy refund_pending deposits without an outgoing hash require manual verification in LND; never reopen them automatically.

A snapshot failure pauses the table instead of paying against an uncommitted debit. Startup preserves funded snapshots and refuses to turn them into demo chips. Do not delete them to bypass startup checks.

This upgrade cannot reconstruct balances historically lost by older builds. Reconcile existing funds before deployment. Automated tests imply neither a mainnet transaction nor production deployment.
