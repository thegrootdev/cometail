// The Sky: every DBC pool on the cluster (or every pool of the configured configs), joined to
// its config and classified the way the program would classify it at deposit: custody of the
// creator rights, eligibility (docs/architecture.md, "Eligibility"), progress, the creator's
// claimable backlog and realized curve income. For migrated pools, every permanently locked
// DAMM v2 position is a row of its own: its NFT holder, custody, pending quote fees and whether
// the size rule would admit it (PLAN 8.1: creators and position-NFT owners ranked by claimable
// backlog). The scan is the lead list.
import { Connection, PublicKey } from "@solana/web3.js";
import { NATIVE_MINT, TOKEN_2022_PROGRAM_ID, TOKEN_PROGRAM_ID, unpackMint, getExtensionTypes, ExtensionType } from "@solana/spl-token";
import { AccountLayout } from "@solana/spl-token";
import { derivePositionNftAccount, getUnClaimLpFee } from "@meteora-ag/cp-amm-sdk";
import { Chain, DAMM_V2_MIGRATION_CONFIGS, DAMM_V2_PROGRAM_ID, DBC_PROGRAM_ID } from "./chain";
import { SkyRow, Store } from "./store";
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

/** The program's size rule for an external position (docs/architecture.md, "Eligibility"): A = the
 *  position's permanent liquidity, T = the pool's permanent total, C and P = the config's creator and
 *  partner percentages. C > P: 2A >= T; C <= P: 2A(C+P) >= TC; every external position: 8A(C+P) <= 9TC. */
export function positionSizeOk(a: bigint, t: bigint, c: bigint, p: bigint): boolean {
  if (t === 0n || a === 0n) return false;
  const lower = c > p ? 2n * a >= t : 2n * a * (c + p) >= t * c;
  const upper = 8n * a * (c + p) <= 9n * t * c;
  return lower && upper;
}

/** Realized income per stream key (the stream's recorded pool) and per stream address from this
 *  protocol's harvest events, in the last `days`. */
async function realizedByPool(store: Store | null, days: number, byStream?: Map<string, bigint>): Promise<Map<string, bigint>> {
  const out = new Map<string, bigint>();
  if (!store) return out;
  // each stream has one canonical key, the pool it recorded (the DBC pool for rights, the DAMM v2
  // pool for positions), so every harvest event lands on exactly one key; a Sky row then reads its
  // DBC pool key plus its derived DAMM v2 pool key, which are disjoint sets of streams
  const streams = await store.listAllStreams();
  const keyOfStream = new Map(streams.map((s) => [s.stream, String(s.data.pool)]));
  const since = Math.floor(Date.now() / 1000) - days * 86_400;
  for (const e of await store.listEventsSince(["harvested", "oneTimeHarvested"], since)) {
    const k = keyOfStream.get(String(e.data.stream));
    if (k) out.set(k, (out.get(k) ?? 0n) + BigInt(e.data.gross ?? 0));
    if (byStream) { const st = String(e.data.stream); byStream.set(st, (byStream.get(st) ?? 0n) + BigInt(e.data.gross ?? 0)); }
  }
  return out;
}

/** Every position of a DAMM v2 pool, with its NFT account. */
async function positionsOf(chain: Chain, pool: PublicKey): Promise<{ position: PublicKey; nftAccount: PublicKey; state: any }[]> {
  const disc = chain.damm.coder.accounts.memcmp("position") as { offset: number; bytes: string };
  const found = await chain.connection.getProgramAccounts(DAMM_V2_PROGRAM_ID, { commitment: "confirmed", filters: [{ memcmp: disc }, { memcmp: { offset: 8, bytes: pool.toBase58() } }] });
  return found.map((a) => { const state = chain.damm.coder.accounts.decode("position", a.account.data); return { position: a.pubkey, nftAccount: derivePositionNftAccount(state.nftMint), state }; });
}

/** One scan. `configs` empty means every pool the program owns. With a store, realized income
 *  comes from the indexed harvest events of the vaults that hold the streams. */
