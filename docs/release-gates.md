# Release gates

Nothing goes to mainnet until every one of these passes. They run as LiteSVM tests against
the saved mainnet Meteora binaries with `pnpm --filter @cometail/tests gates`. They need the
SBF toolchain and the built programs, so they run locally; retain the per-file results with the
release. CI (`.github/workflows/ci.yml`) typechecks the worker and the site, lints the site and
runs the indexer and accounting regressions on every push.

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
    sandwich around one buyback loses money at six sizes; no withdrawal path, pinned outputs; a claim reports only what it
    paid (WSOL and lamport gifts reported as carried); owner claims on an older config and on a position split exactly half
    of what they paid (more than an earlier scan) to the reserve and the rest only to the signer's own WSOL account,
    leave carried funds alone, and refuse a stranger's destination or signature.
21. **Tail from a wallet** (`tests/gates/21-tail-wallet-creator.test.ts`): a coin created by a plain wallet on a
    fee-sale config gets exactly what a vault gets: the same creator curve fees, the same graduation payout (DBC's
    creator migration fee and creator surplus) and the same permanently locked creator position, under identical trades.
22. **Tail claims** (`tests/gates/22-tail-claim.test.ts`): a wallet claims a tail's curve fees and splits them in the
    same transaction, half kept, a quarter to the burn reserve, a quarter into $COMETAIL's pool as permanently locked
    liquidity in the wallet's own position (including a position shared with a migration); the exact split, the
    transaction size, the lock, the pool math the builder predicts, the one-time make-up of an unsplit claim, the
    graduation payout, and the tail's graduated position through the burn program's owner claim.
23. **Coins paired with $COMETAIL** (`tests/gates/23-paired.test.ts`): the site's own builders (`web/src/lib/paired.ts`,
    `protocol-fees.ts`) through a LiteSVM-backed connection: the config from `configs/paired.json` (quote $COMETAIL,
    the treasury as fee claimer, a raise near 130M $COMETAIL); a SOL buy in one transaction that buys exactly the
    $COMETAIL the curve takes and leaves none; a moved $COMETAIL price failing both legs; a sale to SOL (the margin kept
    as $COMETAIL) and a sale keeping $COMETAIL; a launch with a SOL first buy measured (1,262 bytes: two transactions);
    graduation into a coin/$COMETAIL pool with every position locked and trades there; creator fees in $COMETAIL; a curve
    fee claim burning exactly half of what it pays and a graduated position's claim burning half of what it measured.
    Devnet: `tests/devnet/e2e-paired.ts` runs the same path on devnet with the worker reading it back.
