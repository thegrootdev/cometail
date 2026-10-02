# COMETAIL

Launch a comet. Sell the tail.

I'm building a launchpad on Meteora's Dynamic Bonding Curve with one twist: a token
launched here (or any eligible stream from another DBC launchpad) earns fees for as long
as it trades, and I let the creator sell that stream of fees as its own token. The fee
stream is the tail. The tail of `$CAT` trades as `tCAT`.

## Where it runs

Devnet: program `5xmZWYheruQjHQChg5YVtXjZUNmVKzvjJ6FYArtf4tmg` (the same id is reserved for
mainnet), protocol account `3FrYZjy6uax82FqWVASL8GUQNM1DnRJ7UZU18cZbLHFR`, configs and the
rest in `configs/devnet.json`. The devnet deployment carries small-threshold configs with the
presets' economics so a curve fills with half a SOL; the full-size configs are deployed next
to them. Nothing is on mainnet yet: the economics, the authority model and every disclosure
are written down in `docs/` before the code that implements them, the release gates in
`docs/release-gates.md` have to pass before anything ships, and `docs/deploy.md` says how
the program is built for size and deployed with a program-data account no larger than the
binary.

## Layout

- `programs/cometail_vault`: the on-chain program (Anchor). It custodies fee streams (DBC
  creator rights and DAMM v2 position NFTs) under a program-derived vault, launches the
  stream token on DBC with the vault as pool creator, harvests income through CPI, and turns
  that income into DLMM limit-order bids that burn whatever they fill.
- `packages/client`: TypeScript instruction builders and PDA helpers for the program, used
  by the site, the worker and the tests.
- `web`: the site (Next.js). The launchpad front door, The Sky (every Meteora fee stream as
  a comet), token pages, the sell-your-tail wizard, vault pages, the portfolio. Every line of
  copy lives in `web/src/content/cometail.ts`.
- `worker`: the keeper and indexer, one process with modes: migrates, registers, cashes out,
  harvests, opens and registers the stream token's DLMM pair, places and settles bids;
  indexes events, snapshots vaults, scans the Sky, serves the site's read API.
- `configs`: the four DBC partner config parameter files and the devnet addresses.
- `tests`: the LiteSVM harness that runs the program against the live mainnet Meteora
  binaries, the regression suite, the release gates, and the devnet scripts.
- `idls`: pinned Meteora IDLs.
- `docs`: how a vault works, the economics, the security model, the release gates, the
  deploy plan, the devnet browser checklist.

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
COMETAIL_API_PORT=8841                # indexer mode: the read API the site uses (0 = off); the worker refuses to start if the port is taken
COMETAIL_SKY_CONFIGS=                 # comma-separated DBC configs the Sky scan is limited to (empty = every pool)
COMETAIL_SKY_EVERY_PASSES=4           # scan the Sky every N indexer passes
COMETAIL_MIGRATE_CONFIGS=             # keeper mode: DBC configs whose complete curves the keeper migrates (the plain-launch configs)
```

The keeper's order per vault is migrate, register positions, cash out, harvest, create and
register the stream token's DLMM pair once the vault is Live (it buys a little stream token on
the graduated pool to fund the pair, opens it at the pool's price, prepares the bin arrays the
ladder uses), settle, route. Complete curves on the configured plain-launch configs and on
deposited rights are migrated as well.
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
the actor keys. `tests/devnet/e2e.ts` runs a vault with both DBC-rights stream states and
in-process keeper passes; `tests/devnet/e2e2.ts` runs a second vault with a standalone
position stream, the keeper and indexer as the real worker processes, and the trades through
the app's own helpers. Both use devnet-only configs with the presets' economics and market
caps divided by 80 (curves fill with half a SOL) and a reduced routing threshold; they are
integration evidence, not production thresholds. Addresses live in `configs/devnet.json`;
keys never leave `keys/devnet/`.
