// The keeper pass. Everything here is either permissionless (migration, registration,
// harvests, crossed-bin settlement) or bounded by the program's policy (route, resting-bin
// settlement). Order of work per vault: migrate -> register positions -> cash out -> harvest
// -> settle -> route. Each write is simulated first; a rejected simulation is logged and skipped.
import { BN } from "@coral-xyz/anchor";
import { NATIVE_MINT, TOKEN_2022_PROGRAM_ID, TOKEN_PROGRAM_ID } from "@solana/spl-token";
import { Keypair, PublicKey, SystemProgram } from "@solana/web3.js";
import { DBC_POOL_AUTHORITY, deriveStream } from "@cometail/client";
import { derivePositionAddress, derivePositionNftAccount } from "@meteora-ag/cp-amm-sdk";
import {
  deriveDammV2EventAuthority, deriveDammV2MigrationMetadataAddress, deriveDammV2PoolAddress, deriveDammV2PoolAuthority,
  deriveDammV2TokenVaultAddress, deriveDbcTokenVaultAddress,
} from "@meteora-ag/dynamic-bonding-curve-sdk";
import { Chain, DAMM_V2_MIGRATION_CONFIGS, DAMM_V2_PROGRAM_ID, DBC_PROGRESS, Decoded, big, bn, isDefault } from "./chain";
import { Config } from "./config";
import { binsForSpread, buildLadder, isCrossed } from "./ladder";
import { log, sendTx, simulateEvents } from "./tx";
import { LookupTables } from "./lut";
import { alert } from "./alert";
import { dlmmBinArray } from "@cometail/client";

export interface KeeperContext { chain: Chain; cfg: Config; keeper: Keypair; luts: LookupTables }

/** Above this many bins the ladder needs a v0 transaction with the vault's lookup table. */
const LEGACY_BIN_LIMIT = 12;

const STATUS = (v: any): "open" | "launched" | "live" => Object.keys(v.status)[0] as any;
const KIND = (s: any): "dbcCreatorRights" | "dammV2Position" => Object.keys(s.kind)[0] as any;

export async function keeperPass(ctx: KeeperContext): Promise<void> {
  const { chain } = ctx;
  const protocol = await chain.protocol();
  const vaults = await chain.vaults();
  log("keeper pass", { vaults: vaults.length, pausedRouting: protocol.pausedRouting });
  for (const v of vaults) {
    try {
      await vaultPass(ctx, protocol, v);
    } catch (e) {
      log("vault pass failed", { vault: v.pubkey, error: String((e as Error).message ?? e) });
      await alert("error", "vault pass failed", { vault: v.pubkey, error: String((e as Error).message ?? e) });
    }
  }
}

async function vaultPass(ctx: KeeperContext, protocol: any, entry: Decoded): Promise<void> {
  const { chain, cfg, keeper } = ctx;
  let vault = entry.account;
  const vaultPk = entry.pubkey;
  const status = STATUS(vault);
  if (status === "open") return; // nothing to do until the depositor launches

  // 1. the vault's own curve: migrate when the curve is complete, then register and cash out
  const ownPool = await chain.dbcPool(vault.dbcPool);
  if (ownPool) {
    // the presets carry no vesting, so a complete curve (PostBondingCurve) migrates directly; a
    // config with vesting would sit in LockedVesting after its locker and migrate from there
    if (ownPool.migrationProgress === DBC_PROGRESS.postBonding || ownPool.migrationProgress === DBC_PROGRESS.lockedVesting) {
      await migrate(ctx, vault.dbcPool, ownPool);
    }
    const after = await chain.dbcPool(vault.dbcPool);
    if (after && after.migrationProgress === DBC_PROGRESS.createdPool && isDefault(vault.ownPosition)) {
      const mine = await chain.positionsOwnedBy(vault.dammPool, vaultPk);
      if (mine.length > 0) {
        const ix = await chain.client.registerOwnPosition({
          vault: vaultPk, payer: keeper.publicKey, streamIndex: vault.streamCount, dbcPool: vault.dbcPool, dbcConfig: vault.dbcConfig,
          dammPool: vault.dammPool, position: mine[0].position, nftAccount: mine[0].nftAccount,
        });
        await sendTx({ connection: chain.connection, payer: keeper, ixs: [ix], cu: 400_000, cuPrice: cfg.cuPriceMicroLamports, parser: chain.events, dryRun: cfg.dryRun, label: `register_own_position ${vaultPk.toBase58()}` });
        vault = (await chain.vault(vaultPk)) ?? vault;
      }
    }
    if (after && after.migrationProgress === DBC_PROGRESS.createdPool && big(vault.accounting.cashedOut) === 0n) {
      const ix = await chain.client.cashout({ vault: vaultPk, dbcPool: vault.dbcPool, dbcConfig: vault.dbcConfig, quoteVault: deriveDbcTokenVaultAddress(vault.dbcPool, NATIVE_MINT), depositorWsol: vault.depositorWsol });
      await sendTx({ connection: chain.connection, payer: keeper, ixs: [ix], cu: 400_000, cuPrice: cfg.cuPriceMicroLamports, parser: chain.events, dryRun: cfg.dryRun, label: `cashout ${vaultPk.toBase58()}` });
      vault = (await chain.vault(vaultPk)) ?? vault;
    }
  }

  // 2. streams: register migrated creator positions, then harvest whatever clears the dust line
  const streams = await chain.streams(vaultPk);
  for (const s of streams) await streamPass(ctx, protocol, vaultPk, vault, s);

  // 3. orders: settle crossed bins; cancel stale resting bins
  vault = (await chain.vault(vaultPk)) ?? vault;
  if (!isDefault(vault.dlmmPair)) {
    const pair = await chain.lbPair(vault.dlmmPair);
    if (pair) {
      await settlePass(ctx, vaultPk, vault, pair);
      // 4. route idle income into a fresh ladder
      if (!protocol.pausedRouting) {
        vault = (await chain.vault(vaultPk)) ?? vault;
        await routePass(ctx, vaultPk, vault, pair);
      }
    }
  }
}

