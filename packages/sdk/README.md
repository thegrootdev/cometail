# COMETAIL SDK

A small, dependency-free TypeScript client for COMETAIL's public read API and event feed. It uses `fetch` and WebSocket, takes no wallet or key, and never signs or sends a transaction. Runtime output is ESM with declaration files. Use Node 22.12+ or a modern browser; inject a standards-compatible WebSocket when your runtime does not provide one.

This package is supplied in the workspace. Build it with `pnpm --filter @cometail/sdk build`, and use it from another workspace package with `"@cometail/sdk": "workspace:*"`. Publishing to a package registry is a separate release step. `pnpm --filter @cometail/sdk test` builds and runs the transport tests.

## Read the market

```ts
import { CometailClient } from "@cometail/sdk";

const api = new CometailClient({ baseUrl: "https://api.cometail.fun" });
const result = await api.tokens({ sort: "volume24h", stage: "all", limit: 20 });
console.log(result.cluster, result.coverage, result.observedSlot);
for (const token of result.data.tokens) {
  console.log(token.identity.name, token.identity.symbol);
  console.log(token.market.priceSol, token.provenance, token.estimates);
}
if (result.data.nextCursor) {
  const next = await api.tokens({ sort: "volume24h", stage: "all", limit: 20, cursor: result.data.nextCursor });
  console.log(next.data.tokens);
}
```

Keep raw amounts as strings or convert them to `BigInt`; never use `Number` for transaction amounts. Decimal price strings are display values. The endpoint's current cluster is in token/feed envelopes; the default origin does not imply mainnet. No cluster is invented for older REST responses that do not contain it.

| Method | Route | Result |
| --- | --- | --- |
| `tokens(query?, options?)` | `/api/tokens` | Token envelope with page, total and next cursor |
| `token(mint, options?)` | `/api/tokens/:mint` | Token envelope |
| `trades(mint, query?, options?)` | `/api/tokens/:mint/trades` | Trade envelope and next cursor |
| `sky(query?, options?)` | `/api/sky` | Stream rows, custody, eligibility and income fields |
| `vaults(options?)` | `/api/vaults` | Vault snapshots and stream-token identities |
| `vault(vault, query?, options?)` | `/api/vaults/:vault` | Snapshot, streams, events and stored trades |
| `events(query?, options?)` | `/api/events` | Indexed vault events |
| `metrics(options?)` | `/api/metrics` | Independent/demo/unattributed metrics with completeness notes |
| `prices(options?)` | `/api/prices` | SOL/USD, provider and observation time |
| `health(options?)` | `/api/health` | Service status |
| `replay(query?, options?)` | `/api/feed` | Oldest-first feed page and next cursor |
| `replayAll(since?, options?)` | `/api/feed` | Async iterator over replay pages |
| `feed(options)` | `/api/feed` WebSocket | Subscription with delivered cursor and `close()` |

Token and trade pages accept `limit` from 1 to 100; Sky, event and vault detail requests accept 1 to 1000; feed replay accepts 1 to 500. Limits outside the documented bounds reject locally. Token-list cursors are mint addresses; historical trade and feed cursors have a different shape. Pass each endpoint its own cursor. Token pages reflect a changing index and are not a snapshot-consistent export.

## Provenance and estimates

Every returned row and top-level read document carries `provenance` and `estimates`. Original API fields, nullable values, coverage, provider timestamps and unknown additive fields are retained.

Where a REST response has no provenance, the SDK labels it `{ source: "indexer" }`. This is SDK annotation of the source of the response, not independent chain verification. It does not manufacture a signature, slot, scan time or request-time freshness. Server provenance and estimate labels take precedence. Feed events retain their server provenance unchanged; an estimate event must contain a nonempty `data.basis`.

Known REST estimates receive a field path and basis:

- Sky `realizedEstimateLamports`: aggregate curve accrual less claimable fees, subject to rounding; not graduated-pool income.
- Token `market.fdvUsd`: derived fully diluted value, not circulating market cap.
- Token `market.liquidityLamports` with `damm-quote-x2`: twice the pool's quote side.
- Metrics `plainLaunches.volumeEstimateLamports`: the current flat-fee assumption, net curve fee multiplied by 125.

Use `coverage`, `incomplete`, `notes`, timestamps and the nullable raw values when deciding what to display. Missing is not zero. Devnet USD figures are reference values. Token markets expose `priceQuote`, `quoteMint`, `quoteDecimals` and `quoteUsd`; token-route trades expose `executionPriceQuote`, `quoteMint` and `quoteDecimals`. `priceSol` and `executionPriceSol` are null for non-WSOL quotes. Legacy fields named `lamports` are quote base units: interpret them using that quote mint and its decimals. A missing quote-to-USD rate stays null, never a guessed dollar figure. Feed trade rows in this worker release do not yet include quote siblings; resolve the token identity before displaying their quote amounts.

```ts
const sky = await api.sky({ limit: 200 });
for (const stream of sky.streams) {
  console.log(stream.token?.symbol, stream.claimableLamports);
  for (const estimate of stream.estimates) console.log(estimate.path, estimate.basis);
}
const metrics = await api.metrics();
console.log(metrics.incomplete, metrics.notes, metrics.estimates);
```

