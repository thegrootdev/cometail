# The read API and the feed

Base URL: `https://api.cometail.fun`. Every route is `GET`, answers JSON, allows the site's
origin only through CORS, and is rate limited per client address. Nothing here is an input to a
transaction: the site and the SDK read the chain for anything they sign.

## Envelope (token routes)
```
{ schemaVersion: 1, cluster: "devnet" | "mainnet-beta", generatedAtMs, observedSlot,
  coverage: { status: "complete" | "partial" | "stale", pendingPools, lastSuccessfulAtMs },
  solUsd: { value, source, observedAtMs, status: "fresh" | "stale" | "missing", valuationBasis: "reference" | "market" } | null,
  data: ... }
```
`coverage` says whether the trade index is caught up (`partial` while pools catch up, `stale`
when no successful scan has been recorded yet; `lastSuccessfulAtMs` carries the age, the
worker does not judge it). `solUsd` is the SOL reference every SOL-quoted USD
figure uses; it is `null` when no source has ever answered, `stale` past ten minutes, and its
`valuationBasis` is `market` on mainnet and `reference` elsewhere. Amounts are strings of
exact base units (lamports, token raw units). Derived numbers are display values: execution
prices are truncated to 12 decimal places; `fdvUsd` is computed from the rounded price, the
whole-token supply and a rate rounded to cents, and printed with 2 places.

## Routes
| Route | Answer |
|---|---|
| `/api/health` | `{ ok, service, time }` |
| `/api/sky?limit=` (max 1000) | `{ streams: [...] }`: every stream the Sky scan found: `pool`, `config`, `baseMint`, `creator`, `owner`, `custody`, `progress`, `eligible`, `reasons`, `creatorPct`, `partnerPct`, `claimableLamports`, `kind` (`position` or absent for creator rights), `token` (identity: `mint`, `name`, `symbol`, `imageUrl`, `stage`, `links`). The tail estimate is labelled an estimate. |
| `/api/vaults?limit=` | `{ vaults: [{ vault, data, updatedAt, stToken }] }`: `data` is the decoded Vault account plus `live` (ladder, position shares) and `reconciliation` (accounting against indexed events). |
| `/api/vaults/<vault>?limit=` | the vault, `stToken`, `streams: [{ stream, data, token }]`, `events`, `trades`. |
| `/api/events?vault=&limit=` | program events, newest first: `signature`, `idx`, `slot`, `blockTime`, `vault`, `name`, `data`. Names: vaultCreated, streamDeposited, streamPositionRegistered, streamWithdrawn, launched, pairRegistered, live, cashedOut, harvested, oneTimeHarvested, routed, settled, unwound. |
| `/api/tokens?sort=volume24h|newest&stage=all|bonding|graduated&q=&cursor=&limit=` (max 100) | `{ tokens: [{ identity, market, volume24h, holders, bonding, updatedAtMs }], total, nextCursor, sort, stage }` |
| `/api/tokens/<mint>` | `identity` (mint, decimals, name, symbol, imageUrl, metadataUri, metadataStatus, creator, custody, createdAtMs, dbcPool, dammPool, quoteMint, tokenKind, config, vault, stage, links), `market` (`priceQuote` in quote units per whole token, `quoteMint`, `quoteDecimals`, `quoteUsd` { value, source, status }, `priceSol` only when the quote is WSOL, priceSource `curve` or `damm`, totalSupplyRaw, fdvUsd from the quote rate, marketCapUsd null by definition, valuationBasis, liquidityLamports in quote base units, liquidityBasis), `volume24h` (lamports in quote base units, buys, sells, window, complete), `holders` (count, definition, status), `bonding` (progress). 404 while a fresh launch is not indexed yet. |
| `/api/tokens/<mint>/trades?cursor=&limit=` | `{ trades: [...], nextCursor }`: `signature`, `ordinal`, `slot`, `blockTimeSec`, `pool`, `venue` (`curve` or `damm`), `side`, `baseAmountRaw`, `quoteAmountLamports` (quote base units), `executionPriceQuote`, `quoteMint`, `quoteDecimals`, `executionPriceSol` (WSOL quotes only), `trader`, `traderKind`. Cursor `slot:ordinal:signature`. |
| `/api/prices` | `{ solUsd, source, at }` (Jupiter, CoinGecko fallback, 60 s cache). After a source outage the last cached value is served with its old `at`; 503 only when no value was ever fetched. Consumers check `at`, or the envelope's `solUsd.status`, before treating a rate as fresh. |
| `/api/metrics` | protocol totals, computed at most every 30 s: independent, demo and unattributed classes, recurring and one-time harvests, buyers of vault stream tokens. Launch counts cover every quote; `plainLaunches.tradingFeeLamports` and `volumeEstimateLamports` cover WSOL-quoted launches only, and `plainLaunches.byQuote[<mint>]` carries the other quotes' raw totals. |

