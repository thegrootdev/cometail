// The token index behind /api/tokens: one row per launch in scope (every DBC pool of the Sky's
// configs), with identity from the mint's metadata, the live price from the pool it trades on,
// supply from the mint, bonding progress from the DBC pool and its config, holders from a full
// read of the mint's token accounts, and 24 h volume from the trade index. Unknown is null.
import { Connection, PublicKey } from "@solana/web3.js";
import { TOKEN_2022_PROGRAM_ID, TOKEN_PROGRAM_ID, unpackMint, getTokenMetadata } from "@solana/spl-token";
import { Chain, DAMM_V2_PROGRAM_ID, DBC_PROGRAM_ID } from "./chain";
import { SkyRow, Store, TokenRow } from "./store";
import { log } from "./tx";

export const METADATA_PROGRAM_ID = new PublicKey("metaqbxxUerdq28cj1RbAWkYQm3ybzjb6a8bt518x1s");
const SYSTEM = new PublicKey("11111111111111111111111111111111");
/** The two Meteora pool authorities own the pools' own token vaults: not holders. */
const POOL_AUTHORITIES = new Set([PublicKey.findProgramAddressSync([Buffer.from("pool_authority")], DBC_PROGRAM_ID)[0].toBase58(), PublicKey.findProgramAddressSync([Buffer.from("pool_authority")], DAMM_V2_PROGRAM_ID)[0].toBase58()]);
const createdAtCache = new Map<string, number | null>();
/** When the pool was created: its activation point is a slot (activation type 0, resolved to the block time once and cached) or a unix time (type 1). */
async function createdAt(conn: Connection, mint: string, activationType: number, activationPoint: bigint): Promise<number | null> {
  if (createdAtCache.has(mint)) return createdAtCache.get(mint)!;
  let ms: number | null = null;
  try {
    if (activationType === 1) ms = Number(activationPoint) * 1000;
    else { const t = await conn.getBlockTime(Number(activationPoint)); ms = t ? t * 1000 : null; }
  } catch { ms = null; }
  if (ms !== null) createdAtCache.set(mint, ms);
  return ms;
}

/** Q64.64 sqrt price (quote raw per base raw) to a decimal string of SOL per whole token. */
export function sqrtPriceToSolPerToken(sqrtPrice: bigint, baseDecimals: number, quoteDecimals = 9): string {
  // price_raw = sqrt^2 / 2^128; per whole token: x 10^baseDecimals / 10^quoteDecimals; 12 decimals kept
  const scale = 10n ** 12n;
  const num = sqrtPrice * sqrtPrice * 10n ** BigInt(baseDecimals) * scale;
  const den = (1n << 128n) * 10n ** BigInt(quoteDecimals);
  return formatFixed(num / den, 12);
}
export function formatFixed(v: bigint, decimals: number): string {
  const s = v.toString().padStart(decimals + 1, "0");
  const int = s.slice(0, -decimals), frac = s.slice(-decimals).replace(/0+$/, "");
  return frac ? `${int}.${frac}` : int;
}
/** Quote lamports over base raw as SOL per whole token, 12 decimals. */
export function executionPrice(quoteLamports: bigint, baseRaw: bigint, baseDecimals: number): string | null {
  if (baseRaw === 0n) return null;
  return formatFixed((quoteLamports * 10n ** BigInt(baseDecimals) * 10n ** 12n) / (baseRaw * 10n ** 9n), 12);
}

function metadataPda(mint: PublicKey): PublicKey {
  return PublicKey.findProgramAddressSync([Buffer.from("metadata"), METADATA_PROGRAM_ID.toBuffer(), mint.toBuffer()], METADATA_PROGRAM_ID)[0];
}
/** Metaplex token metadata: key, update authority, mint, then name / symbol / uri as borsh strings. */
export function parseMetaplexMetadata(data: Buffer): { name: string; symbol: string; uri: string } | null {
  try {
    let o = 1 + 32 + 32;
    const str = () => { const len = data.readUInt32LE(o); o += 4; const s = data.subarray(o, o + len).toString("utf8").replace(/\0+$/, ""); o += len; return s; };
    return { name: str(), symbol: str(), uri: str() };
  } catch { return null; }
}