async function migrate(ctx: KeeperContext, poolPk: PublicKey, pool: any): Promise<void> {
  const { chain, cfg, keeper } = ctx;
  const config = await chain.dbcConfig(pool.config);
  if (!config) return;
  const option = Number(config.migrationFeeOption);
  const dammConfig = DAMM_V2_MIGRATION_CONFIGS[option];
  if (!dammConfig) { log("unknown migration fee option", { pool: poolPk, option }); return; }
  const metadata = deriveDammV2MigrationMetadataAddress(poolPk);
  const ixs = [] as any[];
  if (!(await chain.connection.getAccountInfo(metadata))) {
    ixs.push(await chain.dbc.methods.migrationDammV2CreateMetadata().accountsPartial({
      virtualPool: poolPk, config: pool.config, migrationMetadata: metadata, payer: keeper.publicKey, systemProgram: SystemProgram.programId,
    }).instruction());
  }
  const quoteMint: PublicKey = config.quoteMint;
  const dammPool = deriveDammV2PoolAddress(dammConfig, pool.baseMint, quoteMint);
  const first = Keypair.generate(); const second = Keypair.generate();
  ixs.push(await chain.dbc.methods.migrationDammV2().accountsPartial({
    virtualPool: poolPk, migrationMetadata: metadata, config: pool.config, poolAuthority: DBC_POOL_AUTHORITY, pool: dammPool,
    firstPositionNftMint: first.publicKey, firstPositionNftAccount: derivePositionNftAccount(first.publicKey), firstPosition: derivePositionAddress(first.publicKey),
    secondPositionNftMint: second.publicKey, secondPositionNftAccount: derivePositionNftAccount(second.publicKey), secondPosition: derivePositionAddress(second.publicKey),
    dammPoolAuthority: deriveDammV2PoolAuthority(), ammProgram: DAMM_V2_PROGRAM_ID, baseMint: pool.baseMint, quoteMint,
    tokenAVault: deriveDammV2TokenVaultAddress(dammPool, pool.baseMint), tokenBVault: deriveDammV2TokenVaultAddress(dammPool, quoteMint),
    baseVault: pool.baseVault, quoteVault: pool.quoteVault, payer: keeper.publicKey, tokenBaseProgram: TOKEN_PROGRAM_ID, tokenQuoteProgram: TOKEN_PROGRAM_ID,
    token2022Program: TOKEN_2022_PROGRAM_ID, dammEventAuthority: deriveDammV2EventAuthority(), systemProgram: SystemProgram.programId,
  }).remainingAccounts([{ pubkey: dammConfig, isSigner: false, isWritable: false }]).instruction());
  await sendTx({ connection: chain.connection, payer: keeper, ixs, signers: [first, second], cu: 600_000, cuPrice: cfg.cuPriceMicroLamports, dryRun: cfg.dryRun, label: `migrate ${poolPk.toBase58()}` });
}