export async function scanSky(chain: Chain, configs: PublicKey[], store: Store | null = null): Promise<SkyRow[]> {
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
  const s7 = new Map<string, bigint>(), s30 = new Map<string, bigint>();
  const [r7, r30] = await Promise.all([realizedByPool(store, 7, s7), realizedByPool(store, 30, s30)]);
  const vaultOfPool = new Map<string, string>();
  // a vault's stream record per registered position: realized income and custody for position rows
  const streamOfPosition = new Map<string, { stream: string; vault: string }>();
  if (store) for (const s of await store.listAllStreams()) { vaultOfPool.set(String(s.data.pool), s.vault); if (s.data.position) streamOfPosition.set(String(s.data.position), { stream: s.stream, vault: s.vault }); }
  const rows: SkyRow[] = [];
  const positionWork: { curve: { pubkey: PublicKey; state: any }; cfg: any; quoteMint: PublicKey; dammPool: string; configReasons: string[] }[] = [];
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
    // the program floors the creator share per trade (dbc/state/config.rs:1014-1027), so this
    // aggregate is at most one lamport per trade above the true accrual: an estimate, labelled so
    const creatorTotal = (tradingFee * BigInt(creatorFeePct)) / 100n;
    const realized = creatorTotal > claimable ? creatorTotal - claimable : 0n;
    const option = cfg ? Number(cfg.migrationFeeOption) : -1;
    const dammPool = cfg && option >= 0 && option < DAMM_V2_MIGRATION_CONFIGS.length ? derivePool(DAMM_V2_MIGRATION_CONFIGS[option], s.baseMint, quoteMint).toBase58() : null;
    // the config reasons also govern the pool's positions; the progress reason is the curve's own
    if (progress === 3 && dammPool) positionWork.push({ curve: p, cfg, quoteMint, dammPool, configReasons: reasons.filter((r) => !r.includes("waiting for migration")) });
    const poolKey = p.pubkey.toBase58();
    const held = vaultOfPool.get(poolKey) ?? (dammPool ? vaultOfPool.get(dammPool) : undefined) ?? null;
    const realizedOf = (m: Map<string, bigint>) => (m.get(poolKey) ?? 0n) + (dammPool && dammPool !== poolKey ? m.get(dammPool) ?? 0n : 0n);
    rows.push({
      pool: p.pubkey.toBase58(), config: s.config.toBase58(), baseMint: s.baseMint.toBase58(), quoteMint: quoteMint.toBase58(), creator: s.creator.toBase58(), custody,
      progress, eligible: reasons.length === 0, reasons, creatorPct: cfg ? Number(cfg.creatorPermanentLockedLiquidityPercentage) : 0, partnerPct: cfg ? Number(cfg.partnerPermanentLockedLiquidityPercentage) : 0, creatorFeePct,
      claimableLamports: claimable.toString(), realizedEstimateLamports: realized.toString(),
      realized7dLamports: held ? realizedOf(r7).toString() : null, realized30dLamports: held ? realizedOf(r30).toString() : null, vault: held,
      tradingFeeLamports: tradingFee.toString(), dammPool: progress === 3 ? dammPool : null, updatedAt: now,
    });
  }
  // position rows of the migrated pools
  let positions = 0;
  for (const w of positionWork) {
    try {
      const poolKey = new PublicKey(w.dammPool);
      const poolState: any = await chain.dammPool(poolKey);
      if (!poolState) continue;
      const found = (await positionsOf(chain, poolKey)).filter((x) => BigInt(x.state.permanentLockedLiquidity.toString()) > 0n);
      if (!found.length) continue;
      const nftInfos = await accounts(conn, found.map((x) => x.nftAccount));
      const holders = new Map<string, PublicKey>();
      for (const x of found) { const info = nftInfos.get(x.nftAccount.toBase58()); if (info) holders.set(x.position.toBase58(), new PublicKey(AccountLayout.decode(info.data).owner)); }
      const holderInfos = await accounts(conn, [...new Set([...holders.values()].map((h) => h.toBase58()))].map((k) => new PublicKey(k)));
      const quoteIsB = (poolState.tokenBMint as PublicKey).equals(w.quoteMint);
      const total = BigInt(poolState.permanentLockLiquidity.toString());
      const c = BigInt(Number(w.cfg.creatorPermanentLockedLiquidityPercentage)), pp = BigInt(Number(w.cfg.partnerPermanentLockedLiquidityPercentage));
      for (const x of found) {
        const holder = holders.get(x.position.toBase58());
        const holderInfo = holder ? holderInfos.get(holder.toBase58()) : undefined;
        const custody: SkyRow["custody"] = !holder || !holderInfo ? "unknown" : holderInfo.owner.equals(new PublicKey("11111111111111111111111111111111")) ? "wallet" : "program";
        const a = BigInt(x.state.permanentLockedLiquidity.toString());
        const reasons = [...w.configReasons];
        if (custody !== "wallet") reasons.push(custody === "program" ? "position NFT held by a program" : "position NFT holder unknown");
        if (!positionSizeOk(a, total, c, pp)) reasons.push("position outside the size rule");
        let pending = 0n;
        try { const f = getUnClaimLpFee(poolState, x.state); pending = BigInt((quoteIsB ? f.feeTokenB : f.feeTokenA).toString()); } catch { reasons.push("pending fees unreadable"); }
        const claimedQuote = BigInt((quoteIsB ? x.state.metrics?.totalClaimedBFee : x.state.metrics?.totalClaimedAFee)?.toString() ?? "0");
        const rec = streamOfPosition.get(x.position.toBase58()) ?? null;
        const curve = w.curve.state;
        rows.push({
          pool: x.position.toBase58(), config: curve.config.toBase58(), baseMint: curve.baseMint.toBase58(), quoteMint: w.quoteMint.toBase58(),
          creator: holder ? holder.toBase58() : "", owner: holder ? holder.toBase58() : "", custody, progress: 3, eligible: reasons.length === 0, reasons,
          creatorPct: Number(c), partnerPct: Number(pp), creatorFeePct: Number(w.cfg.creatorTradingFeePercentage),
          claimableLamports: pending.toString(), realizedEstimateLamports: claimedQuote.toString(),
          realized7dLamports: rec ? (s7.get(rec.stream) ?? 0n).toString() : null, realized30dLamports: rec ? (s30.get(rec.stream) ?? 0n).toString() : null, vault: rec ? rec.vault : null,
          tradingFeeLamports: "0", dammPool: w.dammPool, updatedAt: now,
          kind: "position", position: x.position.toBase58(), lockedSharePct: total > 0n ? Number((a * 10_000n) / total) / 100 : 0,
        });
        positions++;
      }
    } catch (e) { log("sky positions failed", { pool: w.dammPool, error: String((e as Error).message ?? e) }); }
  }
  log("sky scan", { pools: rows.length - positions, positions, eligible: rows.filter((r) => r.eligible).length, configs: configs.length || "all" });
  return rows;
}