export type Links = { x: string | null; telegram: string | null; discord: string | null; website: string | null };
/** Social links as wallets and explorers read them: extensions.{twitter,telegram,discord,website} and external_url; https only. */
export function linksFromMetadata(j: any): Links | null {
  const ext = j && typeof j.extensions === "object" && j.extensions ? j.extensions : {};
  const pick = (...vals: unknown[]) => { for (const v of vals) if (typeof v === "string" && /^https:\/\/[^\s]{4,200}$/.test(v)) return v; return null; };
  const links: Links = { x: pick(ext.twitter, ext.x, j?.twitter), telegram: pick(ext.telegram, j?.telegram), discord: pick(ext.discord, j?.discord), website: pick(ext.website, j?.external_url, j?.website) };
  return Object.values(links).some(Boolean) ? links : null;
}
const metadataJsonCache = new Map<string, { at: number; image: string | null; status: "ok" | "missing" | "unreachable"; links: Links | null }>();
async function imageFromUri(uri: string): Promise<{ image: string | null; status: "ok" | "missing" | "unreachable"; links: Links | null }> {
  if (!/^https?:\/\//.test(uri)) return { image: null, status: "missing", links: null };
  const cached = metadataJsonCache.get(uri);
  if (cached && Date.now() - cached.at < 6 * 3600_000) return cached;
  let out: { image: string | null; status: "ok" | "missing" | "unreachable"; links: Links | null };
  try {
    const r = await fetch(uri, { signal: AbortSignal.timeout(6_000), headers: { accept: "application/json" } });
    const j: any = r.ok ? await r.json() : null;
    const image = j && typeof j.image === "string" && /^https?:\/\//.test(j.image) ? j.image : null;
    out = { image, status: image ? "ok" : "missing", links: linksFromMetadata(j) };
  } catch { out = { image: null, status: "unreachable", links: null }; }
  metadataJsonCache.set(uri, { at: Date.now(), ...out });
  return out;
}

const holdersCache = new Map<string, { at: number; count: number }>();
/** Unique owners of nonzero token accounts of the mint: a full read, cached for ten minutes. */
async function holders(conn: Connection, mint: PublicKey, program: PublicKey): Promise<{ count: number | null; at: number | null }> {
  const k = mint.toBase58();
  const c = holdersCache.get(k);
  if (c && Date.now() - c.at < 10 * 60_000) return { count: c.count, at: c.at };
  try {
    const filters: any[] = [{ memcmp: { offset: 0, bytes: k } }];
    if (program.equals(TOKEN_PROGRAM_ID)) filters.unshift({ dataSize: 165 });
    const accounts = await conn.getProgramAccounts(program, { commitment: "confirmed", filters, dataSlice: { offset: 32, length: 40 } });
    const owners = new Set<string>();
    for (const a of accounts) { const d = a.account.data; if (d.length >= 40 && d.readBigUInt64LE(32) > 0n) { const o = new PublicKey(d.subarray(0, 32)).toBase58(); if (!POOL_AUTHORITIES.has(o)) owners.add(o); } }
    const at = Date.now();
    holdersCache.set(k, { at, count: owners.size });
    return { count: owners.size, at };
  } catch (e) { log("holders read failed", { mint: k, error: String((e as Error).message ?? e) }); return { count: c?.count ?? null, at: c?.at ?? null }; }
}

async function accounts(conn: Connection, keys: PublicKey[]) {
  const out = new Map<string, Awaited<ReturnType<Connection["getAccountInfo"]>>>();
  for (let i = 0; i < keys.length; i += 100) {
    const chunk = keys.slice(i, i + 100);
    const infos = await conn.getMultipleAccountsInfo(chunk, "confirmed");
    chunk.forEach((k, j) => out.set(k.toBase58(), infos[j]));
  }
  return out;
}

/** One pass over the Sky's curve rows: the token rows, with trades of the last 24 h from the store. */
export async function scanTokens(chain: Chain, rows: SkyRow[], store: Store, plainConfigs: Set<string>): Promise<TokenRow[]> {
  const conn = chain.connection;
  const curves = rows.filter((r) => (r.kind ?? "curve") === "curve");
  if (!curves.length) return [];
  const poolKeys = curves.map((r) => new PublicKey(r.pool));
  const mintKeys = curves.map((r) => new PublicKey(r.baseMint));
  const configKeys = [...new Set(curves.map((r) => r.config))].map((k) => new PublicKey(k));
  const dammKeys = curves.filter((r) => r.dammPool).map((r) => new PublicKey(r.dammPool!));
  const [poolInfos, mintInfos, configInfos, dammInfos, metaInfos] = await Promise.all([
    accounts(conn, poolKeys), accounts(conn, mintKeys), accounts(conn, configKeys), accounts(conn, dammKeys), accounts(conn, mintKeys.map(metadataPda)),
  ]);
  const since = Date.now() - 24 * 3600_000;
  const out: TokenRow[] = [];
  const now = Date.now();
  for (const r of curves) {
    try {
      const poolInfo = poolInfos.get(r.pool), mintInfo = mintInfos.get(r.baseMint), cfgInfo = configInfos.get(r.config);
      if (!poolInfo || !mintInfo || !cfgInfo) continue;
      const pool: any = chain.dbc.coder.accounts.decode("virtualPool", poolInfo.data).poolState;
      const cfg: any = chain.dbc.coder.accounts.decode("poolConfig", cfgInfo.data);
      const program = mintInfo.owner.equals(TOKEN_2022_PROGRAM_ID) ? TOKEN_2022_PROGRAM_ID : TOKEN_PROGRAM_ID;
      const mint = unpackMint(new PublicKey(r.baseMint), mintInfo, program);
      // identity: Token-2022 metadata extension, else the Metaplex account
      let name = "", symbol = "", uri = "";
      let metadataStatus: TokenRow["metadataStatus"] = "missing";
      if (program.equals(TOKEN_2022_PROGRAM_ID)) {
        try { const m = await getTokenMetadata(conn, new PublicKey(r.baseMint), "confirmed", program); if (m) { name = m.name; symbol = m.symbol; uri = m.uri; } } catch { /* no extension */ }
      } else {
        const mi = metaInfos.get(metadataPda(new PublicKey(r.baseMint)).toBase58());
        const parsed = mi ? parseMetaplexMetadata(mi.data) : null;
        if (parsed) { name = parsed.name; symbol = parsed.symbol; uri = parsed.uri; }
      }
      let imageUrl: string | null = null, links: Links | null = null;
      if (uri) { const img = await imageFromUri(uri); imageUrl = img.image; metadataStatus = img.status; links = img.links; }
      // stage and price: the DBC pool while bonding, the DAMM v2 pool after graduation
      const progress = Number(pool.migrationProgress);
      const stage: TokenRow["stage"] = progress === 3 ? "graduated" : progress === 0 ? "bonding" : "completed";
      const dammInfo = r.dammPool ? dammInfos.get(r.dammPool) : null;
      let priceSol: string | null = null, priceSource: string | null = null;
      let liquidityLamports: string | null = null, liquidityBasis: TokenRow["liquidityBasis"] = null;
      if (stage === "graduated" && dammInfo) {
        const damm: any = chain.damm.coder.accounts.decode("pool", dammInfo.data);
        priceSol = sqrtPriceToSolPerToken(BigInt(damm.sqrtPrice.toString()), mint.decimals); priceSource = "damm";
        liquidityLamports = (BigInt(damm.tokenBAmount.toString()) * 2n).toString(); liquidityBasis = "damm-quote-x2";
      } else {
        liquidityLamports = BigInt(pool.quoteReserve.toString()).toString(); liquidityBasis = "curve-quote-reserve";
        priceSol = sqrtPriceToSolPerToken(BigInt(pool.sqrtPrice.toString()), mint.decimals); priceSource = "curve";
      }
      const quoteRaised = BigInt(pool.quoteReserve.toString());
      const target = BigInt(cfg.migrationQuoteThreshold.toString());
      const h = await holders(conn, new PublicKey(r.baseMint), program);
      const pools = [r.pool, ...(r.dammPool ? [r.dammPool] : [])];
      const trades = await store.listTradesSince(pools, Math.floor(since / 1000));
      let volume = 0n, buys = 0, sells = 0;
      for (const t of trades) { volume += BigInt(t.quoteAmountLamports ?? t.amountIn); if (t.buy) buys++; else sells++; }
      const cursors = await Promise.all(pools.map((p) => store.getPoolCursor(p)));
      const complete = cursors.every((c) => c && c.status === "ok");
      out.push({
        mint: r.baseMint, decimals: mint.decimals, name, symbol, imageUrl, metadataUri: uri || null, metadataStatus,
        creator: r.creator, custody: r.custody, config: r.config, tokenKind: plainConfigs.has(r.config) ? "plain" : "stream",
        dbcPool: r.pool, dammPool: r.dammPool, quoteMint: r.quoteMint, vault: r.vault, stage,
        priceSol, priceSource, priceAtMs: now, totalSupplyRaw: mint.supply.toString(),
        quoteRaisedLamports: quoteRaised.toString(), targetLamports: target.toString(),
        progressBps: target > 0n ? Number((quoteRaised * 10_000n) / target > 10_000n ? 10_000n : (quoteRaised * 10_000n) / target) : null,
        holders: h.count, holdersAtMs: h.at, liquidityLamports, liquidityBasis, links,
        volume24hLamports: volume.toString(), buys24h: buys, sells24h: sells, volumeComplete: complete,
        createdAtMs: await createdAt(conn, r.baseMint, Number(cfg.activationType ?? 0), BigInt(pool.activationPoint.toString())), updatedAt: now,
      });
    } catch (e) { log("token row failed", { mint: r.baseMint, error: String((e as Error).message ?? e) }); }
  }
  return out;
}
