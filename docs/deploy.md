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
| `opt-level = "z"` (current) | 695,192 | 3.5324542 SOL |

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
  --max-len $(stat -c %s target/deploy/cometail_vault.so) \
  -u <cluster>
```

For a fresh loader-v3 deployment the buffer lamports are reused to fund the program-data
account (the loader drains the buffer to the payer before funding program data,
`programs/bpf_loader/src/lib.rs` at v3.1.10, line 575), so the deploy does not hold two
rent deposits at once. At the measured mainnet rent this ELF needs 3.53328732 SOL for the
program-data and program accounts combined, plus deployment fees and an operating margin.
Re-query rent and fees before the deploy; a stalled deploy leaves an extra buffer that ties
up funds until it is closed. An upgrade of an existing program is different: its buffer rent
is returned when the buffer closes, while the existing program-data account keeps its own.

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