Every number comes from the chain or from the indexer's own observation of it; a value the
worker estimates says so in its field name or a `basis`/`status` sibling.

## The Fee Index
Every SOL-paired Meteora DBC coin from any launchpad that has paid its creator, with what the
creator earns on the curve. Public and read-only: any origin, the same per-client rate limit
as every route (120 requests a minute, burst 60), `cache-control: public, max-age=30`. Every
answer carries `{ schemaVersion: 1, cluster, generatedAtMs, coverage }`, where `coverage` is
`{ mode: "all-dbc", pools, configs, fullSlot, deltaSlot, fullAtMs, deltaAtMs, fullEveryHours, deltaEveryMinutes, historySinceMs, fullDayOfHistory, claims }`
(`claims` counts claim lookups by status: pending, confirmed, partial, unconfirmed). Answers holding an
estimate carry `basis`: what each `...EstimateLamports` field means.

| Route | Answer |
|---|---|
| `/api/fees/status` | the envelope alone |
| `/api/fees/coins?sort=day\|claimable\|lifetime\|avg&stage=all\|bonding\|graduated&eligible=1&creator=&q=&limit=&offset=` (limit max 200) | `{ basis, coins, offset, limit }`, each coin `{ mint, pool, config, creator, launchpad, ours, name, symbol, imageUrl, stage, creatorFeePct, creatorLifetimeEstimateLamports, lifetimeExact, creatorClaimedAtMostLamports, noneClaimed, creatorLast24hEstimateLamports, last24hWindowHours, creatorAvgPerDayEstimateLamports, claimableLamports, launchedAtMs, configAllowsTail, reasons, changedAtMs }`. Every sort is global, before the page, with the pool as tiebreaker. |
| `/api/fees/coins/<mint>` | `{ basis, coin }`, or 404 when the coin is not SOL-paired or has not paid its creator |
| `/api/fees/launchpads` | `{ rankedBy, historySinceMs, basis, launchpads, ourConfigs }`: fee claimers, top 200 plus the protocol's own wherever they rank, each `{ rank, launchpad, ours, coins, configs, graduated, tailEligibleCoins, creatorLifetimeEstimateLamports, creatorLast24hEstimateLamports, coinsWithShorterWindow, claimableLamports, creatorFeePct }`. `rankedBy` is `last24h` once the index holds a full day of history, `lifetime` before. `ourConfigs` lists the protocol's configs; a non-SOL one is `{ config, covered: false, note }` |
| `/api/tails?limit=&offset=&source=<mint>` (limit max 100) | `{ total, offset, limit, tails }`: every vault's tail, newest first, each `{ vault, status, stMint, name, symbol, imageUrl, decimals, sources: [{ stream, kind, pool, mint, name, symbol, imageUrl }], raise: { raisedLamports, targetLamports, progressBps, stage } \| null, feesIn: { lifetimeLamports, last24hLamports }, bids: { placedLamports, refundedLamports, restingLamports, filledLamports }, burnedStRaw, unwindOpensAtSec }`. `source` keeps the vaults holding that coin's fees, on any launchpad's config. A value that could not be read is null, never zero. |
| `/api/burn` | The $COMETAIL buyback and burn (`docs/burn.md`): `{ program, claimer, sharePct, status: "live" \| "not-set-up" \| "unavailable", observedSlot, coverage, setup, totals: { splitLamports, toReserveLamports, toOtherLamports, spentLamports, burnedRaw, buybacks, lastBuyAtSec }, provenance: { claimedByProgramLamports, claimedByOwnersLamports, carriedLamports }, reserve, sentDirectLamports, nextBuyback, cometail: { mint, supplyRaw, decimals }, claimableNow, commitment: { tailsShareLamports, tailsShareAsOfMs, olderConfigClaimsLamports }, burns, burnsTotal, burnsNextCursor, splits, splitsTotal, splitsNextCursor }`. State, reserve, mint and pool come from one read; provenance is null until the history is complete; null is unknown, never zero. Any origin, cached 15 seconds. |
| `/api/burn/burns?before=&limit=`, `/api/burn/splits?before=&limit=` (limit max 100) | `{ kind, total, items, nextCursor, coverage }`: every burn or split, newest first; `before` is the previous page's `nextCursor` (`slot:idx:signature`). |
| `/api/tail-claims`, `/api/tail-claims/:mint` | Tails launched from the owner's wallet (`docs/architecture.md`, Tails): `{ tails }` or `{ tail }` (404 when the mint is not a configured tail), each `{ mint, config, curve, targetPool, creators, graduatedPool, positions, totals: { claims, notSplit, madeUp, claimedLamports, toBurnLamports, boughtRaw, liquidityLamports, liquidityRaw, lockedLiquidity, payoutLamports }, claims, payouts, makeUps, coverage: { claims, reserve, reserveVerified } }`. Every creator claim, split or not, newest first: `{ signature, slot, blockTime, source: "curve" \| "pool", status: "split" \| "unsplit" \| "incomplete" \| "ambiguous", claimedLamports, keptLamports, toBurnLamports, burn: { spentLamports, waitingLamports, boughtRaw, buybacks } \| null, liquidity, makeUp }`; `makeUp` is the one-time make-up that counts for a claim that was not split (`{ signature, toBurnLamports, burn, liquidity }`, `docs/architecture.md` Tails) or null, and `makeUps` lists every make-up transaction found, `counted` or not; `totals.madeUp` counts made-up claims, which `notSplit` leaves out. `burn` traces the claim's SOL through the reserve's gross, balance-linked ledger, first in, first out, to the buybacks that spent it; it is null whenever that is not proven. Totals are null until the history they sum is complete. Any origin, cached 15 seconds. |

