# MVP release checklist — November 7–8, 2026

Implemented on the MVP branch:

- NIP-07-first sign-in, Sidecar guidance, and phone/bunker fallback.
- Actual WebLN connection, buy-in, and cash-out; no manual invoice entry or stored NWC secret.
- Removed profile-address payouts, LNURL resolver/refunds, and unused development browser tooling.
- Exclusive cash-out, durable idle snapshots, recoverable credits, deposit idempotency, and periodic LND reconciliation.
- Regression tests, 200-hand conservation simulation, Node 24, patched dependencies, deployment failure checks.

Before real-money beta:

- [ ] Actual Sidecar sign-in, wallet connection, buy-in, and cash-out to the intended wallet/account.
- [ ] Verify permission rejection, signer/wallet switching, and reconnect on supported browsers.
- [ ] Regtest with two to six clients; restart after deposit, between hands, during betting, and during pending payout.
- [ ] Verify definitive failure versus ambiguous payment outcomes against LND.
- [ ] Verify fees, channel liquidity, switches, exposure caps, and solvency against the intended node.
- [ ] Reconcile pre-existing funds and legacy refund_pending rows without guessing.
- [ ] Rehearse backup, restore, and rollback; record the release SHA.
- [ ] Actual iOS/Android signer/wallet return tests.
- [ ] Confirm monitoring, support ownership, launch terms, and approved audience.

If the gates are not met Friday, release the labeled demo with payments disabled. Defer tournaments and additional tables.
