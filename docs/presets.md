# Launch presets, for any launchpad

COMETAIL's presets are Meteora Dynamic Bonding Curve configs owned by the protocol. A launch
from any of them is a DBC pool like any other: the config fixes the curve, the fees, the
migration and the fee claimer, and DBC applies them on every swap and at graduation whoever
created the pool. Launchpads and tools may create pools on these configs with the DBC SDK;
the protocol's partner share flows to COMETAIL's fee claimer by the program's own rules, and
the creator's share flows to the pool creator, with no agreement needed.

```ts
import { DynamicBondingCurveClient } from "@meteora-ag/dynamic-bonding-curve-sdk";
const client = DynamicBondingCurveClient.create(connection, "confirmed");
const tx = await client.creator.createPool({ config: PRESET_CONFIG, baseMint, name, symbol, uri, payer, poolCreator });
```

Common to every preset: fees collected in the quote token, a 1 % flat curve fee, creator 75 %
of the after-Meteora curve fee (partner 25 %), DAMM v2 migration with the customizable fee
option (compounding pool at 1 % fee with half of the LP fees reinvested), LP 80 % creator and
20 % partner, both permanently locked, immutable metadata, a fixed supply of 1,000,000,000
with 6 decimals, a 0.01 SOL creation fee (90 % to the partner, 10 % to Meteora). The stream
presets (25, 50, 75) are for the vault program only; the plain presets are the public ones.

| Preset | Quote | Curve | Initial cap | Migration cap | Raise to graduate (R) | File |
|---|---|---|---|---|---|---|
| Standard | WSOL | market caps, one segment | 20 SOL | 120 SOL | 34.788 SOL | `configs/plain.json` |
| Long | WSOL | 16 segments, weights 1.3^i | 20 SOL | 360 SOL | 122.709 SOL | `configs/long.json` |
| Flat | WSOL | 16 segments, 12 x 8 then 4 x 1 (liquidity in the lower band) | 60 SOL | 120 SOL | 47.601 SOL | `configs/flat.json` |
| Exponential | WSOL | 16 segments, weights 1.3^-i (gentle first, steep late) | 20 SOL | 240 SOL | 30.675 SOL | `configs/exp.json` |
| Stock, USDC | USDC (6 dp) | market caps, one segment | 2,000 USDC | 12,000 USDC | 3,478.78 USDC | `configs/stock-usdc.json` |
| Stock, tokenized stock | a badged Token-2022 stock mint (8 dp) | 16 segments, weights 1.2^i (more depth near graduation; sharper early price movement) | 2 units | 16 units | 5.667 units | `configs/stock-xstock.json` |

What each means for a creator: Standard graduates at a 120 SOL market cap after a 34.8 SOL
raise; Long stretches price discovery three and a half times further before graduating; Flat
keeps the price near its start for most of the raise, a fair launch, and graduates at the
same 120 SOL cap; Exponential climbs gently then steeply and graduates on a smaller raise
with the configured end price about twelve times the start; the USDC
preset is the standard shape in dollars. The stock preset is tuned for thinly traded or
newly tokenized names: the smaller raise asks buyers for fewer quote units (5.667 to
graduate, down from 6.958), while rising liquidity weights put more depth near graduation.
Early buys move the price more than later buys of the same quote amount. Prices meet at
segment boundaries, but a large trade can still move the price sharply. The curve does not
remove the quote token’s own volatility, spread or limited liquidity.
After graduation every preset leaves 80 % of the liquidity permanently locked in the
creator's position, earning the creator the pool's fees for as long as it trades.

Quote mints: the WSOL presets are permissionless. A USDC quote is permissionless (SPL Token).
A tokenized stock quote is a Token-2022 mint with extensions beyond metadata, so it needs a
DBC token badge created by a Meteora operator; the mainnet stock tokens already carry one,
and the config passes the badge as remaining account 0. Graduation of a badged quote goes
through DAMM v2 configs that carry `CreatePoolWithoutMintValidation`.

## Addresses
Devnet (owner: the devnet test authority; the two quote stand-ins are devnet mints, a 6 dp SPL
mint and a Token-2022 mint with the MetadataPointer extension):

| Preset | Config | Quote mint |
|---|---|---|
| Standard (plain) | `9utyJkkrmQnzdDJjLWQJRN2DocYkTobdwg7eveWmJ4Qj` | WSOL |
| Long | `8cUQqkMkb7pU5LXdEBVtDgQoyAa77n388DGp7EfhBh6o` | WSOL |
| Flat | `8LtiCkfxkGzRkNLCQHc4ohudp3PxRNHbSCxHFkv5jin4` | WSOL |
| Exponential | `13mkYqFj1MU1DX8XP5VmnWpwjmdnqymxFsfeF3zKdNPf` | WSOL |
| Stock, USDC | `3SGJgHzALLPm15owz5Tw83SQdaBzd8AoSFyMZHy3NxBe` | `9YSXk1YcKXHcTodgu4MuvKdRu7kW64Af61cKERH2Wtcd` |
| Stock, tokenized stock | `AKQKx6QymFZ3A8y7QfBdNxnkdCFGMLVFBU1Dkpe9LQNa` | `BN6zukGJEUGDCBgjYJxyDNs7KubMKeJVjS6RyfNBcXAN` |

Mainnet: created by the protocol owner on the day (docs/mainnet-runbook.md); addresses land in
`configs/mainnet.json` and here.

Every preset's on-chain parameters are read back and compared with its file, field by field
(quote mint and decimals, threshold, curve segments, fees, liquidity split, migration
settings, the stock badge), by `tests/mainnet/verify-configs.ts` with `CLUSTER=devnet` or
`CLUSTER=mainnet`.
