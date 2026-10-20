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

export function coinView(r: any, ctx: ReadContext, nowMs: number) {
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

// ---- the coin pages ----
// A page is chosen in two steps inside one read snapshot: the pools of the page, in order, from one of the page
// indexes below (the sort keys, pool, progress and config in the index itself, so skipping deep rows reads no table
// row and no config), then those pools' full rows. Every filter and order is the same expression the page always
// used, so the coins and their order are the same; only the way to them changed (on the mainnet index of
// 2026-10-20: deep pages, the per-day order and rare searches took 1 to 8 s each, the slowest now about 0.5 s).

/** The page indexes (created when the index opens; the code before them ignores them, and dropping them is safe). */
export const PAGE_INDEXES: Record<"day" | "claimable" | "lifetime", { name: string; columns: string }> = {
  day: { name: "fi_pools_day_order", columns: "day_income desc, creator_life desc, pool, progress, config" },
  claimable: { name: "fi_pools_claimable_order", columns: "creator_fee desc, pool, progress, config" },
  // also carries launched_at and mint: the per-day order (and a broad search's matches) read all they need from this
  // index, without the table
  lifetime: { name: "fi_pools_life_order", columns: "creator_life desc, pool, launched_at, progress, config, mint" },
};
/** A search matching at most this many names is answered from its matches; a broader one walks the page index
 *  (an object so tests can lower it, to reach the broad paths on a small index). */
export const PAGE_TUNING = { searchCandidatesMax: 20_000 };
/** How deep a search pages (the API refuses a search page that starts further): a broad search in the per-day order
 *  reads ranked pools until offset + limit of them match, so its cost grows with the depth (on mainnet about 0.55 s
 *  at 1,000 with 200 a page, 0.85 s at 2,000). */
export const SEARCH_OFFSET_MAX = 1_000;

/** What the pages know of the configs, kept per connection and brought up to date at every page read:
 *  the configs that allow Tails (whose reasons are none) and the configs that pools name but that have no row
 *  (none on mainnet; such pools never appear on a page, as the inner join with the configs always left them out).
 *  Both tables only ever grow (fi_configs rows are inserted once and never changed; a pool's config never
 *  changes; neither table is deleted from), so the rows past the highest rowid seen are all that is new. If
 *  either table's highest rowid ever goes down, or its row count disagrees with what was read, it is read again
 *  from the start. */
interface PageKnowledge { configRowid: bigint; configRows: bigint; poolRowid: bigint; poolRows: bigint; allowTails: Set<string>; missing: Set<string> }
const KNOWN = new WeakMap<object, PageKnowledge>();
const FUNCTIONS = new WeakSet<object>();
const one = (db: any, sql: string, ...a: unknown[]) => db.prepare(sql).get(...a);
/** Below every rowid: the first read takes every row. */
const FIRST = -(2n ** 63n);

/** Whether a pool on this config can be on a page: its config has a row (the released inner join) and, for the
 *  Tails filter, allows Tails (the released `c.reasons = '[]'`). */
const keeps = (k: PageKnowledge, config: string, needAllow: boolean) => !k.missing.has(config) && (!needAllow || k.allowTails.has(config));

/** Brings the page knowledge of this connection up to date (inside the caller's read snapshot) and returns it. */
export function pageKnowledge(db: any, fromStart = false): PageKnowledge {
  let k = fromStart ? undefined : KNOWN.get(db);
  const c = one(db, "select max(rowid) as top from fi_configs"), p = one(db, "select max(rowid) as top from fi_pools");
  const cTop = BigInt(c.top ?? FIRST), pTop = BigInt(p.top ?? FIRST);
  if (!k || cTop < k.configRowid || pTop < k.poolRowid) {
    if (!FUNCTIONS.has(db)) db.function("fi_page_keep", (config: string, needAllow: number | bigint) => (keeps(KNOWN.get(db)!, config, Number(needAllow) === 1) ? 1 : 0));
    FUNCTIONS.add(db);
    k = { configRowid: FIRST, configRows: 0n, poolRowid: FIRST, poolRows: 0n, allowTails: new Set(), missing: new Set() };
    KNOWN.set(db, k);
  }
  if (cTop > k.configRowid) {
    for (const r of db.prepare("select config from fi_configs where rowid > ? and reasons = '[]'").iterate(k.configRowid)) k.allowTails.add(String(r.config));
    k.configRows += BigInt(one(db, "select count(*) as n from fi_configs where rowid > ?", k.configRowid).n);
    k.configRowid = cTop;
    for (const m of [...k.missing]) if (one(db, "select 1 as y from fi_configs where config = ?", m)) k.missing.delete(m);
  }
  if (pTop > k.poolRowid) {
    for (const r of db.prepare("select distinct p.config from fi_pools p where p.rowid > ? and not exists (select 1 from fi_configs c where c.config = p.config)").iterate(k.poolRowid)) k.missing.add(String(r.config));
    k.poolRows += BigInt(one(db, "select count(*) as n from fi_pools where rowid > ?", k.poolRowid).n);
    k.poolRowid = pTop;
  }
  // the growth-only assumption, checked: a row count that is not what was read means a delete happened
  if (BigInt(one(db, "select count(*) as n from fi_configs").n) !== k.configRows || BigInt(one(db, "select count(*) as n from fi_pools").n) !== k.poolRows) {
    if (fromStart) throw new Error("fee index page knowledge does not match the tables read from the start");
    return pageKnowledge(db, true);
  }
  return k;
}

/** The pools of a page, in order (step one). The same filters and order as the single query before, over the
 *  page indexes; the config join of that query becomes fi_page_keep on the config the index carries. */
function pagePools(db: any, q: CoinQuery, nowMs: number): string[] {
  const k = pageKnowledge(db);
  const where: string[] = [], args: unknown[] = [];
  if (q.stage === "bonding") where.push("p.progress = 0"); else if (q.stage === "graduated") where.push("p.progress = 3");
  if (q.eligible) { where.push("p.progress in (0, 3)"); where.push("fi_page_keep(p.config, 1)"); }
  else if (k.missing.size) where.push("fi_page_keep(p.config, 0)");
  if (q.creator) { where.push("p.creator = ?"); args.push(q.creator); }
  let from = "fi_pools p", index = q.sort === "avg" ? PAGE_INDEXES.lifetime.name : PAGE_INDEXES[q.sort].name;
  if (q.search) {
    const s = q.search.toLowerCase();
    from += " left join fi_names n on n.mint = p.mint";
    where.push("(p.mint = ? or p.pool = ? or lower(n.name) like ? or lower(n.symbol) like ?)"); args.push(q.search, q.search, `%${s}%`, `%${s}%`);
    // a narrow search: only its matches are ordered (the names that match, and a mint or pool given whole)
    const named = q.creator ? null : db.prepare("select mint from fi_names where lower(name) like ? or lower(symbol) like ? limit ?").all(`%${s}%`, `%${s}%`, PAGE_TUNING.searchCandidatesMax + 1).map((r: any) => String(r.mint));
    if (named && named.length <= PAGE_TUNING.searchCandidatesMax) {
      where.push("p.pool in (select pool from fi_pools where mint in (select value from json_each(?)) union select pool from fi_pools where mint = ? union select pool from fi_pools where pool = ?)");
      args.push(JSON.stringify(named), q.search, q.search);
      index = "";
    }
  }
  if (q.creator) index = "fi_pools_creator";
  const order = q.sort === "claimable" ? "p.creator_fee desc, p.pool"
    : q.sort === "lifetime" ? "p.creator_life desc, p.pool"
    : q.sort === "avg" ? `(p.creator_life * ${DAY}.0) / max(${DAY}, ? - p.launched_at) desc, p.pool`
    : "p.day_income desc, p.creator_life desc, p.pool";
  const orderArgs = q.sort === "avg" ? [nowMs] : [];
  if (q.sort === "avg" && q.search && index === PAGE_INDEXES.lifetime.name && !q.creator) { const page = avgBroadSearch(db, where, q, nowMs, k.poolRows); if (page) return page; }
  const sql = `select p.pool from ${from.replace("fi_pools p", index ? `fi_pools p indexed by ${index}` : "fi_pools p")} ${where.length ? "where " + where.join(" and ") : ""} order by ${order} limit ? offset ?`;
  return db.prepare(sql).all(...args, ...orderArgs, q.limit, q.offset).map((r: any) => String(r.pool));
}

/** The per-day order of a broad search, without reading the name of every pool. Pools are read best first by the
 *  order alone (the same expression and pool tiebreak, in SQL, with the page's stage and Tails terms, from the
 *  lifetime index, which carries the mint, without the table), `take` at a time, and the search is checked on them
 *  2,000 at a time (the same LIKE terms, in SQL, on their names; the exact mint or pool compared as SQL compares
 *  text). Once offset + limit pools pass, no later pool can be on the page; if fewer than `take` pools were read,
 *  every pool was seen. `take` starts at twice what the share of names the search matches needs (from a sample; a
 *  broad search matches more than PAGE_TUNING.searchCandidatesMax names); if the pools taken hold too few matches it grows
 *  once, then the page is ordered the released way (null). */
function avgBroadSearch(db: any, where: string[], q: CoinQuery, nowMs: number, pools: bigint): string[] | null {
  const keep = q.offset + q.limit, search = q.search as string, s = `%${search.toLowerCase()}%`;
  const plain = where.filter((w) => !w.includes("n.")); // stage and Tails terms: no arguments
  const rank = db.prepare(`select p.pool, p.mint from fi_pools p indexed by ${PAGE_INDEXES.lifetime.name} ${plain.length ? "where " + plain.join(" and ") : ""} order by (p.creator_life * ${DAY}.0) / max(${DAY}, ? - p.launched_at) desc, p.pool limit ?`);
  const named = db.prepare("select mint from fi_names where mint in (select value from json_each(?)) and (lower(name) like ? or lower(symbol) like ?)");
  // the share of names the search matches, from a sample (it sizes `take` only; the page never depends on it)
  const sample = Number(db.prepare("select coalesce(sum(lower(name) like ? or lower(symbol) like ?), 0) as m, count(*) as n from (select name, symbol from fi_names limit 20000)").get(s, s).m) / 20_000;
  const share = Math.max(sample, PAGE_TUNING.searchCandidatesMax / Math.max(1, Number(pools)));
  for (let take = Math.ceil((keep * 2) / share) + 1_000, tries = 0; tries < 2; take *= 4, tries++) {
    const ranked: { pool: string; mint: string }[] = rank.all(nowMs, take).map((r: any) => ({ pool: String(r.pool), mint: String(r.mint) }));
    const page: string[] = [];
    for (let i = 0; i < ranked.length && page.length < keep; i += 2_000) {
      const batch = ranked.slice(i, i + 2_000);
      const hit = new Set(named.all(JSON.stringify(batch.map((r) => r.mint)), s, s).map((r: any) => String(r.mint)));
      for (const r of batch) if ((hit.has(r.mint) || r.mint === search || r.pool === search) && page.length < keep) page.push(r.pool);
    }
    if (page.length === keep || ranked.length < take) return page.slice(q.offset);
  }
  return null;
}

export function coins(db: any, ctx: ReadContext, q: CoinQuery, nowMs = Date.now()) {
  // one read snapshot for both steps (a savepoint opens a read transaction, or nests inside the caller's)
  db.exec("savepoint fi_page");
  try {
    const pools = pagePools(db, q, nowMs);
    if (!pools.length) return [];
    const rows = db.prepare(`select p.*, n.name, n.symbol, n.image, ${CONFIG_COLS} from fi_pools p join fi_configs c on c.config = p.config left join fi_names n on n.mint = p.mint where p.pool in (select value from json_each(?))`).all(JSON.stringify(pools));
    const byPool = new Map(rows.map((r: any) => [String(r.pool), r]));
    return pools.map((pool) => coinView(byPool.get(pool), ctx, nowMs));
  } finally { db.exec("release fi_page"); }
}

/** The names and logos of these mints as stored now (a page refreshes them after reading the missing ones). */
export function identities(db: any, _ctx: ReadContext, mints: string[]): { mint: string; name: string | null; symbol: string | null; imageUrl: string | null }[] {
  if (!mints.length) return [];
  return db.prepare("select mint, name, symbol, image from fi_names where mint in (select value from json_each(?))").all(JSON.stringify(mints)).map((r: any) => ({ mint: String(r.mint), name: r.name ?? null, symbol: r.symbol ?? null, imageUrl: r.image ?? null }));
}

/** Brings the page knowledge up to date ahead of the first page (the reader thread runs it once it starts). */
export function warmPages(db: any): number { db.exec("savepoint fi_page"); try { return pageKnowledge(db).allowTails.size; } finally { db.exec("release fi_page"); } }

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
export const READS = { status, coins, coin, identities, warmPages, namesDue, imagesDue, summarize, summary } as const;
export type ReadName = keyof typeof READS;
