# Release gates

Nothing goes to mainnet until every one of these passes. They run as LiteSVM tests against
the live mainnet Meteora binaries, in CI.

1. **Eligibility**: non-WSOL quotes, base-fee modes, transfer-hook pools, freeze
   authorities, disallowed extensions, migration-outcome mismatches, vested liquidity,
   unlocked liquidity above the dust bound, delegates, duplicates and the vault's own
   position are all rejected; the real migrated dust remainder is accepted.
2. **Delegates** are cleared on every entry path; a pre-set delegate cannot claim after
   deposit.
3. **Mixed-source split** moves only permanently locked liquidity and chosen fees.
4. **Lifecycle**: deposits and withdrawals only before launch; harvest before launch
   rejected; withdrawal returns everything with fees attached; the migration window
   behaves.
5. **One-time claims** already taken upstream don't block anything.
6. **Claim destinations** are pinned; aliases and uninitialized accounts are rejected
   before any CPI; native WSOL.
7. **Routing**: both pair orientations, ascending bins on the buying side, the price cap
   at exact and adjacent bins with 6- and 9-decimal mints, overflow rejection, period
   budget exhaustion and reset, order cap, pause.
8. **Settlement**: permissionless settle only for fully filled bins; cancel and burn are
   atomic; records survive until the DLMM order closes; retries on `LiquidityLocked`;
   unsolicited tokens burned; accounting by balance deltas. Open: on a partially filled bin
   the fee share is booked as refunded principal until bin-level fill state is read.
9. **Registration** is write-once; squatted pairs rejected; preset-pair fallback accepted;
   the own position must be the right pool and role.
10. **Resources and ordering**: full CPI traces and compute for every instruction, launch
    depth measured, 50-bin orders in a v0 transaction, token account creation order.
11. **Splits and provenance**: exact 8/15, 1/2 and 1/5 on real claims, only on the new
    claim delta, to pinned destinations; own-stream classification can't be forged; event
    totals equal balance deltas.
12. **Configs**: the four configs reproduce the measured economics on the live binaries
    before and after creation on devnet.
