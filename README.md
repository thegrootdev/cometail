# COMETAIL

Launch a comet. Sell the tail.

I'm building a launchpad on Meteora's Dynamic Bonding Curve with one twist: a token
launched here (or any eligible stream from another DBC launchpad) earns fees for as long
as it trades, and I let the creator sell that stream of fees as its own token. The fee
stream is the tail. The tail of `$CAT` trades as `tCAT`.

## What's in here

- `programs/cometail_vault`: the on-chain program. It custodies fee streams (DBC creator
  rights and DAMM v2 position NFTs) under a program-derived vault, launches the stream token
  on DBC with the vault as pool creator, harvests income through CPI, and turns that income
  into DLMM limit-order bids that burn whatever they fill.
- `web`: the site. The launchpad front door, The Sky (every Meteora fee stream as a comet),
  token pages, vault pages.
- `worker`: the keeper and indexer. Harvests, migrates, places and settles bids, indexes
  events.
- `configs`: the four DBC partner configs (three stream-token presets and the plain launch).
- `tests`: a LiteSVM harness that runs the program against the live mainnet Meteora
  binaries, plus the release gates.
- `idls`: pinned Meteora IDLs.
- `docs`: how it works, the economics, the security model.

## Where it stands

Devnet build in progress: the program has its accounts and first instructions, the
harness runs the Meteora paths against the live binaries, the site is a scaffold.
Nothing here is on mainnet yet. The economics, the authority
model and every disclosure are written down in `docs/` before the code that implements
them; the release gates in `docs/release-gates.md` have to pass before anything ships, and
`docs/deploy.md` says how the program is built for size and deployed with a program-data
account no larger than the binary.

## Running it

```
pnpm install
pnpm build:program          # anchor build --arch v0
pnpm --filter @cometail/tests build:forwarder   # separate step: the test suite does not build it
pnpm test:program
pnpm dev:web
```

Used here: Node 22.23, pnpm 12.8, Rust stable 1.99 on the host, Solana CLI 3.1.10 with
SBF platform tools v1.54, Anchor CLI 1.2.0. The program builds in the classic sBPF v0
format; Anchor 1.2 defaults to v3, which the LiteSVM release used by the harness cannot
load. The verifiable mainnet build gets its own pinned, documented toolchain.

## Built on Meteora

DBC for the curves, DAMM v2 for the graduated pools (compounding), DLMM for the buyback
ladder. All three are load-bearing.

## Running the worker

One process, three modes, all configured from the environment:

```
COMETAIL_MODE=keeper|indexer|once   # keeper loop, event indexer, or a single keeper pass
COMETAIL_RPC_URL=http://127.0.0.1:8899
COMETAIL_KEEPER_KEYPAIR=~/.config/cometail/keeper.json   # the bounded hot key
COMETAIL_POLL_MS=15000
COMETAIL_DUST_LAMPORTS=1000000        # harvests below this gross are skipped
COMETAIL_MIN_ROUTE_LAMPORTS=100000000 # idle income below 0.1 SOL is not laddered
COMETAIL_MAX_ROUTE_LAMPORTS=5000000000
COMETAIL_LADDER_BINS=5 COMETAIL_LADDER_NEAR_BPS=200 COMETAIL_LADDER_FAR_BPS=2000 COMETAIL_LADDER_DECAY=0.85
COMETAIL_STALE_ORDER_SECONDS=86400    # resting bins older than this are cancelled and re-laddered
COMETAIL_DRY_RUN=1                    # simulate everything, send nothing
COMETAIL_ALERT_WEBHOOK=               # optional JSON webhook for failures
DATABASE_URL=postgres://... | sqlite:/path/to/file.sqlite   # indexer mode: Postgres in production, SQLite anywhere
COMETAIL_API_PORT=8787                # indexer mode: the read API the site uses (0 = off)
COMETAIL_SKY_CONFIGS=                 # comma-separated DBC configs the Sky scan is limited to (empty = every pool)
COMETAIL_SKY_EVERY_PASSES=4           # scan the Sky every N indexer passes
```

The keeper's order per vault is migrate, register positions, cash out, harvest, settle, route.
Every write is simulated first and a rejected simulation is logged and skipped, so the loop is
safe to run against a vault whose policy says no. Ladders spread their bins across a band 2% to 20% away
from the market (nearest bins weighted most) and drop any bin outside the price cap; ladders wider than twelve bins
go out as v0 transactions with a per-vault address lookup table.

The indexer follows the program's transactions into the store, snapshots every vault and
stream, scans the Sky (every DBC pool joined to its config: custody, eligibility, progress,
claimable backlog, realized curve income), and serves `/api/sky`, `/api/vaults`,
`/api/vaults/:vault` and `/api/events` for the site.

## Running the site

`pnpm dev:web`. Copy `web/.env.local.example` to `web/.env.local` and point
`NEXT_PUBLIC_RPC_URL` and `NEXT_PUBLIC_API_URL` at the cluster and the worker's API; the
devnet addresses are the defaults in `web/src/lib/addresses.ts`. Pages: the Sky, launch,
token, sell-your-tail wizard, vault, portfolio. Every line of copy is in
`web/src/content/cometail.ts`.

## Devnet

`tests/devnet/setup.ts` creates the treasury, the four configs and the protocol and funds
the actor keys; `tests/devnet/e2e.ts` runs the whole lifecycle with the keeper and the
indexer in-process on devnet-only small-threshold configs (see the file headers for the
commands). Addresses live in `configs/devnet.json`; keys never leave `keys/devnet/`.
