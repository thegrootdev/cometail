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

## The feed
`wss://api.cometail.fun/api/feed` (one JSON text frame per event) and `GET /api/feed?since=<cursor>&limit=`
(replay, max 500; any origin may read it).

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
