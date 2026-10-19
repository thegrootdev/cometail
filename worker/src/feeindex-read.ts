// The Fee Index's reads, as functions of a database handle. The same code answers on the indexer's own
// thread (tests, and a server started without the reader thread) and inside the reader thread
// (feeindex-reader.ts): reads that scan the index's ~440,000 pools (the launchpad summary, the names and logos
// still due, search, deep pages, the average order, the status counts) took 0.1 to 4.7 s each on the mainnet
// index of 2026-10-19, and the indexer's thread also serves the API, so every one of them froze every API
// answer while it ran. Dependency-free (no chain client), so the thread loads quickly.
// Every statement reads integers as BigInt (the handle's prepare is wrapped); every reader converts.
import { ESTIMATE_BASIS } from "./fee-basis";

export const HOUR = 3_600_000, DAY = 86_400_000;
export const IMAGE_RETRY_MS = 6 * 3_600_000;

export const stageOf = (progress: number) => (progress === 3 ? "graduated" : progress === 0 ? "bonding" : "migrating");
export const creatorShare = (ttq: bigint, pct: number) => (ttq * BigInt(pct)) / 100n;
/** What the counters prove about the creator's past claims. The lifetime estimate is an upper bound of the true
 *  total T (per-swap flooring; exact at a 0% or 100% share) and claimable = T - claimed, so claimed is at most
 *  estimate - claimable (exactly that at 100%), and it is zero for certain only when the two are equal. */
export function creatorClaims(estimate: bigint, claimable: bigint, pct: number): { claimedAtMost: bigint; lifetimeExact: boolean; noneClaimed: boolean } {
  return { claimedAtMost: estimate > claimable ? estimate - claimable : 0n, lifetimeExact: pct === 0 || pct === 100, noneClaimed: estimate === claimable };
}

/** What a read needs besides the database: our configs (in the order configured) and the walk settings it reports. */
export interface ReadContext { ourConfigs: string[]; fullEveryHours: number; deltaEveryMinutes: number }
export interface CoinQuery { sort: "day" | "claimable" | "lifetime" | "avg"; stage: string; eligible: boolean; creator: string | null; search: string | null; limit: number; offset: number }

const meta = (db: any, key: string): string | null => { const r = db.prepare("select value from fi_meta where key = ?").get(key); return r ? String(r.value) : null; };
const oursIn = (ctx: ReadContext) => ctx.ourConfigs.map(() => "?").join(",") || "''";

/** When the index's history began, and whether a full day of it exists yet. */
export function history(db: any, nowMs = Date.now()) {
  const first = Number(meta(db, "first_full_at") ?? 0);
  return { historySinceMs: first, fullDay: first > 0 && nowMs - first >= DAY };
}

export function status(db: any, ctx: ReadContext) {
  const n = db.prepare("select count(*) as pools, count(distinct config) as configs from fi_pools").get();
  const claims = db.prepare("select status, count(*) as n from fi_claims group by status").all();
  const h = history(db);
  return { mode: "all-dbc", pools: Number(n.pools), configs: Number(n.configs), fullSlot: Number(meta(db, "full_slot") ?? 0), deltaSlot: Number(meta(db, "delta_slot") ?? 0), fullAtMs: Number(meta(db, "full_at") ?? 0), deltaAtMs: Number(meta(db, "delta_at") ?? 0), fullEveryHours: ctx.fullEveryHours, deltaEveryMinutes: ctx.deltaEveryMinutes,
    historySinceMs: h.historySinceMs, fullDayOfHistory: h.fullDay, claims: Object.fromEntries(claims.map((r: any) => [String(r.status), Number(r.n)])) };
}

/** The config's columns a coin row carries (c_claimer, c_pct, c_reasons; null when the config is not in the index). */
const CONFIG_COLS = "c.fee_claimer as c_claimer, c.creator_pct as c_pct, c.reasons as c_reasons";

function coinView(r: any, ctx: ReadContext, nowMs: number) {
  const known = r.c_claimer !== null && r.c_claimer !== undefined;
  const creatorPct = known ? Number(r.c_pct) : null;
  const reasons: string[] = known ? [...JSON.parse(String(r.c_reasons))] : [];
  const progress = Number(r.progress);
  if (progress === 1 || progress === 2) reasons.push("waiting for migration");
  const launchedAtMs = Number(r.launched_at);
  const life = BigInt(r.creator_life);
  const claims = creatorClaims(life, BigInt(r.creator_fee), creatorPct ?? -1);
  const span = BigInt(Math.max(DAY, nowMs - launchedAtMs));
  return {
    mint: String(r.mint), pool: String(r.pool), config: String(r.config), creator: String(r.creator), launchpad: known ? String(r.c_claimer) : null, ours: ctx.ourConfigs.includes(String(r.config)),
    name: r.name ?? null, symbol: r.symbol ?? null, imageUrl: r.image ?? null, stage: stageOf(progress), creatorFeePct: creatorPct,
    creatorLifetimeEstimateLamports: life.toString(), lifetimeExact: claims.lifetimeExact, creatorClaimedAtMostLamports: claims.claimedAtMost.toString(), noneClaimed: claims.noneClaimed, creatorLast24hEstimateLamports: String(r.day_income), last24hWindowHours: Number(r.day_hours),
    creatorAvgPerDayEstimateLamports: ((life * BigInt(DAY)) / span).toString(),
    claimableLamports: String(r.creator_fee), launchedAtMs, configAllowsTail: reasons.length === 0, reasons, changedAtMs: Number(r.changed_at),
  };
}

