# Mainnet runbook

The ordered switch from devnet to mainnet. Every step names who runs it and what it needs.
Nothing on this list sends a mainnet transaction until step 5, and every transaction before
step 7 is a protocol setup signed by the owner's wallet. The difference list behind this
runbook is in the pre-mainnet review notes (devnet to mainnet diff); this file is the order.

## 0. Before anything
- The program binary is the reviewed one: `git diff <review commit>..HEAD -- programs/` is
  empty, and the full gate suite passed on the push candidate.
- The owner's mainnet wallet (admin, fee claimer, leftover receiver, treasury owner) is funded:
  program rent about 3.54 SOL, four configs about 0.1 SOL, protocol init and ATAs under 0.05
  SOL, plus the keeper's operating SOL (step 4).
- A keyed mainnet RPC exists for the worker and one restricted to the site origin for the browser.

## 1. Dry run (no transaction)
```
cd tests && ADMIN=<owner wallet> KEEPER=<keeper pubkey> RPC=<keyed mainnet rpc> \
  ./node_modules/.bin/ts-mocha --exit -p ./tsconfig.json -t 600000 mainnet/dryrun.ts
```
Simulates the treasury ATA, the four `create_config` transactions with the full-size preset
files in `configs/` and `init_protocol`, all with the owner's wallet as every authority. The
config simulations pass before the program is deployed; `init_protocol` passes only after
step 2. Keep the output with the deployment record.

## 2. Deploy the program (owner)
`docs/deploy.md`: `solana program deploy` with the reviewed ELF, max-len the ELF size, upgrade
authority the owner's wallet. Verify: `solana program show 5xmZWYheruQjHQChg5YVtXjZUNmVKzvjJ6FYArtf4tmg`
on mainnet shows the owner's wallet as authority. Rerun step 1: `init_protocol` now simulates.

## 3. Configs and protocol (owner)
`tests/mainnet/setup.ts` (the devnet setup with the mainnet key path and `configs/mainnet.json`
as its state file) creates, in order: the treasury WSOL ATA, the four configs, `init_protocol`.
Each step is skipped once its account exists, so a partial run is resumed by running it again.
Record the four config addresses and the protocol address in `configs/mainnet.json` (public
addresses only; the file is committed).

## 4. Keeper key (box)
Generate a fresh keypair on the box, mode 600, outside the repository; fund it with operating
SOL only (bin-array rent 0.071 SOL per array plus fees; 1 SOL to start). Never the admin key.

## 5. Worker (box, root)
`/etc/cometail/worker.env`: `COMETAIL_RPC_URL` the keyed mainnet RPC; `COMETAIL_KEEPER_KEYPAIR`
the step 4 file; `COMETAIL_MIGRATE_CONFIGS` the mainnet plain config and every preset config (long, flat,
exp, stock-usdc, stock-xstock); `COMETAIL_SKY_CONFIGS` the four protocol configs plus the same
five presets (never empty on mainnet); `COMETAIL_USDC_MINTS` mainnet USDC; `COMETAIL_DEMO_ACTORS` the owner's wallets and
the keeper; `COMETAIL_MIN_ROUTE_LAMPORTS=100000000`; `COMETAIL_API_ORIGINS=https://cometail.fun`.
Then `systemctl restart cometail-indexer@dev cometail-keeper@dev` and check
`/api/health`, `/api/metrics` (cluster mainnet-beta, zero rows) and the keeper log for one pass.

## 6. Site (Vercel, owner)
Production variables: `NEXT_PUBLIC_CLUSTER=mainnet-beta`, `NEXT_PUBLIC_RPC_URL` the
origin-restricted mainnet RPC, `NEXT_PUBLIC_PROTOCOL`, `NEXT_PUBLIC_PLAIN_CONFIG`,
`NEXT_PUBLIC_STREAM_CONFIG_25/50/75`, `NEXT_PUBLIC_TREASURY` from `configs/mainnet.json`.
Storage and API variables unchanged. Redeploy; `/api/metadata` must answer ready with the new
build; the Devnet badge disappears.

## 7. First launches (team)
One plain launch and one vault by the team, labelled demo in `COMETAIL_DEMO_ACTORS`, before
opening to users: launch with a logo and links from the site, one buy, one claim; one vault
deposit, launch, and a harvest after the first fees. Each receipt goes on the checklist.

## Rollback
Vercel: promote the previous deployment. Worker: restore the previous `worker.env` and restart.
The program and configs stay; nothing in them depends on the site or the worker.
