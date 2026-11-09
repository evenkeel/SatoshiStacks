# Connected-wallet release runbook

## Payment architecture

NIP-07 signs the login challenge. Sidecar’s WebLN provider connects its wallet. The browser uses `sendPayment` for account deposits and `makeInvoice` for account withdrawals. Players can also scan/copy a deposit invoice or paste a receiving invoice for any positive whole-sat amount within their available account balance. Table buy-ins and returns are internal account transfers. The server validates the receiving amount in millisatoshis before reserving funds. Keys and NWC secrets stay in the signer/wallet.

The operator’s LND node and ledger remain necessary: the operator holds account balances and table stacks, then pays requested withdrawals. Browser wallet success is not authoritative confirmation.

Removed: placeholder NWC URI storage, profile-lud16 cash-outs, automatic LNURL refunds/address resolution, unused development browser tooling. Manual invoice controls are now supported as an alternative to WebLN. Failed payouts and unseated deposits become recoverable balances instead of blind address-based sends.

## Paid identifiers and Lightning-address forwarding

Custom identifiers cost 10,000 sats once, charged to settled account credit only after explicit confirmation. The claim, debit, receipt in `identifier_purchases`, account-activity entry and signed profile commit atomically. Conflicts and failed saves roll back the charge. Replays and later edits do not charge again. Existing identifiers are preserved without a retroactive charge. Identifier revenue reduces player liabilities; it does not generate an outbound Lightning payment or a second deposit. Purchases are disabled in demo mode and when the live wallet is unavailable or its breaker has tripped.

Optional receiving uses a user-selected external Lightning address committed in the signed profile and retained with its authorization in `identifier_forwarding`. External profile edits cannot silently erase the receiving setting. `/.well-known/lnurlp/NAME` returns that provider's payment information with its callback and metadata intact. The payer's wallet obtains and pays the external provider's invoice directly, so forwarding never credits a poker balance or creates an obligation in the poker ledger. Provider metadata, amount limits and zap support remain those of the receiving wallet. The existing Nginx `/.well-known/` proxy covers both NIP-05 and LNURL-pay paths.

Before release, exercise a 10,000-sat purchase on regtest, competing claims, a repeated request, a wallet outage, and restart recovery of purchase receipts. Verify public HTTPS lookup and a small, explicitly authorized forwarding payment to a receiving wallet: check its balance increases while the poker account stays unchanged. Verify changing or disabling receiving requires the owner's signature. Unit tests and browser checks use fake balances and mocked providers; they do not establish real-wallet interoperability.

## Configuration

Use Node 24 and root `npm ci`. Copy `.env.example`; set a random administrator token, exact CORS origins, and initially REALMONEY_ENABLED=false.

For funded testing configure LND connection, certificate, restricted macaroon, own pubkey, network, expiry, and fee budget. The macaroon must permit the adapter’s invoice creation/subscription/lookup/decode, wallet info, channel balance, payment send, and payment-status operations. Verify least privilege against the actual node; never use an admin macaroon.

HOT_WALLET_CAP_SATS covers held liabilities plus outstanding issued invoices. MAX_WITHDRAWAL_SATS must cover that cap so a full balance can exit. Full-balance withdrawals have no minimum. Maintain a fee reserve. The adapter verifies node identity; separately verify actual network and channel liquidity.

DEPOSITS_ENABLED=false pauses new Lightning deposits; WITHDRAWALS_ENABLED=false pauses new Lightning withdrawals. Existing account balances can still fund table buy-ins and table stacks can return internally unless the table is paused by the circuit breaker. Restart to apply. Committed payments still reconcile; switches cannot revoke a payment already submitted to LND.

## Release rehearsal

1. Back up SQLite using its backup command, including committed WAL data. Record code SHA and configuration without secrets.
2. In regtest, sign in with Sidecar, connect the wallet, deposit to the account, and approve payment. Verify one credited deposit and no automatic seat. Buy in from the account and verify one debit and one funded seat.
3. Cancel sign-in while approval is delayed; verify the late response cannot restore a session. Sign out and verify the server token is revoked. Repeat buy-in requests before settlement; verify reuse of the same pending invoice. Verify late/extra payments remain liabilities.
4. Play with two to six users. Attempt concurrent cash-outs mid-hand and between hands. Table returns during an active hand fail; account withdrawals can proceed independently. Repeated table buy-ins/returns must never duplicate a transfer.
5. Cash out through WebLN and through a pasted receiving invoice. Test fractional-sat, over-balance, self-payment, and expired invoices without sending funds for invalid requests. Verify the exact amount and intended receiving wallet against the successful server ledger and fee.
6. Force definitive payout failure, disconnect, and fill the table. Credit must remain withdrawable without another seat or deposit.
7. Interrupt communication while LND may be paying. Confirm in_flight remains held and periodic reconciliation learns the actual outcome without duplicate credit.
8. Restart after deposit, between hands, during betting, after reservation, and during send. Reconcile all snapshots and liabilities. Restored players sit out until reconnect.
9. Exercise switches, insufficient liquidity, fees, and solvency. Real-money readiness failure must return health status 503.
10. Restore a backup in isolation, rehearse rollback, and complete mobile signing/wallet return before opening access.

## Operations and migration