export function coins(db: any, ctx: ReadContext, q: CoinQuery, nowMs = Date.now()) {
  const where: string[] = [], args: any[] = [];
  if (q.stage === "bonding") where.push("p.progress = 0"); else if (q.stage === "graduated") where.push("p.progress = 3");
  if (q.eligible) { where.push("c.reasons = '[]'"); where.push("p.progress in (0, 3)"); }
  if (q.creator) { where.push("p.creator = ?"); args.push(q.creator); }
  if (q.search) { where.push("(p.mint = ? or p.pool = ? or lower(n.name) like ? or lower(n.symbol) like ?)"); const s = q.search.toLowerCase(); args.push(q.search, q.search, `%${s}%`, `%${s}%`); }
  // every order is global (before LIMIT/OFFSET) with the pool as the stable tiebreaker
  const order = q.sort === "claimable" ? "p.creator_fee desc, p.pool"
    : q.sort === "lifetime" ? "p.creator_life desc, p.pool"
    : q.sort === "avg" ? `(p.creator_life * ${DAY}.0) / max(${DAY}, ? - p.launched_at) desc, p.pool`
    : "p.day_income desc, p.creator_life desc, p.pool";
  const orderArgs = q.sort === "avg" ? [nowMs] : [];
  const sql = `select p.*, n.name, n.symbol, n.image, ${CONFIG_COLS} from fi_pools p join fi_configs c on c.config = p.config left join fi_names n on n.mint = p.mint ${where.length ? "where " + where.join(" and ") : ""} order by ${order} limit ? offset ?`;
  return db.prepare(sql).all(...args, ...orderArgs, q.limit, q.offset).map((r: any) => coinView(r, ctx, nowMs));
}

export function coin(db: any, ctx: ReadContext, mint: string, nowMs = Date.now()) {
  const r = db.prepare(`select p.*, n.name, n.symbol, n.image, ${CONFIG_COLS} from fi_pools p left join fi_names n on n.mint = p.mint left join fi_configs c on c.config = p.config where p.mint = ?`).get(mint);
  return r ? coinView(r, ctx, nowMs) : null;
}

/** Mints the background fill names first: ours, then the top earners without a name yet. */
export function namesDue(db: any, ctx: ReadContext, limit: number): string[] {
  return db.prepare(`select p.mint from fi_pools p left join fi_names n on n.mint = p.mint where (n.mint is null or n.checked_at = 0) order by (p.config in (${oursIn(ctx)})) desc, p.day_income desc, p.creator_life desc limit ?`).all(...ctx.ourConfigs, limit).map((r: any) => String(r.mint));
}

/** Mints among these (or, with null, across the index, the most-earning first) whose image is not known yet
 *  (or whose host was unreachable more than six hours ago). */
export function imagesDue(db: any, ctx: ReadContext, mints: string[] | null, limit: number, nowMs = Date.now()): { mint: string; uri: string }[] {
  const due = "n.uri is not null and (n.image_checked_at is null or (n.image_status = 'unreachable' and n.image_checked_at < ?))";
  if (mints) {
    if (!mints.length) return [];
    return db.prepare(`select n.mint, n.uri from fi_names n where n.mint in (${mints.map(() => "?").join(",")}) and ${due} limit ?`).all(...mints, nowMs - IMAGE_RETRY_MS, limit).map((r: any) => ({ mint: String(r.mint), uri: String(r.uri) }));
  }
  return db.prepare(`select n.mint, n.uri from fi_names n join fi_pools p on p.mint = n.mint where ${due} order by (p.config in (${oursIn(ctx)})) desc, p.day_income desc, p.creator_life desc limit ?`).all(nowMs - IMAGE_RETRY_MS, ...ctx.ourConfigs, limit).map((r: any) => ({ mint: String(r.mint), uri: String(r.uri) }));
}

/** Launchpads (fee claimers) ranked by what their creators earn, ours flagged; precomputed after each walk.
 *  Until the index holds a full day of history the 24-hour figures are not comparable, so the ranking is by lifetime. */
