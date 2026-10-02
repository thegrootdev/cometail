// The Sky: every DBC pool on the cluster (or every pool of the configured configs), joined to
// its config and classified the way the program would classify it at deposit: custody of the
// creator rights, eligibility (docs/architecture.md, "Eligibility"), progress, the creator's
// claimable backlog and realized curve income. Positions of migrated pools are left to the
// vault pages; the scan is the lead list.
import { Connection, PublicKey } from "@solana/web3.js";
import { NATIVE_MINT, TOKEN_2022_PROGRAM_ID, TOKEN_PROGRAM_ID, unpackMint, getExtensionTypes, ExtensionType } from "@solana/spl-token";
import { Chain, DAMM_V2_MIGRATION_CONFIGS, DBC_PROGRAM_ID } from "./chain";
import { SkyRow } from "./store";
import { log } from "./tx";

/** Byte offsets inside a `VirtualPool` account (8-byte discriminator, then `PoolState`). */
const VIRTUAL_POOL_CONFIG_OFFSET = 72;
const DAMM_V2_PROGRAM = new PublicKey("cpamdpZCGKUy5JxQXB4dcpGPiikHawvSWAd6mEn1sGG");

function derivePool(config: PublicKey, mintA: PublicKey, mintB: PublicKey): PublicKey {
  const [lo, hi] = mintA.toBuffer().compare(mintB.toBuffer()) < 0 ? [mintA, mintB] : [mintB, mintA];
  return PublicKey.findProgramAddressSync([Buffer.from("pool"), config.toBuffer(), hi.toBuffer(), lo.toBuffer()], DAMM_V2_PROGRAM)[0];
}

async function accounts(connection: Connection, keys: PublicKey[]) {
  const out = new Map<string, Awaited<ReturnType<Connection["getAccountInfo"]>>>();
  for (let i = 0; i < keys.length; i += 100) {
    const chunk = keys.slice(i, i + 100);
    const infos = await connection.getMultipleAccountsInfo(chunk, "confirmed");
    chunk.forEach((k, j) => out.set(k.toBase58(), infos[j]));
  }
  return out;
}

