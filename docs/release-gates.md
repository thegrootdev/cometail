# Release gates

Nothing goes to mainnet until every one of these passes. They run as LiteSVM tests against
the saved mainnet Meteora binaries with `pnpm --filter @cometail/tests gates`. The
repository currently has no CI workflow; retain the local per-file results with the release.

1. **Eligibility**: non-WSOL quotes, base-fee modes, transfer-hook pools, freeze
   authorities, disallowed extensions, migration-outcome mismatches, vested liquidity,
   unlocked liquidity above the dust bound, delegates, duplicates and the vault's own
   position are all rejected; the real migrated dust remainder is accepted.
2. **Delegates** are cleared on every entry path; a pre-set delegate cannot claim after
   deposit.
3. **Mixed-source split** moves only permanently locked liquidity and chosen fees.
4. **Lifecycle**: deposits only before launch; withdrawals before launch or after a valid
   thirty-day unwind; harvest before launch
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
   unsolicited tokens burned; on a partially filled bin the refunded principal and the fee
   share equal what an independent reader of the bin arrays computes.
9. **Registration** is write-once; squatted pairs rejected; preset-pair fallback accepted;
   the own position must have canonical custody, the right pool and the required size.
   Its creator/partner identity is not recorded on chain (docs/architecture.md).
10. **Resources and ordering**: full CPI traces and compute for every instruction, launch
    depth measured, 50-bin orders in a v0 transaction, token account creation order.
11. **Splits and provenance**: exact 8/15, 1/2 and 1/5 on real claims, only on the new
    claim delta, to pinned destinations; own-stream classification can't be forged; event
    totals equal balance deltas.
12. **Configs**: the four configs reproduce the measured economics on the live binaries
    before and after creation on devnet.
13. **Security regressions**: one case per finding of the security pass: a migrated
    creator position is harvestable on its derived pool; registration survives unrelated
    liquidity additions and rejects the partner position (80/20 and 20/80) and dust
    positions in any account; Token-2022 bases harvest with their own token program; an emptied vault
    cannot launch; `register_pair` rejects strangers and fees above 1%; a bundled creator
    position cannot enter twice and its withdrawal requires and closes its index; stream
    configs with another migration option, token type or vesting are refused; an
    unrepresentable price cap is refused at vault creation.
20. **Burn program** (`tests/gates/20-burn.test.ts`): setup only by the program's upgrade authority, once, and
    only on a constant >=1% compounding $COMETAIL/SOL pool; the new launch configs byte-identical to today's
    except the fee claimer, with the same curve state after the same launch and buys; curve fees, the creation
    fee, surplus and graduated-position fees each split exactly 50/50, with the totals equal to the event
    sums; migration with the claimer as fee claimer; buyback spends min(reserve, cap), burns exactly what it
    bought (supply delta), pays its caller nothing, waits ten minutes, refuses dust and a changed pool fee; a
    sandwich around one buyback loses money at six sizes; no withdrawal path, pinned outputs.
