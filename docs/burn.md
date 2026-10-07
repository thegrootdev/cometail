# $COMETAIL buyback and burn

Half of the protocol's revenue buys $COMETAIL on its own pool and burns it, on chain, in a separate
program (`programs/cometail_burn`, program id `BuN6MuTRCD7VuzwRpvJKPFwh86bsU81L23tKtRBofhX1`). The vault
program is not changed by any of this.

## What is enforced, and what is a commitment

| Revenue source | How half of it reaches the burn | Enforced by |
|---|---|---|
| Protocol fees of the launch configs created for this program (Standard, Long, Flat, Exponential: the same parameters as today's presets, with the program's claimer as fee claimer) | The program claims them and splits 50/50 to the burn reserve and the protocol treasury in the same instruction | The program |
| Today's launch configs (existing coins keep them, including $COMETAIL and TAIL) and the fee-sale stream configs | The owner claims them on `/admin/fees` through the program's owner claims: the program measures what each claim pays and sends exactly half to the burn reserve and half back to the signer's own WSOL account, in the same instruction | The program, for every claim made through it; claims made elsewhere are the owner's commitment |
| The two non-SOL presets (USDC, stock) | Claimed as before | Outside the 50% scope: the reserve spends SOL only |
| The tails' 1/5 protocol share (paid by the vault program into the treasury) | The owner sends half from the treasury on `/admin/fees` (a plain transfer, never a close or an unwrap) | The owner's commitment, checked on the site |

Meteora requires the config's fee claimer to sign every partner claim and a config's fee claimer can never
change, so only configs created with the program's claimer can be split by code. Revenue in USDC or a
stock token is outside the 50% scope: the reserve can only spend SOL.

## Accounts (all PDAs of the program)

| Seed | What it is |
|---|---|
| `burn` | The singleton state: the pinned mint, pool, treasury and accounts, the pool's fee settings at setup, the totals. |
| `claimer` | The fee claimer the new configs name. It holds nothing; it signs Meteora claims through the program and holds the partner's locked position NFT after a migration. |
| `reserve` | WSOL waiting to buy $COMETAIL. Its only exit is a buyback. |
| `inbox` | WSOL claims land here and are split in the same instruction. |
| `placeholder` | WSOL account passed as the token-A destination of quote-only claims; it never receives anything (a token-A transfer to it would fail and revert). |
| `bought` | $COMETAIL a buyback receives, burned in the same instruction. |

## Instructions

None takes an argument. Every account a transfer can reach is pinned in the state or derived.

| Instruction | Who | What |
|---|---|---|
| `setup` | the program's upgrade authority, once | Pins the $COMETAIL mint, its DAMM v2 pool and the treasury; requires the pool to be $COMETAIL (token A) / SOL (token B), compounding, enabled, no dynamic fee, a constant fee of at least 1%; records the pool's base-fee bytes and compounding share; creates the four token accounts (the signer pays their rent). |
| `claim_curve_fees` | anyone | DBC partner trading fees of a pool on a config naming the claimer, quote only; split. |
| `claim_creation_fee` | anyone | The partner's share of the pool creation fee (lamports, synced into the inbox); split. |
| `claim_surplus` | anyone | The partner's share of a finished curve's surplus; split. On these presets the curve's last buy stops at the threshold, so this is usually zero. |
| `claim_position_fees` | anyone | Fees of a graduated pool's position whose NFT the claimer holds (compounding pools pay in SOL only); split. |
| `sweep_inbox` | anyone | Splits anything sent to the inbox directly. |
| `owner_claim_curve_fees`, `owner_claim_creation_fee`, `owner_claim_surplus`, `owner_claim_position_fees` | the config's fee claimer (Meteora checks it) or the position NFT's holder (checked here) | The same Meteora claims, signed by their owner, into the inbox; only this claim's own measured amount is split: half to the reserve, half to the signer's own WSOL account (the only account the other half can reach). Funds already in the inbox are not touched. |
| `buyback` | anyone | Buys and burns, within the bounds below. The keeper runs it; the caller only pays the network fee. |

Every claim syncs and reads the inbox before and after the Meteora call: `claimed` is what the claim paid,
`carried` what was already there (sent to the inbox directly). A program claim splits the whole inbox and
reports both; an owner claim splits only `claimed`. The split is `amount * 5000 / 10000` (rounded down) to the
reserve and the rest to the treasury (program claims) or the signer (owner claims). Event: `ClaimSplit
{ source, pool, claimant (default key for program claims), claimed, carried, to_reserve, to_other, other }`.

## Buyback bounds

- Amount: `min(reserve, cap)`, computed by the program; the caller supplies nothing.
- Cap: the pool's SOL reserve (`token_b_amount`, the constant-product reserve of a compounding pool) times its fee
  numerator, divided by 1e9, divided by 5. At the mainnet pool's depth on 2026-10-07 (32.78 SOL, 1%) that is
  0.06556 SOL, which moves the price about 0.4%.
- Minimum: 0.001 SOL; below it the buyback fails and the ten-minute clock does not move.
- Cooldown: one buyback every 600 seconds at most, so chunks cannot be stacked inside one transaction.
- Minimum out: the program's own quote from the pool state it just read (fee on the SOL input rounded up, constant
  product rounded down, as Meteora's compounding pool computes it), less 0.5%. It guards against arithmetic and
  rounding surprises inside the swap, not against an external price.
- Pool checks every time: the pinned pool, its mints and vaults, compounding mode, enabled, no dynamic fee, the
  base-fee bytes and compounding share unchanged since setup. Any change (a Meteora operator update) stops
  buybacks.
- Burn: the `bought` account's whole balance, after checking the swap delivered at least the minimum.

