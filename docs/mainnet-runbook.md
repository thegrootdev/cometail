# Mainnet runbook

The ordered switch from devnet to mainnet. Every step names who runs it and what it needs.
Steps 1 to 3 send no transaction. Step 4 deploys the program and step 5 creates accounts:
those are mainnet transactions, signed by the owner's wallet. The keeper started in step 6
has nothing to act on while the new protocol and watched configs are empty. Once launches
exist it can harvest even before graduation, and migrate completed curves. The team's
launch in step 9 is the intended next transaction, not a guarantee on permissionless configs. Every address this page produces is public and lands in
`configs/mainnet.json`; no key and no keyed URL ever enters the repository.

## 1. Keys (first, before anything that names them)
- Admin wallet: upgrade authority, protocol admin, fee claimer and leftover receiver for the
  three stream configs, and owner of the protocol WSOL treasury ATA. Its public key is
  `ADMIN` below; its keypair file stays with the owner (mode 600, outside the repository) and
  is used in steps 4 and 5 only (the deploy's payer and upgrade authority, the setup's signer).
- Launch treasury wallet: `TREASURY` below, fee claimer and leftover receiver for **plain,
  long, flat, exp, stock-usdc and stock-xstock**. Distinct from admin and keeper. Only its
  public key is needed for setup; its private key stays with the owner and later signs claims.
  This wallet is separate from the admin-owned protocol WSOL treasury account.
- Keeper hot key: generated on the box now, `solana-keygen new -o <path outside the repo>`,
  mode 600, readable by the service user. Its public key is `KEEPER` below and the same key
  the worker runs with in step 6; the protocol stores it at init. Never the admin key.
- Keyed mainnet RPC for the box (`RPC`) and a second one restricted to the site's origin for
  browsers (`NEXT_PUBLIC_RPC_URL`).

## 2. Funding (owner)
The owner's wallet, by phase. Deployment (step 4): program-data rent 3.609 SOL for the
reviewed ELF plus the program account and fees (docs/deploy.md; re-quote with `solana rent`
on the day): 3.65 SOL. Setup (step 5): nine configs at 0.006 SOL each, the treasury account
and the protocol account under 0.004 SOL, fees, 0.02 SOL margin: 0.08 SOL, which the script
computes itself for the work still pending (a no-op rerun needs nothing). First launches
(step 9): creation fees and first buys, 0.5 SOL and up. Fund 4.5 SOL before step 4: 0.77 SOL
remains after deployment and setup, 0.27 SOL after the minimum launch allowance.
The keeper: operating SOL only (bin-array rent 0.071 SOL per array plus fees), 1 SOL to start.

## 3. Dry run (no transaction)
```
cd tests && RPC=<keyed mainnet rpc> ADMIN=<admin wallet> TREASURY=<launch treasury wallet> KEEPER=<keeper pubkey> \
  COMETAIL_QUOTE_USDC=EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v \
  COMETAIL_QUOTE_STOCK=Xsc9qvGR1efVDFGLrVsmkzv3qi45LTBjeUKSPmx9qEh \
  DRY_RUN=1 ./node_modules/.bin/ts-mocha --exit -p ./tsconfig.json -t 1200000 mainnet/setup.ts
```
`tests/mainnet/setup.ts` refuses any cluster but mainnet, then runs a preflight: the
program, both quote mints (USDC must be the canonical mint, the stock must carry the
decimals of its file), the stock's DBC token badge (owned by DBC, naming that mint) and the
wallet's balance against the rent and fees of what is still pending (0.08 SOL for a fresh
run; an unfunded payer cannot even simulate). A failed preflight stops
the run before anything is simulated. Then it simulates the treasury account and the nine
`create_config` transactions (three stream presets, plain, long, flat, exp, stock-usdc,
stock-xstock, with the full-size files in `configs/`) with ADMIN as fee claimer and leftover receiver on the three stream configs, TREASURY
as both authorities on the six launch configs, and the stock badge as remaining account 0.
ADMIN pays/signs all setup transactions; the treasury wallet need not be funded for config
creation. Authority addresses are logged for each new config before simulation. The `init_protocol` simulation needs
the real stream configs and treasury, so before step 5 it is reported SKIPPED. Any failed
simulation fails the run. The dry run writes nothing: `configs/mainnet.json` is written by
the real run only. Keep the output with the deployment record.

