# How a vault works

Everything here runs on three Meteora programs: the Dynamic Bonding Curve (DBC) for
launches, DAMM v2 for graduated pools, DLMM for the buyback ladder. The vault program
owns nothing of its own except accounting; the assets are Meteora's accounts, held by a
program-derived address (the vault PDA) that signs through CPI.

## The two doors

**Launch a token.** A plain launch goes straight to DBC from the browser with one of my
partner configs. No vault involved. On the curve the creator gets 75% of the fee after
Meteora's 20% (60% of the gross fee). If the curve completes, the creator ends up with 80%
of the graduated pool's liquidity, permanently locked: 80% of the claimable LP fees, which
is 32% of the gross pool fee while half of the LP fees compound. Those creator rights and
that locked position are a fee stream for as long as the token trades: a tail.

**Sell your tail.** A creator with an eligible DBC pool or DAMM v2 position (from here or
from another DBC launchpad, if it meets the eligibility rules below) deposits it into a
vault and launches the stream token.

## One vault, start to finish

1. **Open.** The depositor creates a vault and deposits streams. DBC creator rights move
   with DBC's own `transfer_pool_creator` (the vault PDA becomes the pool creator).
   Position NFTs move with a plain token transfer into a vault-owned account. Everything is
   checked against the real accounts: WSOL-quoted, fees collected in quote, permanently
   locked liquidity only, no delegates, no freeze authority, no transfer hooks. Until the
   vault launches, the depositor can take everything back, fees still attached.
2. **Launch.** The vault launches the stream token on DBC with the vault PDA as pool
   creator, from one of three fixed presets (25 / 50 / 75% cash-out). The preset fixes the
   raise and the curve. From the first trade, 75% of the curve fee after Meteora's cut
   accrues to the vault.
3. **Graduation.** DBC migration is permissionless; the keeper does it when Meteora's
   keepers don't. The migration fee (25 / 50 / 75% of the raise) is the depositor's
   cash-out, paid straight to their wallet. The rest becomes permanently locked liquidity
   in a compounding DAMM v2 pool: 80% in a position the vault owns, 20% in the protocol's.
4. **Harvest.** Anyone can trigger a harvest. The vault claims its DBC creator fees and
   its DAMM v2 position fees into pinned vault accounts and splits the new income in the
   same instruction: own-curve fees 8/15 to the depositor, own-position fees 1/2 to the
   depositor, income from deposited external streams 1/5 to the protocol. The rest is bid
   money.
5. **Route.** The keeper turns bid money into DLMM limit orders below the stream token's
   price, inside on-chain bounds: buying side only, a price cap the depositor committed to,
   a spending budget per period, a cap on resting orders.
6. **Settle.** When bids fill, anyone can settle them: the order is cancelled (that's how
   DLMM pays out), the stream tokens received are burned in the same transaction, and
   unfilled WSOL goes back to bid money.

## What the stream token is, exactly

Realized fees fund finite standing buy orders at public limit prices. Holders have no
redemption claim and no guaranteed price floor. Orders can exhaust; fee income and market
prices can fall. Burning reduces supply but does not guarantee appreciation. Bid placement
is exposed to manipulation and adverse selection. The vault is a disclosed, rule-bound
buyback mechanism, not a redeemable claim on income. If the stream token never graduates,
the launch is still final: no cash-out, no ladder, but the vault keeps harvesting.

## Accounts

- `Protocol`: admin, keeper, treasury, the three stream configs, a routing pause flag.
- `Vault`: depositor and their payout account, status (Open, Launched, Live), the stream
  token's DBC pool and derived DAMM v2 pool, the DLMM pair and its orientation, the
  vault's own position, the income and placeholder WSOL accounts, routing policy and
  state, accounting totals, and two counters: `stream_count` (the next stream's index,
  never decremented) and `active_streams` (streams currently open; withdrawals take them
  back and a launch needs at least one).
- `Stream`: one per deposited DBC right or position, plus the vault's own pool and
  position marked `is_own` (set only by the program, never by a client).
- `StreamIndex`: one per source account (a DBC pool, a position), so nothing can be
  deposited twice; a creator position that comes in with DBC rights has its own, and a
  withdrawal closes every index the stream owns so the sources can enter a vault again.
- `OrderRecord`: one per resting DLMM order, closed only when the order account closes.

## Instructions

`init_protocol`, `update_protocol`, `create_vault`, `deposit_dbc_rights` (open curve),
`deposit_dbc_rights_migrated` (graduated curve, with its creator position),
`register_stream_position`, `deposit_position`, `deposit_position_split`,
`withdraw_stream`, `launch`, `register_pair`, `register_own_position`, `cashout`,
`harvest_dbc`, `harvest_position`, `harvest_one_time`, `route`, `settle`. There is no swap
instruction and no instruction with a free destination.

The chain records no role for a migrated position, so the program admits a migrated creator
position by canonical custody, principal eligibility and exact size rules against the
current permanently locked total of the pool: its NFT sits in DAMM v2's own account for
that NFT, owned by the vault with no delegate; it carries only permanently locked liquidity;
and it holds at least half of the total when the creator's configured share exceeds the
partner's, or at least half of the creator's share otherwise, and never more than nine
eighths of the creator's share. The nine-eighths upper bound applies only to external
positions; own positions require only the lower half-share bound. These rules admit
positions of a specified current size;
they do not establish creator or partner identity or migration provenance. At the initial
migration shares the smaller partner position is excluded, and the larger one is excluded
when it is more than an eighth larger than the creator's; later permanent locks change the
thresholds. The vault page reports the registered position's actual share. Depositors hand
the account to the vault with a Token-2022 SetAuthority; a withdrawal hands it back. Bin prices
use DLMM's own integer power, ported step for step; settlement reads each bin's fill state
before cancelling, so refunded principal and fee share are exact. Harvests pass each mint's own token program, so Token-2022 bases
work; `register_pair` is signed by the keeper or the depositor and refuses pairs whose base
fee is above 1%; `create_vault` refuses a price cap that no approved bin step can represent.
