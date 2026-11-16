# Deposit return investigation and account-only payments

## Established from repository history

Commit `324e2ed` introduced `refundUnseatedDeposits(graceSec = 120)`.
The server ran it at startup and every 60 seconds. For an older settled deposit
whose player was not seated, it read the Nostr profile's `lud16`, resolved a new
invoice at that address, and sent an outgoing Lightning payment. A successful
send marked the original deposit `refunded`.

This could produce the reported experience: pay 10,000 sats, receive them at the
operator node, then receive a separate payment back at Primal if the profile
address pointed there. This was application behavior, not a reversal of the
original settled Lightning payment. The exact historical payment has not been
verified against node/ledger records. The old path also did not retain the refund
payment hash as its own withdrawal row, so ambiguous `refund_pending` records
cannot safely be resolved by guessing or replaying them.

Commit `96698f6` removed profile-address auto-refunds and the associated LNURL
resolver. Later account work made deposits and table transfers independent.

## Current local changes

- New deposits only target the account; direct-to-table invoices are rejected.
- Every confirmed deposit, including a legacy table invoice, credits the account
  atomically without seating or sending a refund.
- Only an explicit table buy-in moves account sats into a table snapshot.
- Returning a stack moves sats back internally; active-hand rules still apply.
- New withdrawals only reserve available account sats. They never remove a seat,
  consume a table stack or include pending withdrawal funds.
- The outgoing dispatcher rejects deposit records and reads the committed
  withdrawal invoice/hash rather than accepting substituted caller fields.
- Previously committed withdrawals still reconcile; definitive failure restores
  account credit. Legacy ambiguous deposit refunds remain held for investigation.
- The main navigation no longer asks players to connect an external wallet.
  QR/invoice and optional WebLN are used only for deposits and withdrawals.

Regression coverage includes a 10,000-sat legacy deposit with a Primal profile
address, a failed notification, repeated maintenance and service restart with no
outgoing payment; direct table payment rejection; account-only withdrawals during
a hand; a buy-in racing a withdrawal; and legacy payment reconciliation. Tests use
fake node responses and isolated databases. No live payment or production balance
was changed, and these additional changes have not been deployed.
