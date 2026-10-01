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
them; the release gates in `docs/release-gates.md` have to pass before anything ships.

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