/** One scan. `configs` empty means every pool the program owns. */
export async function scanSky(chain: Chain, configs: PublicKey[]): Promise<SkyRow[]> {
  const conn = chain.connection;
  const disc = chain.dbc.coder.accounts.memcmp("virtualPool") as { offset: number; bytes: string };
  const filters = configs.length ? configs.map((c) => [{ memcmp: disc }, { memcmp: { offset: VIRTUAL_POOL_CONFIG_OFFSET, bytes: c.toBase58() } }]) : [[{ memcmp: disc }]];
  const pools: { pubkey: PublicKey; state: any }[] = [];
  for (const f of filters) {
    const found = await conn.getProgramAccounts(DBC_PROGRAM_ID, { commitment: "confirmed", filters: f });
    for (const a of found) pools.push({ pubkey: a.pubkey, state: chain.dbc.coder.accounts.decode("virtualPool", a.account.data).poolState });
  }
  const configKeys = [...new Set(pools.map((p) => p.state.config.toBase58()))].map((k) => new PublicKey(k));
  const configInfos = await accounts(conn, configKeys);
  const configMap = new Map<string, any>();
  for (const [k, info] of configInfos) if (info) configMap.set(k, chain.dbc.coder.accounts.decode("poolConfig", info.data));
  const creatorInfos = await accounts(conn, [...new Set(pools.map((p) => p.state.creator.toBase58()))].map((k) => new PublicKey(k)));
  const mintInfos = await accounts(conn, pools.map((p) => p.state.baseMint as PublicKey));
  const now = Date.now();
  const rows: SkyRow[] = [];
  for (const p of pools) {
    const s = p.state;
    const cfg = configMap.get(s.config.toBase58());
    const reasons: string[] = [];
    if (!cfg) reasons.push("config missing");
    const quoteMint: PublicKey = cfg ? cfg.quoteMint : PublicKey.default;
    const creatorInfo = creatorInfos.get(s.creator.toBase58());
    const custody: SkyRow["custody"] = !creatorInfo ? "unknown" : creatorInfo.owner.equals(new PublicKey("11111111111111111111111111111111")) ? "wallet" : "program";
    const progress = Number(s.migrationProgress);
    if (cfg) {
      if (!quoteMint.equals(NATIVE_MINT)) reasons.push("quote is not WSOL");
      if (Number(cfg.collectFeeMode) !== 0) reasons.push("fees not collected in quote");
      if (Number(cfg.migrationOption) !== 1) reasons.push("not a DAMM v2 migration");
      if (![0, 2].includes(Number(cfg.migratedCollectFeeMode))) reasons.push("migrated pool collects fees in both tokens");
      if (Number(cfg.creatorPermanentLockedLiquidityPercentage) === 0) reasons.push("creator liquidity not permanently locked");
      if (Number(cfg.creatorLiquidityPercentage) !== 0) reasons.push("creator liquidity migrates unlocked");
      if (Number(cfg.creatorLiquidityVestingInfo?.vestingPercentage ?? 0) !== 0) reasons.push("creator liquidity vests");
      if (Number(cfg.migrationFeeOption) > 6) reasons.push("unknown migration fee option");
    }
    if (![0, 3].includes(progress)) reasons.push(progress === 1 ? "curve complete, waiting for migration" : "locked vesting, waiting for migration");
    const mintInfo = mintInfos.get(s.baseMint.toBase58());
    if (!mintInfo) reasons.push("base mint missing");
    else {
      try {
        const mint = unpackMint(s.baseMint, mintInfo, mintInfo.owner.equals(TOKEN_2022_PROGRAM_ID) ? TOKEN_2022_PROGRAM_ID : TOKEN_PROGRAM_ID);
        if (mint.freezeAuthority) reasons.push("base mint has a freeze authority");
        if (mintInfo.owner.equals(TOKEN_2022_PROGRAM_ID)) {
          const bad = getExtensionTypes(mint.tlvData).filter((e) => e !== ExtensionType.MetadataPointer && e !== ExtensionType.TokenMetadata);
          if (bad.length) reasons.push("base mint has non-metadata extensions");
        }
      } catch { reasons.push("base mint unreadable"); }
    }
    const creatorFeePct = cfg ? Number(cfg.creatorTradingFeePercentage) : 0;
    const tradingFee = BigInt(s.metrics?.totalTradingQuoteFee?.toString() ?? "0");
    const claimable = BigInt(s.creatorQuoteFee?.toString() ?? "0");
    const creatorTotal = (tradingFee * BigInt(creatorFeePct)) / 100n;
    const realized = creatorTotal > claimable ? creatorTotal - claimable : 0n;
    const option = cfg ? Number(cfg.migrationFeeOption) : -1;
    const dammPool = cfg && option >= 0 && option < DAMM_V2_MIGRATION_CONFIGS.length ? derivePool(DAMM_V2_MIGRATION_CONFIGS[option], s.baseMint, quoteMint).toBase58() : null;
    rows.push({
      pool: p.pubkey.toBase58(), config: s.config.toBase58(), baseMint: s.baseMint.toBase58(), quoteMint: quoteMint.toBase58(), creator: s.creator.toBase58(), custody,
      progress, eligible: reasons.length === 0, reasons, creatorPct: cfg ? Number(cfg.creatorPermanentLockedLiquidityPercentage) : 0, partnerPct: cfg ? Number(cfg.partnerPermanentLockedLiquidityPercentage) : 0, creatorFeePct,
      claimableLamports: claimable.toString(), realizedLamports: realized.toString(), tradingFeeLamports: tradingFee.toString(), dammPool: progress === 3 ? dammPool : null, updatedAt: now,
    });
  }
  log("sky scan", { pools: rows.length, eligible: rows.filter((r) => r.eligible).length, configs: configs.length || "all" });
  return rows;
}
