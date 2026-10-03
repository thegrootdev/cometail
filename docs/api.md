# The read API and the feed

Base URL: `https://api.cometail.fun`. Every route is `GET`, answers JSON, allows the site's
origin only through CORS, and is rate limited per client address. Nothing here is an input to a
transaction: the site and the SDK read the chain for anything they sign.

## Envelope (token routes, feed)
```
{ schemaVersion: 1, cluster: "devnet" | "mainnet-beta", generatedAtMs, observedSlot,
  coverage: { status: "complete" | "pending", pendingPools, lastSuccessfulAtMs },
  solUsd: { value, source, observedAtMs, status: "fresh" | "stale" | "missing", valuationBasis: "reference" },
  data: ... }
```
`coverage` says whether the trade index is caught up; `solUsd` is the one reference rate every
USD figure uses. Amounts are strings of base units (lamports, token raw units); nothing is
rounded server side.

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
| `/api/prices` | `{ solUsd, source, at }` (Jupiter, CoinGecko fallback, 60 s cache); 503 when no source answers. |
| `/api/metrics` | protocol totals, computed at most every 30 s: independent, demo and unattributed classes, recurring and one-time harvests, buyers of vault stream tokens. |

Every number comes from the chain or from the indexer's own observation of it; a value the
worker estimates says so in its field name or a `basis`/`status` sibling.

## The feed
`wss://api.cometail.fun/api/feed` (one JSON text frame per event) and `GET /api/feed?since=<cursor>&limit=`
(replay, max 500, `{ ...envelope, type: "replay", events, nextCursor }` with the last returned event's cursor when more remain; any origin may read it).

Frame: `{ schemaVersion: 1, cluster, type, cursor, observedSlot, generatedAtMs, provenance, data }`.
`provenance` is `{ source: "chain" | "indexer" | "estimate", signature?, slot?, scannedAtMs? }`;
an estimate carries `basis` in `data`.

Types and `data`:
- `launch` { mint, name, symbol, imageUrl, creator, config, dbcPool, tokenKind }
- `trade` { mint, pool, venue, side, baseAmountRaw, quoteAmountLamports, executionPriceSol, trader, signature }
- `graduation` { mint, dbcPool, dammPool, signature }
- `harvest` { vault, stream, incomeLamports, signature }
- `bid` { vault, order, bins (number), grossLamports, signature }
- `fill` { vault, order, burnedStRaw, unfilledLamports, signature }
- `cashout` { vault, depositorLamports, signature }
- `unwind` { vault, stMint, dbcPool, incomeReturned, launchedAt, unwoundAt, signature }
- `vault` { vault, event, ...the event's fields, signature }: every other program event (vaultCreated, streamDeposited, streamPositionRegistered, streamWithdrawn, launched, pairRegistered, live), so a consumer that ignores unknown types loses nothing it asked for.

Token rows (`launch`, `graduation`) carry no transaction: their cursor's third part is the mint and the slot is the scan's observed slot; `provenance.source` is `indexer`. Harvest rows carry `grossLamports`, `toDepositorLamports`, `toProtocolLamports` and `oneTime` next to `incomeLamports`.

Control frames: `hello` { cursor, retentionSlots } first on every socket (its head never
advances a consumer's delivered cursor); `ping` { generatedAtMs } every 25 s; `coverage`
{ status, pendingPools, lastSuccessfulAtMs } whenever coverage changes; `gap` { oldest, resume }
when the requested `since` is older than retention: `resume` is the cursor to pass as `since` so
the oldest retained event is not skipped. A gap is explicit: a consumer reconciles before it
acknowledges anything past it. Replay answers an expired cursor with HTTP 410
`{ error: "cursor expired", oldest, resume }`. Retention: 7 days.

Cursors are `slot:ordinal:signature`, strictly increasing within a connection and shared by
every type; `since` is exclusive.

## Non-SOL quotes
Every quote-denominated figure names its quote: `market.quoteMint` and `market.quoteDecimals`
on a token, `quoteMint` and `quoteDecimals` on a trade. `priceQuote` and `executionPriceQuote`
are quote units per whole token for any quote; `priceSol` and `executionPriceSol` are present
only when the quote is WSOL. `quoteUsd` is the USD rate of one quote unit: the SOL reference
for WSOL, 1 for a configured dollar stablecoin (`COMETAIL_USDC_MINTS`), otherwise
`{ value: null, status: "missing" }`, and then `fdvUsd` is null rather than guessed. The
`solUsd` envelope field stays for SOL-quoted figures.