### 3b. The stock quote: NVDAx (chosen by the owner 2026-10-03)
`COMETAIL_QUOTE_STOCK` and `NEXT_PUBLIC_QUOTE_STOCK` are NVIDIA xStock,
`Xsc9qvGR1efVDFGLrVsmkzv3qi45LTBjeUKSPmx9qEh` (Token-2022, 8 decimals, DBC token badge
`mfacWnGh1Kn5ttHMMaNZhRZbCjvGrDQyDyZgqaR9vBM`). The scan behind the choice (read-only,
2026-10-03): all Backed xStocks carry a DBC token badge. By holders and depth: NVIDIA xStock (NVDAx,
`Xsc9qvGR1efVDFGLrVsmkzv3qi45LTBjeUKSPmx9qEh`, 8 decimals) 172,851 holders, 0.01 % price
impact on a 10,000 USD buy and 0.13 % on 100,000; SP500 xStock (SPYx,
`XsoCS1TfEyfFhfvj8EtZ528L3CaKBDBRqRapnBbDF2W`) 81,422 holders, 0.04 % and 0.12 %. The setup
script verifies the badge of the mint it is given on the day.

## 4. Deploy the program (owner)
`docs/deploy.md`: `solana program deploy` with the reviewed ELF (the hash in the release
record; verify it with `sha256sum` first), max-len the ELF size, upgrade authority and
`--fee-payer` both the owner's wallet keypair (the authority flag alone does not select the
payer), the keyed mainnet RPC given explicitly with `-u`. Verify with
`solana program show 5xmZWYheruQjHQChg5YVtXjZUNmVKzvjJ6FYArtf4tmg -u <keyed mainnet rpc>`:
authority the owner's wallet.

## 5. Configs and protocol (owner, real transactions)
The step 3 command without `DRY_RUN`, plus `ADMIN_KEYPAIR=<path to the owner's keypair file>`.
It creates, in order, what does not exist yet: the treasury WSOL account, the nine configs,
`init_protocol` with the three stream configs, the treasury and `KEEPER`. The real run
requires the deployed program and fails, rather than skipping, when `init_protocol` cannot
run. Every address goes to `configs/mainnet.json` as it is confirmed, so an interrupted run
is resumed by running the same command again: a rerun refuses to start if the recorded
admin, launch treasury owner, keeper or quote mints differ from the command's, and it skips a recorded account only
after decoding it and matching every parameter. After a failed send the run sends nothing
more (the later steps read SKIPPED), keeps what confirmed, and exits non-zero; fix the cause
and rerun. Then the readback:
```
cd tests && RPC=<keyed mainnet rpc> ADMIN=<admin wallet> TREASURY=<launch treasury wallet> CLUSTER=mainnet ./node_modules/.bin/ts-mocha --exit -p ./tsconfig.json -t 600000 mainnet/verify-configs.ts
```
requires exactly the nine configs and the protocol in the file, the mainnet genesis and the
program id, and compares every parameter of every config with its file (quote mint, decimals
and token flag, fee claimer and leftover receiver, base and dynamic fees, thresholds, start
price, every curve segment, supply and its fixed flag, update authority, locked vesting,
liquidity split and vesting, migration option and fees, the migrated pool's fee settings,
creation fee), the stock badge, and the protocol's owner, admin, keeper, treasury and
stream-config pins. The supplied ADMIN/TREASURY public keys are checked independently against
the manifest and config authorities. `treasuryOwner` in the manifest is the launch treasury
wallet; the existing `treasury` field remains ADMIN's canonical WSOL ATA. Legacy mainnet
manifests without `treasuryOwner` are not silently relabeled: their immutable config
ownership must be inspected before migration. Devnet manifests without the field retain
the existing all-admin expectations. Commit `configs/mainnet.json`.

The reviewed program is unchanged. The protocol's 1/5 external-stream share and the three
stream configs' partner fees remain with ADMIN. Direct launch configs never enter the
vault's stream-config authority check. DBC fee claimer/leftover receiver are fixed at
creation; rotating either wallet in the manifest does not transfer existing config rights.

