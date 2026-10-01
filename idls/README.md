# Meteora IDLs

Pinned copies used by `declare_program!` in the vault program and by the test harness.

| File | Program | Version | Source |
|---|---|---|---|
| `dynamic_bonding_curve.json` | `dbcij3LWUppWqq96dh6gJWwBifmcGfLSB5D4DuSMaqN` | 0.2.1 | `@meteora-ag/dynamic-bonding-curve-sdk` 1.5.13 |
| `cp_amm.json` | `cpamdpZCGKUy5JxQXB4dcpGPiikHawvSWAd6mEn1sGG` | 0.2.5 | `@meteora-ag/cp-amm-sdk` 1.5.1 |
| `lb_clmm.json` | `LBUZKhRxPF3XUpBCjp4YzTKgLccjZhTSDM9YuVaPwxo` | 0.12.0 | `@meteora-ag/dlmm` 1.9.14 |

The test fixtures under `tests/fixtures/programs` are the live mainnet binaries of these
programs, dumped read-only with `solana program dump -u m`, plus the Metaplex token
metadata program and Meteora helper programs needed by DBC migration.