Use `/api/admin/wallet` with the x-admin-token header. Owed includes live stacks/bets/pots, reserved/in-flight/failed withdrawals, held deposits, and wallet credits. Refund credit is transactional; notification success never controls accounting.

Maintenance checks LND, repairs invoice subscription after errors, looks up pending deposits and rotating batches of expired invoices (late HTLC settlement), reconciles payouts, checks solvency, and releases old unseated deposits into independently withdrawable credits. Unknown outcomes stay held. A specific LND `SentPaymentNotFound` response allows re-dispatch of the original invoice/hash after a crash; transport errors never trigger a refund or a replacement payment. Active dispatches are excluded from simultaneous reconciliation. Read operations time out; the routing attempt has an explicit 60-second pathfinding budget. Legacy refund_pending deposits without an outgoing hash require manual verification in LND; never reopen them automatically.

A snapshot failure pauses the table instead of paying against an uncommitted debit. Startup preserves funded snapshots and refuses to turn them into demo chips. Do not delete them to bypass startup checks.

This upgrade cannot reconstruct balances historically lost by older builds. Reconcile existing funds before deployment. Automated tests imply neither a mainnet transaction nor production deployment.

## Persistent account migration

Back up the DB before deploying. The schema adds `account_transfers`; account balances share the `wallet_credits` table under `__account__`. Existing table-specific credits and `settled_unseated` deposits are consolidated transactionally on authenticated access. A migrated deposit becomes `credited`; its original Lightning row remains intact. Old pending invoices settle into the account. Existing funded table snapshots remain funded.

Rehearse: deposit once, buy in, return the stack, partially withdraw, reconnect, and restart. Verify account balance + table stacks + held deposits + pending withdrawals remains conserved (less succeeded payouts), and verify another public key cannot read or spend the account. Confirm no account history is published to relays. Keep player key access separate from wallet access; no key-recovery or key-rotation flow is provided.

Do not roll back to code that treats every wallet-credit namespace as a table or auto-seats settled deposits without first reconciling the migrated account balances and schema.

## Reliability and node handoff

Keep `REALMONEY_ENABLED=false` until the funded rehearsal passes. The software changes do not establish live payment success. Run `node packages/backend/check-lnd.js` with the server's environment once LND is ready. This only reads node identity, sync state, chain IDs, peers, channels and balances. Its inbound/outbound estimates subtract channel reserves and exclude inactive channels; routing topology, HTLC limits, other payments and fees can still prevent payment. Verify chain IDs independently against the intended network. The restricted macaroon also needs the channel-list read operation for diagnostics.

Invoice creation persists a random preimage, hash, amount and fixed expiry before contacting LND. A timeout or duplicate-invoice response looks up that hash; retries and restart recovery reuse the same intent. A pending row without an invoice keeps reserving exposure. Never delete it to force a new invoice: investigate its hash in LND first. Preimages are removed from live intents after invoice recovery or settlement; database backups and WAL files still require protection. Invoice creation/read RPCs are bounded by `LND_READ_TIMEOUT_MS` (10 seconds by default). Timing out a call does not cancel the underlying LND operation.

Routing defaults: up to eight paths, a 60-second routing budget, and an operator-paid fee budget of `min(500, 50 + ceil(amount_sats * 2000 / 1000000))` sats. All settings are configurable in `.env.example`. A 10,000-sat invoice gets a 70-sat fee budget; the recipient still receives 10,000 sats. Each withdrawal stores its fee budget so a restart or policy edit cannot increase an already reserved payment's budget. Maintain `ROUTING_FEE_RESERVE_SATS` (default 5,000 sats) above player liabilities plus outstanding fee budgets. Low fee reserves reject new withdrawals before debit and clear on the next successful maintenance check after funding. This does not guarantee an outbound route.

The authenticated `/api/admin/wallet` response includes fee policy and payment-event counts, latency averages/maxima, and p95 from up to the most recent 1,000 timed events per type. Invoice readiness includes recovery delays; withdrawal success includes time waiting for reconciliation. Deposit credit latency measures the local credit operation, not end-to-end wallet latency. Unresolved invoice creation and withdrawal counts identify work requiring investigation. These metrics contain no signing keys or invoice preimages. Compare counts with individual ledger rows; event types are deduplicated per payment and are not a mutually exclusive success-rate denominator.

Before enabling public deposits, rehearse on a funded test setup and then an explicitly authorized small mainnet pilot:

- Receive using at least two independent wallets, both QR/paste and WebLN; verify exactly one account credit and notification, including across reconnect/restart.
- Withdraw small, typical and full balances to those wallets. Record recipient amount, actual routing fee and elapsed time; test repeated requests and concurrent requests.
- Exercise invoice-response loss, invoice-stream interruption, inactive channels, insufficient inbound/outbound capacity, fee-cap failure and a process restart during payment. Unknown outcomes must stay reserved until LND resolves them.
- Reconcile every test against LND and the ledger, including late settlement and fees. Monitor unresolved counts and long-tail latency. Adjust routing budgets using observed results before promising payment speed or reliability.

Identifier Lightning forwarding continues to pay the configured external receiving wallet. It does not deposit into the poker account; account-deposit aliases remain a separate future change after this core payment path is proven.
