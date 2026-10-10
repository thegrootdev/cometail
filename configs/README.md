# Partner configs

The COMETAIL DBC configs (accounts owned by the Meteora DBC program): the four core configs below, five additional
public presets and the "Paired with $COMETAIL" preset (`paired.json`, quote $COMETAIL; created by
`tests/mainnet/paired-config.ts` with the launch treasury as fee claimer) in docs/presets.md, and the burn
program's four launch configs (docs/burn.md). Each fixes the raise target and curve.
`tests/harness/dbc.ts` selects the SDK market-cap or liquidity-weight builder from
`curve.mode`; `tests/devnet/setup.ts` creates the core devnet set. For mainnet, the owner
runs `tests/mainnet/setup.ts` for all nine, then `tests/mainnet/verify-configs.ts` for readback.
Mainnet setup takes separate `ADMIN` and `TREASURY` wallet public keys: the three stream
configs use ADMIN as fee claimer and leftover receiver; plain and the five other launch
presets use TREASURY for both. The protocol WSOL treasury remains ADMIN's canonical ATA.
Manifest `treasuryOwner` records the launch treasury wallet; `treasury` records that protocol
ATA. The historical `configs` bucket includes plain but does not determine its authority.
Readback also takes ADMIN/TREASURY on mainnet and rejects either authority being wrong.

| File | Migration fee | Creator share of it | Creation fee | Use |
|---|---|---|---|---|
| `stream-25.json` | 25% | 100% | 0 | stream tokens, cash-out 25% of the raise |
| `stream-50.json` | 50% | 100% | 0 | stream tokens, cash-out 50% |
| `stream-75.json` | 75% | 100% | 0 | stream tokens, cash-out 75% |
| `plain.json` | 0 | 0 | 0.01 SOL | plain launches |

Common to all: quote WSOL, fees collected in quote, 1% flat curve fee, creator 75% of the
after-Meteora fee (partner 25%), DAMM v2 migration with the Customizable option,
compounding pool at 1% fee with 50% of LP fees reinvested, LP 80% creator / 20% partner
both permanently locked, immutable metadata, fixed 1,000,000,000 supply with 6 decimals,
initial market cap 20 SOL, migration market cap 120 SOL.