## Subscribe and resume

The worker sends `launch`, `trade`, `graduation`, `harvest`, `bid`, `fill`, `cashout`, `unwind` and `vault` events. Discriminating `event.type` narrows its data. `bid.data.bins` is a count. Nullable amounts and addresses remain null. `vault.data.event` names other program events. Indexer-derived graduations have no transaction signature; their cursor identifies the token and scan slot. The socket also sends `hello`, `ping` (normally every 25 seconds) and `coverage` controls. A `gap` control supplies `oldest` and `resume` cursors.

```ts
import type { FeedEvent } from "@cometail/sdk";

// Your durable store should write the event and its cursor together, idempotently.
declare function persist(event: FeedEvent): Promise<void>;
declare function readSavedCursor(): Promise<string | undefined>;
const saved = await readSavedCursor();
const stop = new AbortController();
const subscription = api.feed({
  since: saved,
  // Set to the network your application expects; omit to pin the first event's cluster.
  cluster: "devnet",
  signal: stop.signal,
  async onEvent(event) {
    if (event.type === "harvest") console.log(event.data.incomeLamports);
    await persist(event);
  },
  onControl(control) {
    if (control.type === "coverage") console.log(control.status, control.pendingPools);
  },
  onError(error) { console.error(error.message); },
});

// Later: stop.abort(), or subscription.close().
// subscription.cursor is the last event whose onEvent callback completed.
```

Callbacks run serially. A resolved callback advances the resume cursor; a rejected callback stops the subscription without acknowledging that event. Reconnect waits for already received callbacks to finish and resumes from the last delivered cursor. Duplicate replay at or below that cursor is suppressed. This is not an exactly-once database guarantee: make persistence idempotent, and save `event.cursor` with the event before resolving.

A hello head watermark is never treated as delivered history. If you start without a cursor, there is no durable resume point until the first event is delivered. Use a saved retained cursor when continuity matters. The client does not infer complete retention from `retentionSlots`, and it does not silently skip a gap.

Transport failures retry with bounded exponential delays (500ms to 30s by default). A 65-second watchdog catches missing heartbeats. The consumer queue is bounded at 500 events; overflow, invalid JSON, an unsupported schema/type, wrong cluster or out-of-order events stop with `onError`. Retain the last delivered cursor, fix the error, then replay/resubscribe. Closing stops timers and future deliveries; it cannot cancel work already running inside your own callback.

## Replay and gaps

```ts
try {
  for await (const event of api.replayAll(saved, { signal: stop.signal })) {
    await persist(event);
  }
} catch (error) {
  // HTTP 410, when supplied by the worker, means the cursor expired.
  // Reconcile your stored history rather than silently jumping to the newest event.
  console.error(error);
}
```

Replay pages are `{ schemaVersion, cluster, type: "replay", generatedAtMs, events, nextCursor }`, strictly after `since`, oldest first. A non-null `nextCursor` is the last event in a page with more results. Cursors compare numerically by slot and ordinal, then by signature; do not compare the full string lexically. The intended worker retention is seven days; that is a retention policy, not proof that a given scan or connection has no gaps. Feed/replay require the corresponding worker release; this package does not start a feed server.

## Errors, cancellation and test transports

```ts
import { ApiError, ProtocolError, FeedGapError } from "@cometail/sdk";
try {
  await api.prices({ signal: stop.signal });
} catch (error) {
  if (error instanceof ApiError) {
    console.log(error.status, error.retryAfter); // 404, 429, 503, etc.; no automatic HTTP retries
  } else if (error instanceof ProtocolError) {
    console.log(error.message); // bad JSON, incompatible envelope, invalid feed payload
  }
}
```

`ApiError` retains HTTP status, the raw Retry-After header and parsed error body. Timeouts and caller cancellation abort fetch. Requests time out after 15 seconds by default. `baseUrl` must be an HTTP(S) origin; origin credentials are rejected. Constructors accept an injected `fetch`, and `feed` accepts a standards-compatible `socketFactory`. REST guards validate envelopes, collections and the essential fields consumed by the SDK; TypeScript declarations describe the full server contract, not exhaustive runtime validation of arbitrary account JSON. Feed frames validate the event discriminant, required data fields, raw amounts and provenance before delivery.

No runtime dependencies, telemetry, secrets or transaction builders are included. The existing `@cometail/client` is the separate vault-program client. Mainnet setup and config creation follow the mainnet runbook and the operator's release procedure.

A retention `gap` closes the socket with `FeedGapError`, preserving the last delivered
cursor. The error exposes `oldest` and `resume`; `onControl` also receives the gap. The
client never reconnects past it automatically. After your application reconciles the
missing interval, explicitly replay or subscribe using `resume` (which precedes the
oldest retained event). Using `oldest` itself as an exclusive `since` would skip it.
HTTP replay retains the worker's 410 `{ error, oldest, resume }` body in `ApiError`.
`unwind.data.incomeReturned` is the raw WSOL balance returned, including donations;
it is separate from cumulative harvested-income and split counters.