How the numbers are made:
- `claimableLamports` (exact): the pool's unclaimed creator fee (`creatorQuoteFee`), now: what a creator claim pays. Checked on mainnet for TBI (6qoh...dBLV): a simulated claim moved exactly this amount out of the pool's quote vault.
- `creatorLifetimeEstimateLamports` (an estimate, an upper bound): the pool's lifetime trading-fee counter (`metrics.totalTradingQuoteFee`, after Meteora's protocol share) times the config's creator trading-fee percentage. The program rounds the creator share down on every swap, so the true total can be lower by under a lamport per swap; `lifetimeExact` is true at a 0% or 100% share, where there is no rounding. Curve fees only.
- `creatorClaimedAtMostLamports`: an upper bound of what the creator already claimed, the lifetime figure minus `claimableLamports` (exact when `lifetimeExact`). `noneClaimed` is true only when the two are equal, which proves no claim was made; a small gap is not read as "none" (Meteora allows partial claims) nor as a claim (it may be rounding). TBI (6qoh...dBLV): lifetime 247.122074391, claimable 247.122074291, so at most 100 lamports were ever claimed.
- `imageUrl`: the https logo named by the coin's metadata file, read in the background (top earners first) and on demand for the rows an answer shows (2.5 seconds; whatever arrives later is in the next answer). A file or logo on IPFS (a /ipfs/ path, ipfs://, or a <cid>.ipfs. subdomain) whose host is in the stopped ipfs.io family is read through live public gateways; the logo is stored under the first gateway that serves it as an image. A logo on a host that still serves (a coin's own dedicated gateway) is kept as it is. Null until read, or when there is none.
- `creatorLast24hEstimateLamports` (an estimate): the counter's growth since the end of the hour 24 hours back, times the creator share. Hourly snapshots hold each hour's last observed value, and a pool absent from every walk in between did not change, so that base is the counter at that time. `last24hWindowHours` is 24, or less while the index holds less history for the coin (0: none yet).
- `creatorAvgPerDayEstimateLamports` (an estimate): the lifetime estimate over the days since activation (at least one).
- `configAllowsTail` and `reasons`: the config part of the program's deposit rules for creator rights (SOL quote, fees in SOL, DAMM v2 migration, creator liquidity permanently locked and nothing unlocked or vesting) and a stage the vault accepts (bonding or graduated). The deposit itself also checks the coin's mint (no freeze authority, metadata-only extensions).
- Tails `feesIn.last24hLamports` is the exact sum of every indexed harvest event of the last 24 hours. `bids.placedLamports` is cumulative SOL placed in buyback bids (re-placed bids count again); `filledLamports` = placed − refunded − still resting, null while the resting principal of open orders is unknown: the ladder must have been read completely (no unreadable order or bin) and hold as many order records as the vault counts outstanding.
- Not included: fees on the creator's locked DAMM v2 position after graduation, which are not in the DBC pool.

