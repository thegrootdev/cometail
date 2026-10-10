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
with 6 decimals. The six public presets charge a 0.01 SOL creation fee (90 % to the partner,
10 % to Meteora). The stream presets (25, 50, 75) charge no creation fee and are the vault
program's designated presets; DBC itself permits other creators to launch on those configs.

| Preset | Quote | Curve | Initial cap | Migration cap | Raise to graduate (R) | File |
|---|---|---|---|---|---|---|
| Standard | WSOL | market caps, one segment | 20 SOL | 120 SOL | 34.788 SOL | `configs/plain.json` |
| Long | WSOL | 16 segments, weights 1.3^i | 20 SOL | 360 SOL | 122.709 SOL | `configs/long.json` |
| Flat | WSOL | 16 segments, 12 x 8 then 4 x 1 (liquidity in the lower band) | 60 SOL | 120 SOL | 47.601 SOL | `configs/flat.json` |
| Exponential | WSOL | 16 segments, weights 1.3^-i (gentle first, steep late) | 20 SOL | 240 SOL | 30.675 SOL | `configs/exp.json` |
| Stock, USDC | USDC (6 dp) | market caps, one segment | 2,000 USDC | 12,000 USDC | 3,478.78 USDC | `configs/stock-usdc.json` |
| Stock, tokenized stock | NVIDIA xStock (NVDAx, `Xsc9qvGR…`, badged Token-2022, 8 dp) on mainnet; a stand-in mint on devnet | 16 segments, weights 1.2^i (more depth near graduation; sharper early price movement) | 2 units | 16 units | 5.667 units | `configs/stock-xstock.json` |
| Paired with $COMETAIL | $COMETAIL (`z4Zr7w…`, classic SPL, 6 dp) on mainnet; the burn program's stand-in on devnet | market caps, one segment | 75,000,000 $COMETAIL | 450,000,000 $COMETAIL | 130,454,076.85 $COMETAIL | `configs/paired.json` |

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

Mainnet: created by the protocol owner; the addresses are in `configs/mainnet.json` and in the
README's address table.

Every preset's on-chain parameters are read back and compared with its file, field by field
(quote mint and decimals, threshold, curve segments, fees, liquidity split, migration
settings, the stock badge), by `tests/mainnet/verify-configs.ts` with `CLUSTER=devnet` or
`CLUSTER=mainnet`.

## Paired with $COMETAIL

The seventh preset quotes the coin in $COMETAIL instead of SOL (`configs/paired.json`: the USDC preset's
economics, with the market caps in $COMETAIL). Buyers still pay with SOL. The site builds one transaction
with two swaps (`web/src/lib/paired.ts`):

- **Buy:** an exact-out swap on $COMETAIL's own DAMM v2 pool (the pool the burn program pinned, `GjpM…qG7T`)
  buys exactly the $COMETAIL the coin leg spends, for at most its quoted SOL cost plus 1% (and never more than
  the SOL typed), then that $COMETAIL buys the coin on its curve or, after graduation, on its coin/$COMETAIL pool. A buy that completes the curve buys only
  what the curve still takes (fee included). Nothing is left in $COMETAIL, unless another buy lands first: one that
  costs this buy more than 1% of its coins makes it fail whole; a smaller one lets it land with the curve taking a
  little less, and that part stays in the wallet as $COMETAIL (the site says so on buys close to completion).
- **Sell:** the coin is sold for $COMETAIL; with "SOL" chosen, the guaranteed minimum of that $COMETAIL is
  sold for SOL in the same transaction, so the slippage margin (at most 1%) stays in the wallet as
  $COMETAIL. With "$COMETAIL" chosen, the seller keeps it.
- Each leg has its own 1% bound; if either moves past it, the whole transaction fails and nothing happens.
- A launch with a first buy paid in SOL takes two transactions (one would be 1,262 bytes, over the
  1,232-byte limit): the first buys exactly the $COMETAIL, the second creates the coin with that first buy.

At graduation the raise goes into a coin/$COMETAIL DAMM v2 pool (compounding, 1%, all liquidity permanently
locked, fees in $COMETAIL). Creators earn their 75% of the curve fee in $COMETAIL. The protocol's share also
arrives in $COMETAIL; its fee claimer is the launch treasury, which claims on `/admin/fees`. Each claim pays into a
fresh token account created in the same transaction; exactly half of the amount the claim was built for is burned
from it, the other half goes to the treasury's $COMETAIL account, and the fresh account is closed (the only token
account `/admin/fees` lets a transaction close: created by that transaction, closed to the claimer as its last
instruction; any other close is refused before the wallet opens). The chain enforces
the split: a claim that pays any other amount (a stale scan, a claim already made, fees that arrived since) fails as a
whole, so nothing already in the treasury can be burned. A curve fee claim is built for the scanned amount; a
graduated position's fees and a curve's surplus for what a simulation of the claim pays at that moment.

Sizing: 75,000,000 to 450,000,000 $COMETAIL is about 10 to 61 SOL at the $COMETAIL price of 10 October
2026 (1.36e-7 SOL). Prices and market caps are shown in SOL and dollars at $COMETAIL's current pool price,
so a paired coin's SOL value also moves with $COMETAIL. $COMETAIL's pool held about 54 SOL that day: a
graduation reached entirely through SOL buys would buy 130M $COMETAIL from it, about a third of its
$COMETAIL side, and raise $COMETAIL's price roughly 2.2 times along the way.

### Where paired coins show up (checked 10 October 2026)

- **On cometail.fun** the site builds both swaps itself, so a paired coin can be bought and sold with SOL whenever
  $COMETAIL's pool and the coin's curve or pool can take the trade within the 1% bounds.
- **Graduation is ours to run.** Meteora's migration keepers only graduate curves quoted in SOL, USDC, TRUMP, JUP,
  USD1, MET, JupUSD, VIRTUAL, stock tokens, or a Jupiter-verified token with an Organic Score above 50
  (docs.meteora.ag, DBC migration and liquidity). $COMETAIL is none of these, so the paired config is in the
  keeper's migrate list (`COMETAIL_MIGRATE_CONFIGS`); the devnet run graduated a paired coin that way.
- **Jupiter** routes SOL to coins quoted in small tokens through the quote token, but not always: on the free quote
  API, 55 of 97 recent custom-quote DBC coins routed and 31 were refused at the multi-hop step, while jup.ag routed
  each one tried. Whether it accepts $COMETAIL as the middle hop cannot be known until a paired coin trades. Its
  market-listing rules also drop a curve that has not graduated 30 days after the token was created.
- **DexScreener** lists custom-quote curve pairs but shows no USD price or liquidity for them; after graduation it
  prices some custom-quote pools and not others. **GeckoTerminal** priced the ones it listed.
- **Axiom, Photon and BONKbot**: Meteora's DAMM v2 pool page offers no link to them for pools whose quote is not SOL
  ("For pools without SOL as the quote token, BONKbot, Photon, and Axiom won't be in the list"); whether those
  platforms list such pools themselves was not established.
  Nothing public was found either way for GMGN, BullX, Padre, Trojan, Maestro, Banana Gun or Birdeye.