export function summarize(db: any, ctx: ReadContext, nowMs = Date.now()) {
  const { fullDay, historySinceMs } = history(db, nowMs);
  const rankedBy = fullDay ? "last24h" : "lifetime";
  const orderBy = fullDay ? "day desc, lifetime desc, launchpad" : "lifetime desc, launchpad";
  const agg = `select c.fee_claimer as launchpad, count(*) as coins, sum(case when p.progress = 3 then 1 else 0 end) as graduated, sum(case when c.reasons = '[]' and p.progress in (0, 3) then 1 else 0 end) as eligible,
    sum(p.creator_life) as lifetime, sum(p.day_income) as day, sum(p.creator_fee) as claimable, count(distinct p.config) as configs, max(c.creator_pct) as creator_pct_max, min(c.creator_pct) as creator_pct_min,
    sum(case when p.day_hours < 24 then 1 else 0 end) as partial
    from fi_pools p join fi_configs c on c.config = p.config`;
  const rows: any[] = db.prepare(`${agg} group by c.fee_claimer order by ${orderBy} limit 200`).all();
  rows.forEach((r, i) => { r.rank = i + 1; });
  const cfgOf = (k: string): any => db.prepare("select fee_claimer, creator_pct, reasons from fi_configs where config = ?").get(k) ?? null;
  const ourCfg = new Map(ctx.ourConfigs.map((k) => [k, cfgOf(k)]));
  const ourClaimers = new Set([...ourCfg.values()].filter(Boolean).map((c: any) => String(c.fee_claimer)));
  const listed = new Set(rows.map((r) => String(r.launchpad)));
  const missing = [...ourClaimers].filter((k) => !listed.has(k));
  if (missing.length) {
    const extra: any[] = db.prepare(`${agg} where c.fee_claimer in (${missing.map(() => "?").join(",")}) group by c.fee_claimer`).all(...missing);
    const rank = db.prepare(fullDay
      ? `select count(*) + 1 as rank from (select c.fee_claimer as k, sum(p.day_income) as d, sum(p.creator_life) as l from fi_pools p join fi_configs c on c.config = p.config group by c.fee_claimer) where d > ? or (d = ? and (l > ? or (l = ? and k < ?)))`
      : `select count(*) + 1 as rank from (select c.fee_claimer as k, sum(p.creator_life) as l from fi_pools p join fi_configs c on c.config = p.config group by c.fee_claimer) where l > ? or (l = ? and k < ?)`);
    for (const e of extra) { e.rank = Number((fullDay ? rank.get(e.day, e.day, e.lifetime, e.lifetime, e.launchpad) : rank.get(e.lifetime, e.lifetime, e.launchpad)).rank); rows.push(e); }
  }
  const ourConfigs = ctx.ourConfigs.map((k) => {
    const c = ourCfg.get(k);
    if (!c) return { config: k, covered: false, note: "not SOL-quoted: outside the Fee Index and outside what the vault accepts" };
    const s = db.prepare("select count(*) as coins, sum(creator_life) as lifetime, sum(day_income) as day, sum(creator_fee) as claimable, sum(case when progress = 3 then 1 else 0 end) as graduated from fi_pools where config = ?").get(k);
    return { config: k, covered: true, launchpad: String(c.fee_claimer), creatorFeePct: Number(c.creator_pct), tailEligibleConfig: JSON.parse(String(c.reasons)).length === 0, coins: Number(s?.coins ?? 0), graduated: Number(s?.graduated ?? 0), creatorLifetimeEstimateLamports: String(s?.lifetime ?? 0), creatorLast24hEstimateLamports: String(s?.day ?? 0), claimableLamports: String(s?.claimable ?? 0) };
  });
  return {
    generatedAtMs: nowMs, rankedBy, historySinceMs, basis: ESTIMATE_BASIS,
    launchpads: rows.map((r: any) => ({ rank: Number(r.rank), launchpad: String(r.launchpad), ours: ourClaimers.has(String(r.launchpad)), coins: Number(r.coins), configs: Number(r.configs), graduated: Number(r.graduated), tailEligibleCoins: Number(r.eligible),
      creatorLifetimeEstimateLamports: String(r.lifetime ?? 0), creatorLast24hEstimateLamports: String(r.day ?? 0), coinsWithShorterWindow: Number(r.partial ?? 0), claimableLamports: String(r.claimable ?? 0), creatorFeePct: Number(r.creator_pct_min) === Number(r.creator_pct_max) ? Number(r.creator_pct_max) : null })),
    ourConfigs,
  };
}

/** The stored summary (written after each pass), parsed; null before the first one. */
export function summary(db: any): unknown | null { const s = meta(db, "summary"); return s ? JSON.parse(s) : null; }

/** Every read the reader thread answers, by name. */
export const READS = { status, coins, coin, namesDue, imagesDue, summarize, summary } as const;
export type ReadName = keyof typeof READS;
