# The worker: keeper and indexer

One process, configured from the environment, in one of three modes: `keeper` (the loop that
operates vaults with the bounded hot key), `indexer` (follows the program and the pools into the
store, scans the pool map, serves the read API), or `once` (a single keeper pass). Hosting runs
one instance of each of the first two (`docs/hosting.md`); the production environment file is
written by the mainnet runbook (`docs/mainnet-runbook.md`, step 6).

## Configuration

```
COMETAIL_MODE=keeper|indexer|once     # keeper loop, event indexer, or a single keeper pass
COMETAIL_CLUSTER=mainnet-beta|devnet  # reported in every API envelope
COMETAIL_RPC_URL=                     # keyed RPC
COMETAIL_KEEPER_KEYPAIR=              # the bounded hot key (keeper and once modes)
COMETAIL_POLL_MS=15000
COMETAIL_DUST_LAMPORTS=1000000        # harvests below this gross are skipped
COMETAIL_MIN_ROUTE_LAMPORTS=100000000 # idle income below 0.1 SOL is not placed as orders
COMETAIL_MAX_ROUTE_LAMPORTS=5000000000
COMETAIL_LADDER_BINS=5 COMETAIL_LADDER_NEAR_BPS=200 COMETAIL_LADDER_FAR_BPS=2000 COMETAIL_LADDER_DECAY=0.85
COMETAIL_STALE_ORDER_SECONDS=86400    # resting bins older than this are cancelled and placed again
COMETAIL_LUT_CACHE=                   # address-lookup-table cache file (default ~/.config/cometail/lookup-tables.json)
COMETAIL_DRY_RUN=1                    # simulate everything, send nothing
COMETAIL_ALERT_WEBHOOK=               # optional JSON webhook for failures
DATABASE_URL=postgres://... | sqlite:/path/to/file.sqlite   # indexer mode: Postgres or SQLite
COMETAIL_API_PORT=8841                # indexer mode: the read API (0 = off); the worker refuses to start if the port is taken
COMETAIL_API_HOST=127.0.0.1
COMETAIL_API_ORIGINS=https://cometail.fun   # CORS allow-list
COMETAIL_API_RATE_PER_MINUTE=120
COMETAIL_SKY_CONFIGS=                 # comma-separated DBC configs the pool scan is limited to (empty = every pool)
COMETAIL_SKY_EVERY_PASSES=4           # scan the pool map every N indexer passes
COMETAIL_MIGRATE_CONFIGS=             # keeper mode: DBC configs whose completed curves the keeper migrates (the launch presets)
COMETAIL_USDC_MINTS=                  # mints treated as dollar quotes
COMETAIL_DEMO_ACTORS=                 # indexer mode: team and demo wallets, reported apart from independent actors by /api/metrics
COMETAIL_FEE_INDEX_DB=                # indexer mode: the Fee Index's own SQLite file (empty = off); needs an RPC with getProgramAccountsV2
COMETAIL_FEE_INDEX_FULL_HOURS=24      # a full walk of every SOL-quoted DBC config and pool this often
COMETAIL_FEE_INDEX_DELTA_MINUTES=5    # changed pools only, in between
```

The Fee Index (`src/feeindex.ts`) runs on its own loop beside the indexer, so a full walk (about
five minutes and, measured on mainnet, 1.75 million pools and 0.48 million SOL-quoted configs read
in 1,000-account pages of a 296-byte or 360-byte slice) never holds up the trade index. Between
full walks, a `changedSinceSlot` walk reads only the pools written since the last one. It keeps
SOL-paired pools that have paid their creator (about 420,000), in its own SQLite file with hourly
counter snapshots for about 50 hours. A claim is noticed when a claimable fee grew less than its share
of the counter between walks, and confirmed from the claim event in the pool's transactions inside
that walk window; it is published on the feed as a `claim` row. Every stream snapshot carries the
source coin's mint (`sourceMint`, read once per stream), so `/api/tails?source=` finds vaults holding
fees from any launchpad's coin. It
reads OUR configs (`COMETAIL_SKY_CONFIGS`) to mark them in the launchpad ranking. Routes and field
meanings: docs/api.md, "The Fee Index".

## The keeper

