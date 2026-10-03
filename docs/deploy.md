# Deploying the program

Program-data rent is paid per byte for the life of the program, so the binary is built for
size and deployed with a program-data account no larger than the binary.

## Build

`anchor build --arch v0` with the workspace release profile: `opt-level = "z"`, fat LTO,
one codegen unit, overflow checks on (the program uses checked arithmetic everywhere, and
the checks also guard generated code), no debug info, symbols stripped. The program has no
debug logging; Anchor's instruction-name log stays on because explorers show it and it
costs about 2 KB (build with `--features no-log-ix-name` to drop it).

| Build | Bytes | Program-data rent on mainnet (bytes + 45) |
|---|---|---|
| `opt-level = 3` (before) | 941,784 | 4.78514156 SOL |
| `opt-level = "s"` | 766,944 | |
| `opt-level = "z"` (before the unwind instruction) | 695,192 | 3.5324542 SOL |
| `opt-level = "z"` (current, with `unwind`; sha256 bac11c56…) | 710,168 | 3.60853228 SOL |

The program account itself is 36 bytes (0.00083312 SOL). Rent figures come from
`solana rent <bytes> -um` on the day of the measurement; re-run them before the deploy.

## Deploy

Use an explicit `--max-len` equal to the ELF byte count, so the program-data account holds
exactly the binary. Agave CLI 3.1.10 already uses that length by default (`cli/src/program.rs`
at v3.1.10, line 1447); the explicit value makes the intended allocation clear and survives
a CLI whose default differs.

```
solana program deploy target/deploy/cometail_vault.so \
  --program-id <program keypair> \
  --upgrade-authority <authority keypair> \
  --fee-payer <authority keypair> \
  --max-len $(stat -c %s target/deploy/cometail_vault.so) \
  -u <cluster>
```
`--upgrade-authority` does not choose who pays: without `--fee-payer` (or `-k`) the CLI pays
from its configured default keypair (`solana program deploy --help`, solana-cli 3.1.10). The owner's wallet pays the
rent, so name it explicitly.

For a fresh loader-v3 deployment the buffer lamports are reused to fund the program-data
account (the loader drains the buffer to the payer before funding program data,
`programs/bpf_loader/src/lib.rs` at v3.1.10, line 575), so the deploy does not hold two
rent deposits at once. At the measured mainnet rent (2026-10-03) this ELF needs 3.6093654 SOL
for the program-data and program accounts combined, plus deployment fees and an operating
margin: 3.65 SOL for the deployment phase.
Re-query rent and fees before the deploy; a stalled deploy leaves an extra buffer that ties
up funds until it is closed. An upgrade of an existing program is different: its buffer rent
is returned when the buffer closes, while the existing program-data account keeps its own.

## Release artifact for mainnet

| | |
|---|---|
| ELF | `cometail_vault.so`, 710,168 bytes, SHA-256 `bac11c56a5ff5676bbdcf58e9f240b74b6f5529c9044042718fb05f7d5e7a372` |
| Source | the `unwind` commit 58b57c7; `programs/`, `Cargo.lock`, `Cargo.toml` and `Anchor.toml` unchanged through fb2228c |
| Toolchain | anchor-cli 1.2.0, solana-cargo-build-sbf 3.1.10, platform-tools v1.52, rustc 1.89.0, `anchor build --arch v0` |
| Where it runs | devnet program data since the upgrade at slot 506,926,374 (the live site, the keeper and every loop since) |
| Tests | the whole LiteSVM suite against these bytes at fb2228c: 14 files, 44 tests, 0 failures (2026-10-03) |

Provenance of the reviewed bytes. The ELF was built at 07:45 UTC on 2026-10-03; at 07:56 the
comment block above `unwind` in `instructions/launch.rs` was rewritten from five lines to
seven, and the result was committed as 58b57c7 at 08:05. A rebuild of HEAD with the same
toolchain gives the same size and exactly nine differing bytes (`8f190b85…`), every one a
source line number two higher: four `u32` store immediates in `.text` (lines 391 to 398
becoming 393 to 400, the `unwind` error sites) and five source-location records in
`.data.rel.ro` (the `#[event]` lines 423 to 427 becoming 425 to 429); `.rel.dyn` and every
other byte are identical. The reviewed bytes are therefore the committed code with the older
comment, and the gate suite passes on both builds. The mainnet deploy uses the reviewed bytes
above, not a fresh build: check `sha256sum` before `solana program deploy`, and after it
compare the first 710,168 bytes of `solana program dump` (the rest of the program-data
account is zero padding).

## Upgrade

An upgrade whose binary fits the existing program-data account needs only a buffer. If the
new binary is larger, extend first by exactly the difference, paying rent for those bytes
only:

```
solana program extend <program id> <additional bytes> -u <cluster> -k <authority keypair>
```

A program-data account cannot be shrunk. The devnet deployment at 1,000,000 bytes predates
this policy and stays as it is; mainnet is deployed fresh under it.

## If a deploy stalls

Public RPC endpoints rate-limit the hundreds of write transactions a deploy sends. A stalled
deploy leaves a buffer account holding rent; `solana program close <buffer> --recipient
<authority>` returns it, and the deploy is run again. Sending the writes to the validator
TPUs (the default, without `--use-rpc`) has been more reliable than `--use-rpc`.