## 6. Worker (box, root)
Stop both services. Keep the devnet database file where it is. Write
`/etc/cometail/worker.env` for mainnet, every line:
```
COMETAIL_RPC_URL=<keyed mainnet rpc>
COMETAIL_CLUSTER=mainnet-beta
# a fresh database file for mainnet; never the devnet one
DATABASE_URL=sqlite:/opt/cometail/repo/.local/mainnet.sqlite
COMETAIL_KEEPER_KEYPAIR=<keeper keypair path from step 1>
COMETAIL_MIGRATE_CONFIGS=<plain,long,flat,exp,stock-usdc,stock-xstock from configs/mainnet.json>
COMETAIL_SKY_CONFIGS=<those six plus stream-25,stream-50,stream-75>
COMETAIL_USDC_MINTS=EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v
COMETAIL_DEMO_ACTORS=<owner wallet, keeper, every team wallet that will trade>
COMETAIL_API_PORT=8841
COMETAIL_API_HOST=127.0.0.1
COMETAIL_API_ORIGINS=https://cometail.fun
COMETAIL_API_RATE_PER_MINUTE=120
COMETAIL_MIN_ROUTE_LAMPORTS=100000000
COMETAIL_DUST_LAMPORTS=100000
COMETAIL_POLL_MS=15000
COMETAIL_SKY_EVERY_PASSES=4
COMETAIL_DRY_RUN=0
```
`COMETAIL_MODE` stays per service unit (indexer, keeper); `@dev` in the unit names is the
Unix user, not the cluster. Do not carry `COMETAIL_ONCE` into the file. Start both services.
Check: `/api/health` ok; `/api/tokens?limit=1` and `/api/feed?limit=1` answer
`cluster: "mainnet-beta"` with empty lists at first; the keeper log shows one pass with no
error; `solana genesis-hash -u <keyed mainnet rpc>` is `5eykt4UsFv8P8NJdTREpY1vzqKqZKvdpKuc147dw2N9d`.

## 7. Site (Vercel, owner)
Production variables, every one:
```
NEXT_PUBLIC_CLUSTER=mainnet-beta
NEXT_PUBLIC_RPC_URL=<origin-restricted mainnet rpc>
NEXT_PUBLIC_API_URL=https://api.cometail.fun
NEXT_PUBLIC_PROTOCOL=<configs/mainnet.json protocol>
NEXT_PUBLIC_TREASURY=<configs/mainnet.json treasury>
NEXT_PUBLIC_PLAIN_CONFIG=<configs.plain>
NEXT_PUBLIC_STREAM_CONFIG_25=<configs.stream-25>
NEXT_PUBLIC_STREAM_CONFIG_50=<configs.stream-50>
NEXT_PUBLIC_STREAM_CONFIG_75=<configs.stream-75>
NEXT_PUBLIC_LONG_CONFIG=<presets.long>
NEXT_PUBLIC_FLAT_CONFIG=<presets.flat>
NEXT_PUBLIC_EXP_CONFIG=<presets.exp>
NEXT_PUBLIC_STOCK_USDC_CONFIG=<presets.stock-usdc>
NEXT_PUBLIC_STOCK_XSTOCK_CONFIG=<presets.stock-xstock>
NEXT_PUBLIC_QUOTE_USDC=EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v
NEXT_PUBLIC_QUOTE_STOCK=Xsc9qvGR1efVDFGLrVsmkzv3qi45LTBjeUKSPmx9qEh
```
Storage stays as configured (`COMETAIL_STORAGE_PROVIDER=r2`, `COMETAIL_MEDIA_ORIGIN`,
`COMETAIL_APP_ORIGIN=https://cometail.fun`, `R2_BUCKET`, `R2_ACCOUNT_ID`, `R2_ACCESS_KEY_ID`,
`R2_SECRET_ACCESS_KEY`, server-side only). Redeploy. `/api/metadata` answers ready with the
new build; the Devnet badge is gone; `/presets` shows six cards with the mainnet addresses.

## 8. Acceptance before users (team)
Empty state, right after step 7 and before any launch: `/api/tokens` answers the envelope
with `cluster: "mainnet-beta"` and an empty list; `/api/metrics` answers totals of zero;
the feed socket answers hello with `cluster: "mainnet-beta"`; `/presets` shows six cards
with the mainnet addresses; the Devnet badge is gone. A token page of a mint that is not
ours reads "not indexed yet", which is correct.
After the first launch of step 9: that token's page reads from the API (not "not indexed
yet"), its first buy appears on the feed and in its trade history, and `/api/metrics`
counts one plain launch.

## 9. First launches (team, labelled demo in `COMETAIL_DEMO_ACTORS`)
One plain launch with a logo and links from the site, one buy, one claim; one vault deposit,
launch, and a harvest after the first fees; one launch on the USDC preset. Each receipt goes
on the checklist.

## Rollback
Site: promote the previous Vercel deployment. Worker: restore the devnet `worker.env` with
its own `DATABASE_URL`, `COMETAIL_CLUSTER` and RPC, then restart; never run a mainnet RPC
against the devnet database or the reverse. The program and the configs stay; nothing in
them depends on the site or the worker.