Order per vault: migrate, register positions, cash out, harvest, create and register the fee
token's DLMM pair once the vault is Live (it buys a little of the fee token on the pool to fund
the pair, opens it at the pool's price, prepares the bin arrays the orders use), settle, route.
Completed curves on the configured launch configs and on deposited rights are migrated as well.
Every write is simulated first; a rejected simulation is logged and skipped, so the loop is safe
to run against a vault whose policy says no. Orders spread their bins across a band 2% to 20%
below the market (nearest bins weighted most) and drop any bin above the price cap; orders wider
than twelve bins go out as v0 transactions with a per-vault address lookup table.

The keeper's power is bounded by the program: it decides when to harvest and where to place
orders, never a destination it controls (`docs/security.md`).

## The indexer and the read API

The indexer follows the program's transactions into the store, snapshots every vault and fee
source, scans the pool map (every DBC pool joined to its config: custody, eligibility, progress,
claimable backlog, realized curve income; for every migrated pool, one row per permanently locked
DAMM v2 position with the NFT holder and its custody, the position's share of the pool's permanent
liquidity, pending quote fees, quote fees claimed so far, and whether the program's size rule would
admit it, keyed by the position address with `kind: "position"`), and serves the routes in
`docs/api.md`: `/api/sky`, `/api/vaults`, `/api/vaults/:vault`, `/api/events`, `/api/prices`
(SOL/USD for display, cached, with its source), `/api/metrics` (computed at most every 30 s), the
launchpad routes `/api/tokens` (sort by 24 h volume or newest, stage and search filters, cursor
paging), `/api/tokens/:mint`, `/api/tokens/:mint/trades`, and the feed (`/api/feed`, GET and
WebSocket, resumable by cursor).

Token answers carry an envelope (schema version, cluster, generated time, newest indexed slot,
coverage with pending pools, SOL/USD with its source and age); every number is from the chain or
the trade index: price from the pool's sqrt price (the DBC curve while on the curve, the DAMM v2
pool after), supply from the mint, curve progress from the pool and its config, holders as unique
owners of nonzero token accounts (a full read, cached ten minutes), 24 h volume as executed quote
legs with buy and sell counts and a completeness flag from the per-pool cursors, FDV as price x
total supply x the quote's USD rate (labelled fdv; market cap is null until a circulating
definition exists). Unknown is null, never zero.

The trade index follows every launch's DBC curve and its DAMM v2 pool after completion (venue
curve or damm), plus every vault's pool. Vault rows carry a live view (the standing orders bin by
bin with prices and the pool's active price) and fee-source rows the registered position's share
of its pool's locked liquidity. `/api/metrics` reports the submission numbers with independent
actors apart from the demo set (`COMETAIL_DEMO_ACTORS`): launches and their fee volume by creator,
recurring external and own income apart from one-time proceeds, depositors, order depth (unfilled
principal from the bin arrays), fills and burns and refunded principal by vault depositor;
anything whose owner is not yet resolved is reported as unattributed, never independent.
Fee-token buyers come from the trade index: every swap on a vault's pool (cp-amm `EvtSwap2` paired
with its `swap`/`swap2` instruction) is stored with the swap's own signer, or with the fee payer
marked as such when the pairing is not possible (never counted as an independent buyer). Each pool
catches up backward in bounded pages with a persisted frontier, so no interval is skipped, and a
pool still catching up marks the metrics incomplete. Transactions are read through web3.js, and
through the raw RPC when the node reports a transaction version web3.js does not accept yet
(mainnet carries version 1 since 2026; the raw JSON is shaped into what the decoders read).
A locked-liquidity row says who holds the position when that matters to the protocol
(`ownerRole`: the launch treasury, the config's fee claimer, or a vault), and a creator position a
rights stream registered after migration links to that vault; a holder with no account yet counts
as a wallet when its address is on the curve.

## Devnet scripts

`tests/devnet/verify-configs.ts` checks a cluster's DBC configs and the protocol account against
the program's own pins. `tests/devnet/setup.ts` creates the treasury, the core configs and the
protocol and funds the actor keys. `tests/devnet/e2e.ts` and `e2e2.ts` run vaults end to end with
in-process and real worker passes on small-threshold devnet configs (the presets' economics with
market caps divided by 80, so a curve fills with half a SOL). They are integration evidence, not
production thresholds. Addresses live in `configs/devnet.json`; keys never leave `keys/devnet/`.