What this protects, and what it does not: in the constant-product model with the pool's constant fee
charged on both legs and no rebates, a single sandwich around one buyback loses money, because the buyback
moves the price by about twice its share of the reserve (at most 0.4% of a 1% pool) and a round trip costs
the attacker about 2%. Gate 20 measures it on the live Meteora binaries at six front-run sizes (from a tenth
of a chunk to twice the pool's SOL side): every one lost. This is not a general claim of resistance to every
form of MEV, and it does not mean the buyback pays a fair external price: it pays the pool's price at the time.

## Accounting (`/api/burn`)

One RPC read returns the program state, the reserve, the $COMETAIL mint and the pool at one slot
(`observedSlot`), so the conservation figure never mixes snapshots.

| Quantity | Meaning | Source |
|---|---|---|
| `totals.splitLamports` | everything the program split (claims plus carried inbox funds) | the program's counter (exact, at `observedSlot`) |
| `totals.toReserveLamports`, `totals.toOtherLamports` | the two halves (other = treasury for program claims, the signer for owner claims) | the program's counters (exact) |
| `provenance.claimedByProgramLamports`, `claimedByOwnersLamports`, `carriedLamports` | what claims paid, by program configs and by owners, and what was carried | the indexed `ClaimSplit` events; null unless the indexed history reconciles exactly with the counters of the same snapshot (`history.reconciled`: every split's halves sum to the split counter, every burn to the burn counter and count) |
| `sentDirectLamports` | everything that reached the reserve outside the program's splits (direct transfers from the owner or anyone) | reserve + spent − to-reserve, from the one read (exact: the reserve's only exit is a buyback) |
| `reserve.lamports`, `cometail.supplyRaw` | waiting to buy; supply now | the one read (exact) |
| `totals.spentLamports`, `totals.burnedRaw`, `totals.buybacks` | spent, burned, count | the program's counters (exact) |
| `burns` + `burnsTotal`, `splits` + `splitsTotal` | the newest 50 of each with signatures; `/api/burn/burns` and `/api/burn/splits` page through all of them by cursor | the indexed events, listed separately per kind |
| `commitment.tailsShareLamports` | the tails' 1/5 share received by the treasury, as of `tailsShareAsOfMs` | the vaults' own counters, as last indexed |
| `commitment.olderConfigClaimsLamports` | older-config claims made outside the program | null: not known here |
| `claimableNow` | partner trading fees waiting in pools now | Fee Index snapshot; graduated-position fees not included |

The burn index keeps its own cursor (head, the open cycle's top and tail, its target): a cycle walks down from
the newest transaction to the last completed head and only then moves the head, so a restart, a cap or downtime
of any length never skips a transaction; an unreadable transaction (missing, without its logs, or with truncated
logs) stops the pass and is retried. Burn events live in their own table.

## Limits and risks

- The owner keeps the upgrade authority through a review period. Until it is removed, "no withdrawal" is a
  property of the current code: an upgrade could change it. Removing it is the owner's decision, for this
  program only (the vault program keeps its authority).
- If the pinned pool ever stopped working (Meteora changes it, or its liquidity leaves), buybacks stop and the
  reserve waits; after the authority is removed, SOL in the reserve could be stranded for good.
- Meteora's programs are upgradeable by Meteora, and an operator can change a pool's fee settings; the program
  then refuses to buy rather than buy on changed terms.
- The 50% on the older configs and the tails' share depends on the owner's transfers; the site shows what was
  sent, and leaves unknown what it cannot see.

## Cutover (each mainnet step only with the owner's go)

1. Deploy the program from the verifiable build with a program-data account the size of the binary; hand the
   upgrade authority to the owner's wallet.
2. The owner signs `setup` on `/admin/burn` (the page checks the pool first).
   Verification of the burn program is a separate, pending step: `/admin/verify` is the vault's page and stays as
   it is. After the deploy: re-add the build user to the docker group, rebuild in the verifiable image at the
   deployed commit (`--library-name cometail_burn --base-image solanafoundation/solana-verifiable-build:3.1.10
   --cargo-build-sbf-args="--tools-version v1.57"`), compare its hash with the deployed program, then build and
   review a burn-specific verification page (the record's arguments name this program, its library, the commit and
   the deploy slot) for the owner to sign, and submit the public rebuild job. Until then the program is reported as
   not verified.
3. Create the four new configs (`tests/mainnet/burn-configs.ts`, dry run first): each is byte-identical to today's
   preset except the fee claimer, checked before and after.
4. Worker: add the new configs to `COMETAIL_BURN_CONFIGS`, `COMETAIL_MIGRATE_CONFIGS` and `COMETAIL_SKY_CONFIGS`
   (keeper and indexer), restart both. The keeper must migrate the new configs' curves before any launch uses them.
5. Site: point `NEXT_PUBLIC_PLAIN_CONFIG`, `NEXT_PUBLIC_LONG_CONFIG`, `NEXT_PUBLIC_FLAT_CONFIG`,
   `NEXT_PUBLIC_EXP_CONFIG` at the new configs; list today's in `NEXT_PUBLIC_LEGACY_CONFIGS`
   (`label=address,…`) so `/admin/fees` keeps claiming them; set `NEXT_PUBLIC_COMETAIL_POOL`; deploy.
6. Read `/api/burn` and the home page: status live, coverage complete.

## Tests

- Gate 20 (`tests/gates/20-burn.test.ts`, live Meteora binaries on LiteSVM): setup authority and pool rules;
  new configs byte-identical except the claimer; the same launch and curve state on both configs; every claim
  split exactly; migration with the claimer as fee claimer; buyback amount, burn, caller payout (none),
  cooldown, minimum, changed pool refused; the sandwich losses; no withdrawal path, pinned outputs.
- Devnet end-to-end (`tests/devnet/e2e-burn.ts`) through the real keeper and indexer modules.