Coverage: a full walk of every SOL-quoted DBC config and every DBC pool once a day (paginated,
sliced `getProgramAccountsV2`: about one minute for the configs and four for the pools), and a
walk of only the pools changed since the last one every few minutes (`changedSinceSlot`; fifteen
minutes of changes is about a hundred pools in ten seconds). Configs are immutable and read once.
Names come from Metaplex metadata, or from the mint's own metadata extension for a Token-2022
coin: the protocol's own coins first, then the top earners, and on demand for any row an answer
shows. A coin with neither shows its mint.

Claims: between two walks a claimable fee should grow by its share of the counter's growth (the
partner's share is the rest). When it grew by less, beyond rounding (none without trading; with
trading, 1,000 lamports plus 0.5% of the expected growth), a claim happened, including one masked
by new trading. The pool's transactions from the previous walk's slot to the slot read after this
walk ended (up to 300 signatures) are read for the claim events, which become `claim` rows on the
feed with exact amounts. Whatever events were read are published at once (a retry never repeats a
row); the lookup finishes only when its whole window was read. Transactions not available yet keep
it pending (six tries); a window it could not read completely is `partial` when some of its claims
were found, `unconfirmed` when none were; a complete window without the event is `unconfirmed`. Claims smaller than the rounding tolerance while the
pool trades, and claims on pools the index does not keep, are not covered; the `claim` stream is
complete only for what it covers, never presented as every claim on Meteora.

## The feed
`wss://api.cometail.fun/api/feed` (one JSON text frame per event) and `GET /api/feed?since=<cursor>&limit=`
(replay, max 500; any origin may read it). Both take `types=<comma list>` to receive only some
event types; `types=fees` is the fee stream (`claim`, `harvest`, `bid`, `fill`, whose `burnedStRaw`
is the burn). Control frames always arrive. A filtered replay scans `limit` rows and returns the
matching ones: its `nextCursor` then names the last scanned row and may lie past the last returned
event, so an empty filtered page can still continue; it always advances beyond `since`. An unknown
type answers 400.
The SDK (`packages/sdk`) wraps both: `client.feed({ types: FEE_TYPES, onEvent })` and
`client.replayAll(since, undefined, FEE_TYPES)`; `packages/sdk/examples/fee-events.mjs` prints the
fee stream in a terminal and resumes from a cursor.

Frame: `{ schemaVersion: 1, cluster, type, cursor, observedSlot, generatedAtMs, provenance, data }`.
Replay is its own shape, not the token envelope: `{ schemaVersion, cluster, type: "replay",
generatedAtMs, events, nextCursor }`, `nextCursor` being the last returned event's cursor
when more remain, with no coverage, observedSlot or solUsd at the top.
`provenance` is `{ source: "chain" | "indexer" | "estimate", signature?, slot?, scannedAtMs? }`;
an estimate carries `basis` in `data`.

