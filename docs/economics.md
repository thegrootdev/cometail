# Economics

The protocol takes at least 20% of every revenue line it controls. Order fees earned by
the vault's own bids are the one exception, on purpose: they are a rebate on bids funded
from income the protocol already took its 20% of at harvest, so taxing them again would
cut the same money twice.

## Configs

Four DBC partner configs. Common to all: WSOL quote, fees collected in quote, a flat 1%
curve fee, creator 75% of the fee after Meteora's 20% (so the protocol's partner share is
25%, which is 20% of the whole fee), migration into a compounding DAMM v2 pool (1% fee,
half of LP fees reinvested), liquidity 80% creator / 20% protocol, both permanently locked,
immutable metadata, a fixed supply of 1,000,000,000 with 6 decimals, initial market cap
20 SOL, migration market cap 120 SOL.

| Config | Migration fee | To the creator | Creation fee | Raise |
|---|---|---|---|---|
| stream-25 | 25% | 100% | 0 | 37.5 SOL |
| stream-50 | 50% | 100% | 0 | 40.7 SOL |
| stream-75 | 75% | 100% | 0 | 44.5 SOL |
| plain | 0 | 0 | 0.01 SOL | 34.8 SOL |

## Per 1 SOL of each revenue line

| Line | Meteora | Protocol | Depositor / creator | Buybacks | Stays in pool |
|---|---|---|---|---|---|
| Stream token, curve fee | 0.20 | 0.20 | 0.32 | 0.28 | |
| Stream token, graduated pool fee | 0.20 | 0.08 | 0.16 | 0.16 | 0.40 |
| Income from deposited streams | taken upstream | 0.20 | 0 | 0.80 | |
| Stream token cash-out | 0.2% of migrated liquidity | 0 | 25 / 50 / 75% of the raise | | the rest, locked |
| Plain launch, curve fee | 0.20 | 0.20 | 0.60 | | |
| Plain launch, graduated pool fee | 0.20 | 0.08 | 0.32 | | 0.40 |
| Plain launch, creation fee (0.01 SOL) | 0.001 | 0.009 | | | |
| DLMM order fees on vault bids | per DLMM | 0 | 0 | all | |

The protocol's 0.08 on graduated pools is its 20% of the claimable LP fees, which is 10% of
the fee after Meteora and 8% of the gross fee.

## Per preset, with the raise fully filled

| Preset | Raise | Depositor cash-out | Protocol cash-out | Locked liquidity (quote, before Meteora's 0.2% migration fee) | Vault position | Protocol position |
|---|---|---|---|---|---|---|
| stream-25 | 37.506 SOL | 9.376 SOL (25%) | 0 | 28.129 SOL | 22.504 SOL | 5.626 SOL |
| stream-50 | 40.685 SOL | 20.343 SOL (50%) | 0 | 20.343 SOL | 16.274 SOL | 4.069 SOL |
| stream-75 | 44.453 SOL | 33.340 SOL (75%) | 0 | 11.113 SOL | 8.891 SOL | 2.223 SOL |
| plain | 34.788 SOL | 0 | 0 | 34.788 SOL | creator 27.830 SOL | 6.958 SOL |

Cash-out is the preset's percentage of the raise minus less than one lamport of rounding.
Swaps stop at the migration price, but DBC accounts for any quote reserve excess above
the threshold as surplus. Zero surplus is not an eligibility condition for external pools;
the vault's one-time harvest path handles their creator surplus.

The vault-internal splits (8/15, 1/2, 1/5) are constants in the program, not settings.
The protocol's partner shares are claimed by the protocol owner's wallet directly through
DBC and DAMM v2 and never pass through the vault program.