async function streamPass(ctx: KeeperContext, protocol: any, vaultPk: PublicKey, vault: any, entry: Decoded): Promise<void> {
  const { chain, cfg, keeper } = ctx;
  const s = entry.account;
  const streamPk = entry.pubkey;
  const kind = KIND(s);
  const common = { vault: vaultPk, stream: streamPk, incomeWsol: vault.incomeWsol, placeholderWsol: vault.placeholderWsol, depositorWsol: vault.depositorWsol, treasury: protocol.treasury };
  const sendIfWorthIt = async (ix: any, label: string, minGross: bigint) => {
    const sim = await simulateEvents({ connection: chain.connection, payer: keeper.publicKey, ixs: [ix], parser: chain.events, cu: 500_000 });
    if (!sim.ok) { log(`${label}: not claimable now`, { error: sim.error }); return; }
    // the coder reports event names in camelCase (harvested, oneTimeHarvested)
    const ev = sim.events.find((e) => /^(one[Tt]ime)?[Hh]arvested$/.test(e.name));
    const gross = ev ? big(ev.data.gross as BN) : 0n;
    if (gross < minGross) { log(`${label}: below dust`, { gross, dust: minGross }); return; }
    await sendTx({ connection: chain.connection, payer: keeper, ixs: [ix], cu: 500_000, cuPrice: cfg.cuPriceMicroLamports, parser: chain.events, dryRun: cfg.dryRun, label });
  };

  if (kind === "dbcCreatorRights") {
    const pool = await chain.dbcPool(s.pool);
    if (!pool) return;
    // external curves migrate on their own; the creator position then registers permissionlessly
    if (!s.isOwn && pool.migrationProgress === DBC_PROGRESS.createdPool && isDefault(s.position)) {
      const mine = await chain.positionsOwnedBy(s.derivedDammPool, vaultPk);
      if (mine.length > 0) {
        const ix = await chain.client.registerStreamPosition({ vault: vaultPk, stream: streamPk, payer: keeper.publicKey, dbcPool: s.pool, dbcConfig: s.config, dammPool: s.derivedDammPool, position: mine[0].position, nftAccount: mine[0].nftAccount });
        await sendTx({ connection: chain.connection, payer: keeper, ixs: [ix], cu: 400_000, cuPrice: cfg.cuPriceMicroLamports, parser: chain.events, dryRun: cfg.dryRun, label: `register_stream_position ${streamPk.toBase58()}` });
      }
    }
    // creator trading fees accrue while the curve trades and stay claimable after
    const baseTokenProgram = (await chain.accountOwner(pool.baseMint)) ?? TOKEN_PROGRAM_ID;
    const dbcIx = await chain.client.harvestDbc({ ...common, dbcPool: s.pool, baseVault: pool.baseVault, quoteVault: pool.quoteVault, baseMint: pool.baseMint, baseTokenProgram });
    await sendIfWorthIt(dbcIx, `harvest_dbc ${streamPk.toBase58()}`, cfg.dustLamports);
    // one-time claims (migration fee, surplus) for external curves, once, after migration
    if (!s.isOwn && pool.migrationProgress === DBC_PROGRESS.createdPool && (Number(s.oneTimeClaims) & 3) !== 3) {
      const ix = await chain.client.harvestOneTime({ ...common, dbcPool: s.pool, dbcConfig: s.config, quoteVault: pool.quoteVault });
      await sendIfWorthIt(ix, `harvest_one_time ${streamPk.toBase58()}`, 0n);
    }
  }

  // the registered or deposited DAMM v2 position
  const position: PublicKey = s.position;
  if (!isDefault(position)) {
    const dammPoolPk: PublicKey = s.derivedDammPool; // the deposited pool for position streams, the derived pool for DBC rights
    const pool = await chain.dammPool(dammPoolPk);
    if (!pool) return;
    const tokenAProgram = (await chain.accountOwner(pool.tokenAMint)) ?? TOKEN_PROGRAM_ID;
    const ix = await chain.client.harvestPosition({ ...common, dammPool: dammPoolPk, position, nftAccount: s.nftAccount, tokenAVault: pool.tokenAVault, tokenBVault: pool.tokenBVault, tokenAMint: pool.tokenAMint, tokenAProgram });
    await sendIfWorthIt(ix, `harvest_position ${streamPk.toBase58()}`, cfg.dustLamports);
  }
}