Types and `data`:
- `launch` { mint, name, symbol, imageUrl, creator, config, dbcPool, quoteMint, tokenKind, stage, createdAtMs } (an indexer observation: no signature)
- `trade` { mint, pool, venue, side, baseAmountRaw, quoteAmountLamports, executionPriceQuote, quoteMint, quoteDecimals, executionPriceSol (null unless the quote is WSOL), trader, traderKind, signature }
- `graduation` { mint, dbcPool, dammPool, quoteMint } (an indexer observation: no signature)
- `harvest` { vault, stream, incomeLamports, signature }
- `bid` { vault, order, bins (number), grossLamports, signature }
- `fill` { vault, order, burnedStRaw, unfilledLamports, signature }
- `cashout` { vault, depositorLamports, signature }
- `unwind` { vault, stMint, dbcPool, incomeReturned, launchedAt, unwoundAt, signature }
- `claim` { mint, pool, role (`creator` or `partner`), quoteAmountLamports, baseAmountRaw, signature }: a fee claimed on a DBC pool of any launchpad the Fee Index covers, from the claim event in the transaction (see "The Fee Index", Claims, for what is and is not covered)
- `vault` { vault, event, ...the event's fields, signature }: every other program event (vaultCreated, streamDeposited, streamPositionRegistered, streamWithdrawn, launched, pairRegistered, live), so a consumer that ignores unknown types loses nothing it asked for.

Token rows (`launch`, `graduation`) carry no transaction: their cursor's third part is the mint and the slot is the scan's observed slot (their identity is the type and the mint); `provenance.source` is `indexer`. Harvest rows carry `grossLamports`, `toDepositorLamports`, `toProtocolLamports` and `oneTime` next to `incomeLamports`.

Control frames: `hello` { cursor, retentionSlots }: first on a socket opened without `since`;
on a socket opened with `since` the backlog is replayed first and `hello` follows it, and its
head never advances a consumer's delivered cursor; `ping` { generatedAtMs } every 25 s; `coverage`
{ status, pendingPools, lastSuccessfulAtMs } whenever coverage changes; `gap` { oldest, resume }
when the requested `since` is older than retention: `resume` is the cursor to pass as `since` so
the oldest retained event is not skipped. A gap is explicit: a consumer reconciles before it
acknowledges anything past it. Replay answers an expired cursor with HTTP 410
`{ error: "cursor expired", oldest, resume }`. Retention: 1,512,000 slots, about seven days.

Cursors are `sequence:slot:signature`. The first part is the feed's publication sequence:
unique, strictly increasing in the order rows were published and shared by every type, so a
row the indexer discovers late (an older slot found on a later scan) still arrives after
everything delivered before it; the slot and the signature are information, never the
order. Compare cursors by the first part; `since` is exclusive. A row's identity is its type,
signature and ordinal, so a replayed or retried index never publishes a row twice. The
sequence never restarts below a value an earlier database generation issued (a rebuild
starts above the previous head and above the time in tenths of a second), and a cursor the
server does not know, older than retention or beyond its head, always gets the explicit
`gap` frame or the 410 `cursor unknown` answer with a `resume` cursor, never silence. When the
feed is empty the gap's `oldest` is null and `resume` is the reset cursor `0:0:~`, which the
server accepts before and after the first event.

## Non-SOL quotes
Every quote-denominated figure names its quote: `market.quoteMint` and `market.quoteDecimals`
on a token, `quoteMint` and `quoteDecimals` on a trade. `priceQuote` and `executionPriceQuote`
are quote units per whole token for any quote; `priceSol` and `executionPriceSol` are always
present and are `null` unless the quote is WSOL. `quoteUsd` is the USD rate of one quote unit: the SOL reference
for WSOL, 1 for a configured dollar stablecoin (`COMETAIL_USDC_MINTS`), otherwise
`{ value: null, status: "missing" }`, and then `fdvUsd` is null rather than guessed. The
`solUsd` envelope field stays for SOL-quoted figures.

Volume ranking uses fresh quote-to-USD references and exact integer quote volumes. Assets
without a usable rate follow in newest-first order. Token lists advertise
`volumeRanking: { basis: "quote-usd-v1", unrated: "newest" }` in `data`; clients should
keep cross-quote volume controls hidden until this contract is present.
