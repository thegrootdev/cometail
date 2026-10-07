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
| `opt-level = "z"` (with `unwind`; sha256 bac11c56…, retired) | 710,168 | 3.60853228 SOL |
| `opt-level = "z"` (current, with the activation-clock fix; sha256 562475c1…) | 710,400 | 3.60971084 SOL |

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
rent deposits at once. At the measured mainnet rent (2026-10-03) the current ELF needs
3.61054396 SOL for the program-data and program accounts combined, plus deployment fees and
an operating margin: 3.65 SOL for the deployment phase.
Re-query rent and fees before the deploy; a stalled deploy leaves an extra buffer that ties
up funds until it is closed. An upgrade of an existing program is different: its buffer rent
is returned when the buffer closes, while the existing program-data account keeps its own.

## Release artifact for mainnet

| | |
|---|---|
| ELF | `cometail_vault.so`, 710,400 bytes, SHA-256 `562475c161a05d665b35ddc4a55a731ea0797d80cffa3390f5d8f7733766c4d2` |
| Source | commit 741e8e7 (the review fix to `register_pair`'s activation clock); built from that tree |
| Toolchain | anchor-cli 1.2.0, solana-cargo-build-sbf 3.1.10, platform-tools v1.52, rustc 1.89.0, `anchor build --arch v0` |
| Where it runs | devnet program data since the upgrade at slot 507,050,729 (the first 710,400 bytes of the program dump hash to the value above; the rest is zero padding) |
| Tests | the whole LiteSVM suite against these bytes: 14 files, 46 tests, 0 failures (2026-10-03) |
| Program-data rent | 3.60971084 SOL for 710,400 + 45 bytes at the rate quoted 2026-10-03 (`solana rent 710445 -um`); re-quote on the day |

The earlier artifact (`bac11c56…`, 710,168 bytes, the unwind build) is retired: it admitted a
slot-activated DLMM pair before its activation slot (review finding, gate 04 covers it now).
The mainnet deploy uses the bytes above, not a fresh build: check `sha256sum` before
`solana program deploy`, and after it compare the first 710,400 bytes of `solana program dump`.

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

## The burn program

`programs/cometail_burn` builds the same way (`anchor build --arch v0`, the workspace release profile; Anchor runs
`cargo build-sbf --tools-version v1.57`). Adding it to the workspace leaves the vault's binary byte-identical
(sha256 562475c1… before and after, measured 2026-10-07).

| Build | Bytes | sha256 (raw ELF) |
|---|---|---|
| `opt-level = "z"`, 2026-10-07 | 363,824 | 899ae204591ac30f73a500ab042e03ed1eaf2c6fbf3a9fc95b5c1ecadc3c463d |

Devnet: deployed 2026-10-07 at slot 508,351,514 with `--max-len 363824` (program-data rent 1.84910476 SOL on devnet;
re-quote mainnet with `solana rent 363869 -um` on the day), the dump hashing to the build above.
The verifiable rebuild for mainnet uses the vault's arguments with `--library-name cometail_burn`:
`--base-image solanafoundation/solana-verifiable-build:3.1.10 --cargo-build-sbf-args="--tools-version v1.57"`.