async function settlePass(ctx: KeeperContext, vaultPk: PublicKey, vault: any, pair: any): Promise<void> {
  const { chain, cfg, keeper } = ctx;
  const records = await chain.orderRecords(vaultPk);
  const now = Math.floor(Date.now() / 1000);
  const stAta: PublicKey = vault.stAta;
  for (const r of records) {
    const order = await chain.limitOrder(r.account.limitOrder);
    if (!order) { log("order record without an order; settle will close it", { record: r.pubkey }); continue; }
    const live = order.bins.filter((b) => b.amount > 0n);
    if (live.length === 0) continue;
    const crossed = live.filter((b) => isCrossed(b.id, b.isAsk, pair.activeId)).map((b) => b.id);
    const stale = now - Number(r.account.placedTs) > cfg.staleOrderSeconds;
    const bins = stale ? live.map((b) => b.id) : crossed;
    if (bins.length === 0) continue;
    bins.sort((a, b) => a - b);
    const ix = await chain.client.settle({ vault: vaultPk, signer: keeper.publicKey, lbPair: vault.dlmmPair, reserveX: pair.reserveX, reserveY: pair.reserveY, limitOrder: r.account.limitOrder, incomeWsol: vault.incomeWsol, stAta, stMint: vault.stMint, bins });
    const lookupTable = bins.length > LEGACY_BIN_LIMIT ? await ctx.luts.ensure(vaultPk, [...new Set(bins.map((b) => dlmmBinArray(vault.dlmmPair, b).toBase58()))].map((k) => new PublicKey(k))) : null;
    if (bins.length > LEGACY_BIN_LIMIT && !lookupTable) { log("settle: lookup table not ready; next pass", { vault: vaultPk }); continue; }
    await sendTx({ connection: chain.connection, payer: keeper, ixs: [ix], cu: 600_000, cuPrice: cfg.cuPriceMicroLamports, parser: chain.events, dryRun: cfg.dryRun, lookupTable, label: `settle ${stale ? "stale" : "crossed"} ${r.account.limitOrder.toBase58()} bins=${bins.length}` });
  }
}

async function routePass(ctx: KeeperContext, vaultPk: PublicKey, vault: any, pair: any): Promise<void> {
  const { chain, cfg, keeper } = ctx;
  const policy = vault.policy;
  const routing = vault.routing;
  if (Number(routing.outstandingOrders) >= Number(policy.maxOutstandingOrders)) return;
  const income = await chain.tokenBalance(vault.incomeWsol);
  if (income < cfg.minRouteLamports) return;
  const periodSeconds = big(policy.periodSeconds);
  const period = periodSeconds > 0n ? BigInt(Math.floor(Date.now() / 1000)) / periodSeconds : 0n;
  const spent = big(routing.periodIndex) === period ? big(routing.spentThisPeriod) : 0n;
  const periodLeft = big(policy.maxSpendPerPeriod) - spent;
  let budget = income < periodLeft ? income : periodLeft;
  if (budget > cfg.maxRouteLamports) budget = cfg.maxRouteLamports;
  if (budget < cfg.minRouteLamports) { log("route: period budget exhausted", { vault: vaultPk, periodLeft }); return; }
  const binStep = Number(pair.binStep);
  const bins = buildLadder({
    activeId: pair.activeId, stIsX: vault.stIsX, binBound: vault.binBound, budget, bins: Math.min(cfg.ladderBins, Number(policy.maxBinsPerOrder)), decay: cfg.ladderDecay,
    nearOffset: binsForSpread(cfg.ladderNearBps, binStep), farOffset: binsForSpread(cfg.ladderFarBps, binStep),
  });
  if (bins.length === 0) { log("route: no bins inside the cap", { vault: vaultPk, active: pair.activeId, bound: vault.binBound }); return; }
  const reserve: PublicKey = vault.stIsX ? pair.reserveY : pair.reserveX;
  const r = await chain.client.route({ vault: vaultPk, keeper: keeper.publicKey, lbPair: vault.dlmmPair, reserve, incomeWsol: vault.incomeWsol, bins: bins.map((b) => ({ id: b.id, amount: bn(b.amount) })) });
  let lookupTable = null as Awaited<ReturnType<LookupTables["ensure"]>>;
  if (bins.length > LEGACY_BIN_LIMIT) {
    const statics = [chain.client.protocol, vaultPk, vault.dlmmPair, reserve, vault.incomeWsol, vault.stAta, vault.stMint, pair.reserveX, pair.reserveY];
    const arrays = [...new Set(bins.map((b) => dlmmBinArray(vault.dlmmPair, b.id).toBase58()))].map((k) => new PublicKey(k));
    lookupTable = await ctx.luts.ensure(vaultPk, [...statics, ...arrays]);
    if (!lookupTable) { log("route: lookup table not ready; next pass", { vault: vaultPk }); return; }
  }
  await sendTx({ connection: chain.connection, payer: keeper, ixs: [r.ix], signers: [r.limitOrder], cu: 600_000, cuPrice: cfg.cuPriceMicroLamports, parser: chain.events, dryRun: cfg.dryRun, lookupTable, label: `route ${vaultPk.toBase58()} gross=${budget} bins=${bins.length}` });
}
