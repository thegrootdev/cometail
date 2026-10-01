# Partner configs

Four DBC configs, all protocol-owned. Each one fixes the raise target and the curve, so a
launch picks a config and nothing else. Parameters are the SDK's `buildCurveWithMarketCap`
inputs; `tests/devnet/setup.ts` turns them into on-chain `ConfigParameters` and creates them (devnet with a throwaway key; mainnet by the
protocol owner from a signed command).

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
