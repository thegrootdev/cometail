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
`{ mode: "all-dbc", pools, configs, fullSlot, deltaSlot, fullAtMs, deltaAtMs, fullEveryHours, deltaEveryMinutes }`.

| Route | Answer |
|---|---|
| `/api/fees/status` | the envelope alone |
| `/api/fees/coins?sort=day\|claimable\|lifetime\|avg&stage=all\|bonding\|graduated&eligible=1&creator=&q=&limit=&offset=` (limit max 200) | `{ coins, offset, limit }`, each coin `{ mint, pool, config, creator, launchpad, ours, name, symbol, stage, creatorFeePct, creatorLifetimeLamports, creatorLast24hLamports, last24hWindowHours, creatorAvgPerDayLamports, claimableLamports, launchedAtMs, tailEligible, reasons, changedAtMs }` |
| `/api/fees/coins/<mint>` | `{ coin }`, or 404 when the coin is not SOL-paired or has not paid its creator |
| `/api/fees/launchpads` | `{ launchpads, ourConfigs }`: fee claimers ranked by creator income in the last 24 hours, then lifetime (top 200), each `{ launchpad, ours, coins, configs, graduated, tailEligibleCoins, creatorLifetimeLamports, creatorLast24hLamports, claimableLamports, creatorFeePct }` (`creatorFeePct` null when its configs differ); `ourConfigs` the protocol's own configs with the same totals |

How the numbers are made:
- `creatorLifetimeLamports`: the pool's lifetime trading-fee counter (`metrics.totalTradingQuoteFee`, after Meteora's protocol share) times the config's creator trading-fee percentage. Curve fees only.
- `claimableLamports`: the pool's unclaimed creator fee (`creatorQuoteFee`), now.
- `creatorLast24hLamports`: the counter's growth since the newest hourly snapshot at least 24 hours old, times the creator share; `last24hWindowHours` is the actual window (shorter while the index has less history).
- `creatorAvgPerDayLamports`: lifetime over days since activation (at least one day).
- `tailEligible` and `reasons`: the program's own deposit rules for creator rights (SOL quote, fees in SOL, DAMM v2 migration, creator liquidity permanently locked and nothing unlocked or vesting) and a stage the vault accepts (bonding or graduated). The deposit itself checks the rest (mint extensions, freeze authority).
- Not included: fees on the creator's locked DAMM v2 position after graduation, which are not in the DBC pool.

Coverage: a full walk of every SOL-quoted DBC config and every DBC pool once a day (paginated,
sliced `getProgramAccountsV2`: about one minute for the configs and four for the pools), and a
walk of only the pools changed since the last one every few minutes (`changedSinceSlot`; fifteen
minutes of changes is about a hundred pools in ten seconds). Configs are immutable and read once.
Names come from Metaplex metadata for the top earners first; a coin without one shows its mint.

## The feed
`wss://api.cometail.fun/api/feed` (one JSON text frame per event) and `GET /api/feed?since=<cursor>&limit=`
(replay, max 500; any origin may read it). Both take `types=<comma list>` to receive only some
event types; `types=fees` is the fee stream (`claim`, `harvest`, `bid`, `fill`, whose `burnedStRaw`
is the burn). Control frames always arrive. A filtered replay scans `limit` rows and returns the
matching ones: its `nextCursor` then names the last scanned row and may lie past the last returned
event, so an empty filtered page can still continue. An unknown type answers 400.
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
- `claim` { mint, pool, role (`creator` or `partner`), quoteAmountLamports, baseAmountRaw, signature }: a fee claimed on a DBC pool of any launchpad the Fee Index covers, from the claim event in the transaction (the index notices the claimable fee fall between walks, then reads the pool's recent transactions)
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
