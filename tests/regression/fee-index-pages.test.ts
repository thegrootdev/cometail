// The Fee Index pages choose their coins through the page indexes (spike 205): on the mainnet index of 2026-10-20
// deep pages, the per-day order and rare searches took 1 to 8 s each. The coins and their order must be exactly
// what the single query before answered, so these checks keep that query (as released at ab2d339) and compare it
// with the new reads on an index built to hold the hard cases: ties in every order, pools whose config has no row,
// configs that do or do not allow Tails, names with LIKE wildcards, mixed case and non-ASCII letters, pools without
// a name, a creator with thousands of pools, launches in the last day and in the future, a search broad enough to
// walk the index and narrow ones answered from their matches; then again while configs and pools are added, a
// missing config arrives, and rows are deleted (which the page knowledge must notice).
import { expect } from "chai";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import * as http from "http";
import { NATIVE_MINT } from "@solana/spl-token";
import { FeeIndex } from "../../worker/src/feeindex";
import * as R from "../../worker/src/feeindex-read";
import { startApi } from "../../worker/src/api";
import { openStore } from "../../worker/src/store";

const DAY = R.DAY;
/** The page query as released (ab2d339), the reference every new page is compared with. */
function released(db: any, ctx: R.ReadContext, q: R.CoinQuery, nowMs: number) {
  const where: string[] = [], args: any[] = [];
  if (q.stage === "bonding") where.push("p.progress = 0"); else if (q.stage === "graduated") where.push("p.progress = 3");
  if (q.eligible) { where.push("c.reasons = '[]'"); where.push("p.progress in (0, 3)"); }
  if (q.creator) { where.push("p.creator = ?"); args.push(q.creator); }
  if (q.search) { where.push("(p.mint = ? or p.pool = ? or lower(n.name) like ? or lower(n.symbol) like ?)"); const s = q.search.toLowerCase(); args.push(q.search, q.search, `%${s}%`, `%${s}%`); }
  const order = q.sort === "claimable" ? "p.creator_fee desc, p.pool"
    : q.sort === "lifetime" ? "p.creator_life desc, p.pool"
    : q.sort === "avg" ? `(p.creator_life * ${DAY}.0) / max(${DAY}, ? - p.launched_at) desc, p.pool`
    : "p.day_income desc, p.creator_life desc, p.pool";
  const orderArgs = q.sort === "avg" ? [nowMs] : [];
  const sql = `select p.*, n.name, n.symbol, n.image, c.fee_claimer as c_claimer, c.creator_pct as c_pct, c.reasons as c_reasons from fi_pools p join fi_configs c on c.config = p.config left join fi_names n on n.mint = p.mint ${where.length ? "where " + where.join(" and ") : ""} order by ${order} limit ? offset ?`;
  return db.prepare(sql).all(...args, ...orderArgs, q.limit, q.offset).map((r: any) => R.coinView(r, ctx, nowMs)); // the view is unchanged
}

const POOLS = 33_000;
const BIG = "CREATORBIG";
const OURS = ["CFG0"];
const opts = (readerThreads: boolean) => ({ fullEveryHours: 24, deltaEveryMinutes: 5, pageDelayMs: 0, claimLookupsPerPass: 10, namesPerPass: 50, imagesPerPass: 50, ourConfigs: OURS, readerThreads });
const ctx: R.ReadContext = { ourConfigs: OURS, fullEveryHours: 24, deltaEveryMinutes: 5 };
const NAMES = ["100% Real", "under_score", "MiXeD CaSe cat", "ÄÖÜ кот 猫", "Cat", "catalog", "a%b", "dog", "o'brien", "back\\slash"];

let file = "", now = 0;
const store = openStore("sqlite::memory:");
const config = (c: string, allow: boolean) => ({ config: c, quoteMint: NATIVE_MINT.toBase58(), feeClaimer: `L${c.length % 5}`, creatorPct: 50, activationType: 1, partnerLocked: 0, creatorLocked: 100, threshold: 10n ** 12n, reasons: allow ? [] : ["creator liquidity vests"] });
function putPools(db: any, from: number, to: number, cfg: (i: number) => string) {
  const put = db.prepare("insert into fi_pools (pool, config, creator, mint, progress, ttq, creator_fee, partner_fee, quote_reserve, activation, launched_at, finish_ts, creator_life, day_income, day_hours, changed_at, updated_at) values (?, ?, ?, ?, ?, ?, ?, ?, 0, 0, ?, 0, ?, ?, ?, ?, ?)");
  const name = db.prepare("insert into fi_names (mint, name, symbol, uri, image, checked_at) values (?, ?, ?, ?, ?, ?)");
  db.exec("begin");
  for (let i = from; i < to; i++) {
    // ties: lifetimes, fees and day figures repeat in bands; a day figure only on some; launches from 400 days ago to a day ahead
    const life = BigInt(1 + (i % 700) * 1_000);
    const fee = BigInt((i % 53) * 77);
    const day = i % 9 === 0 ? BigInt((i % 31) * 5) : 0n;
    const launched = now - ((i * 7_919) % 400) * DAY + (i % 17 === 0 ? (i % 3) * DAY : 0) - (i % 5) * 3_600_000;
    put.run(`P${String(i).padStart(6, "0")}`, cfg(i), i % 7 === 0 ? BIG : `C${i % 911}`, `M${i}`, [0, 0, 3, 3, 0, 1, 3, 2][i % 8], (life * 2n).toString(), fee.toString(), "0", launched, life.toString(), day.toString(), i % 13 === 0 ? 7 : 24, now, now);
    if (i % 4 !== 3) name.run(`M${i}`, i % 50 === 1 ? NAMES[(i / 50 | 0) % NAMES.length] : i % 97 === 0 ? null : `Coin ${i}`, i % 89 === 0 ? null : `C${i}`, null, i % 3 === 0 ? `https://img.example/${i}.png` : null, now);
  }
  db.exec("commit");
}

before(async function () {
  this.timeout(180_000);
  await store.init();
  now = Date.now();
  file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "fi-pages-")), "fi.sqlite");
  const fi = new FeeIndex({ connection: {} } as any, store, file, opts(false));
  await fi.open();
  for (let c = 0; c < 40; c++) fi.rememberConfig(config(`CFG${c}`, c % 3 !== 0));
  // pools on CFGX and CFGY, configs with no row: the released query's inner join never shows them
  putPools(fi.db.db, 0, POOLS, (i) => (i % 101 === 0 ? "CFGX" : i % 211 === 0 ? "CFGY" : `CFG${i % 40}`));
  await fi.close();
});

/** A read-only connection, as the reader thread opens it. */
function readOnly() {
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const { DatabaseSync } = require("node:sqlite");
  const db = new DatabaseSync(file, { readOnly: true });
  const prepare = db.prepare.bind(db);
  db.prepare = (sql: string) => { const st = prepare(sql); st.setReadBigInts(true); return st; };
  return db;
}

type Q = R.CoinQuery;
const q = (o: Partial<Q>): Q => ({ sort: "day", stage: "all", eligible: false, creator: null, search: null, limit: 50, offset: 0, ...o });
function grid(): Q[] {
  const out: Q[] = [];
  const stages: [string, boolean][] = [["all", false], ["bonding", false], ["graduated", false], ["all", true], ["graduated", true]];
  for (const sort of ["day", "claimable", "lifetime", "avg"] as const) for (const [stage, eligible] of stages) for (const offset of [0, 37, 4_000, 20_000, 32_990])
    out.push(q({ sort, stage, eligible, offset, limit: offset === 37 ? 200 : 50 }));
  const searches = ["coin", "c", "coin 12", "cat", "%", "_", "100%", "a%b", "under_score", "case", "猫", "кот", "o'brien", "back\\slash", "zzz", "M1234", "P001234", "M12", "ÄÖÜ"];
  for (const search of searches) for (const sort of ["day", "avg", "lifetime"] as const) for (const [stage, eligible] of [["all", false], ["graduated", true]] as [string, boolean][]) for (const offset of [0, 40, 1_500])
    out.push(q({ sort, stage, eligible, search, offset, limit: offset === 40 ? 200 : 50 }));
  for (const creator of [BIG, "C5", "nobody"]) for (const sort of ["day", "avg", "claimable"] as const) for (const offset of [0, 1_000, 4_600])
    out.push(q({ sort, creator, offset }), q({ sort, creator, offset, eligible: true, search: "coin" }));
  return out;
}
const label = (x: Q) => `${x.sort} ${x.stage}${x.eligible ? " eligible" : ""}${x.search ? ` q=${JSON.stringify(x.search)}` : ""}${x.creator ? ` creator=${x.creator}` : ""} off ${x.offset} limit ${x.limit}`;
function compare(dbNew: any, dbRef: any, queries: Q[]): number {
  let rows = 0;
  for (const x of queries) {
    const want = released(dbRef, ctx, x, now), got = R.coins(dbNew, ctx, x, now);
    expect(got, label(x)).deep.eq(want);
    rows += got.length;
  }
  return rows;
}

describe("fee index pages through the page indexes (spike 205)", () => {
  it("open builds the page indexes, and deep pages read them without the table", async function () {
    this.timeout(60_000);
    const db = readOnly();
    try {
      const have = db.prepare("select name from sqlite_master where type = 'index' and tbl_name = 'fi_pools'").all().map((r: any) => String(r.name));
      for (const i of Object.values(R.PAGE_INDEXES)) expect(have).include(i.name);
      const plan = (sql: string) => db.prepare(`explain query plan ${sql}`).all().map((r: any) => String(r.detail)).join(" | ");
      expect(plan(`select p.pool from fi_pools p indexed by ${R.PAGE_INDEXES.day.name} where p.progress = 3 order by p.day_income desc, p.creator_life desc, p.pool limit 50 offset 20000`)).match(/COVERING INDEX fi_pools_day_order/).and.not.match(/TEMP B-TREE/);
      expect(plan(`select p.pool from fi_pools p indexed by ${R.PAGE_INDEXES.lifetime.name} order by (p.creator_life * ${DAY}.0) / max(${DAY}, 1 - p.launched_at) desc, p.pool limit 50`)).match(/COVERING INDEX fi_pools_life_order/);
    } finally { db.close(); }
  });

  it("answer exactly the released query's coins, in its order, for every page shape (in-process and read-only connections)", async function () {
    this.timeout(600_000);
    const qs = grid();
    const fi = new FeeIndex({ connection: {} } as any, store, file, opts(false));
    await fi.open();
    const ro = readOnly();
    try {
      // the reference really holds the hard cases: hidden pools, a broad search past the candidate bound, empty pages
      expect(Number(fi.db.db.prepare("select count(*) as n from fi_pools where config in ('CFGX', 'CFGY')").get().n)).gt(400);
      expect(Number(fi.db.db.prepare("select count(*) as n from fi_names where lower(name) like '%coin%'").get().n)).gt(R.PAGE_TUNING.searchCandidatesMax);
      expect(R.pageKnowledge(ro).missing).deep.eq(new Set(["CFGX", "CFGY"]));
      const rows = compare(fi.db.db, fi.db.db, qs) + compare(ro, ro, qs);
      expect(rows).gt(15_000);
      expect(qs.some((x) => released(ro, ctx, x, now).length === 0)).eq(true);
    } finally { ro.close(); await fi.close(); }
  });

  it("stay exact while configs and pools are added, a missing config arrives, and rows are deleted", async function () {
    this.timeout(600_000);
    const fi = new FeeIndex({ connection: {} } as any, store, file, opts(false));
    await fi.open();
    const ro = readOnly();
    const some = grid().filter((_, i) => i % 7 === 0);
    try {
      compare(ro, ro, some); // knowledge built
      // new configs (allowing Tails and not) and pools on them, pools on a new missing config, while a page reads
      for (let c = 40; c < 46; c++) fi.rememberConfig(config(`CFG${c}`, c % 2 === 0));
      putPools(fi.db.db, POOLS, POOLS + 2_000, (i) => (i % 5 === 0 ? "CFGZ" : `CFG${40 + (i % 6)}`));
      expect(R.pageKnowledge(ro).missing).deep.eq(new Set(["CFGX", "CFGY", "CFGZ"]));
      compare(ro, fi.db.db, some); compare(fi.db.db, fi.db.db, some);
      // a missing config gets its row: its pools appear, on both connections
      fi.rememberConfig(config("CFGY", true));
      expect(R.pageKnowledge(ro).missing).deep.eq(new Set(["CFGX", "CFGZ"]));
      compare(ro, fi.db.db, some); compare(fi.db.db, fi.db.db, some);
      // deletes are outside the index's own writes; if one ever happens the knowledge is read again
      fi.db.db.exec("delete from fi_configs where config = 'CFG3'; delete from fi_pools where pool = 'P000004'");
      expect(R.pageKnowledge(ro).missing).deep.eq(new Set(["CFGX", "CFGZ", "CFG3"]));
      compare(ro, fi.db.db, some); compare(fi.db.db, fi.db.db, some);
      fi.db.db.exec("delete from fi_configs where config = (select config from fi_configs order by rowid desc limit 1)");
      compare(ro, fi.db.db, some);
    } finally { ro.close(); await fi.close(); }
  });

  it("a broad search in the per-day order stays exact when its matches sit low in the order (more pools read, then the released way)", async function () {
    this.timeout(300_000);
    const fi = new FeeIndex({ connection: {} } as any, store, file, opts(false));
    await fi.open();
    const ro = readOnly();
    const was = R.PAGE_TUNING.searchCandidatesMax;
    try {
      // "tailend" on the names of the 600 pools lowest in the per-day order, and "midway" on 400 in the middle:
      // broad once the candidate bound is 50, but the best-ranked pools read first hold none of them
      const order = `(creator_life * ${DAY}.0) / max(${DAY}, ${now} - launched_at)`;
      fi.db.db.exec(`update fi_names set name = 'tailend ' || coalesce(name, '') where mint in (select mint from fi_pools order by ${order} asc, pool limit 600)`);
      fi.db.db.exec(`update fi_names set name = 'midway ' || coalesce(name, '') where mint in (select mint from fi_pools order by ${order} asc, pool limit 400 offset 16000)`);
      R.PAGE_TUNING.searchCandidatesMax = 50;
      const qs: Q[] = [];
      for (const search of ["tailend", "midway", "coin", "c"]) for (const [stage, eligible] of [["all", false], ["bonding", false], ["graduated", true]] as [string, boolean][]) for (const [offset, limit] of [[0, 50], [40, 200], [300, 50], [1_500, 200]])
        qs.push(q({ sort: "avg", stage, eligible, search, offset, limit }));
      // which ways the pages took: the first read enough, a second read, every pool seen, the released order
      const ways = new Set<string>();
      const prepare = ro.prepare;
      ro.prepare = (sql: string) => {
        const st = prepare(sql);
        if (sql.startsWith("select p.pool, p.mint from fi_pools")) { const all = st.all.bind(st); st.all = (...a: any[]) => { const r = all(...a); ways.add(r.length < a[a.length - 1] ? "every pool seen" : "pools read"); return r; }; }
        if (sql.includes("indexed by fi_pools_life_order left join fi_names")) ways.add("released order");
        return st;
      };
      let reads = 0;
      for (const x of qs) {
        const n = ways.size;
        expect(R.coins(ro, ctx, x, now), label(x)).deep.eq(released(ro, ctx, x, now));
        reads += ways.size - n;
      }
      ro.prepare = prepare;
      expect([...ways].sort()).deep.eq(["every pool seen", "pools read", "released order"]);
      expect(reads).gt(0);
      compare(fi.db.db, fi.db.db, qs);
    } finally { R.PAGE_TUNING.searchCandidatesMax = was; ro.close(); await fi.close(); }
  });

  it("the API refuses a search page past the search depth, and refreshes only names and logos after reading them", async function () {
    this.timeout(120_000);
    const fi = new FeeIndex({ connection: {} } as any, store, file, opts(true));
    await fi.open();
    // the identity read stands in for the network: it names every mint it is asked for
    const asked: string[][] = [];
    (fi as any).ensureIdentity = async (mints: string[]) => {
      asked.push(mints);
      const set = fi.db.db.prepare("insert into fi_names (mint, name, symbol, uri, image, checked_at) values (?, ?, ?, null, ?, 1) on conflict (mint) do update set name = excluded.name, symbol = excluded.symbol, image = excluded.image");
      for (const m of mints) set.run(m, `Named ${m}`, `N${m}`, `https://img.example/${m}.png`);
    };
    const port = 18_000 + Math.floor(Math.random() * 2_000);
    const api = await startApi(store, { host: "127.0.0.1", port, origins: [], ratePerMinute: 10_000, cluster: "localnet", feeIndex: fi });
    const get = (p: string) => new Promise<{ code: number; body: any }>((res, rej) => http.get(`http://127.0.0.1:${port}${p}`, (r) => { let b = ""; r.on("data", (d) => (b += d)); r.on("end", () => res({ code: r.statusCode ?? 0, body: JSON.parse(b) })); }).on("error", rej));
    try {
      const deep = await get(`/api/fees/coins?q=coin&offset=${R.SEARCH_OFFSET_MAX + 1}`);
      expect(deep.code).eq(400); expect(deep.body.error).match(/at most 1000 results deep/);
      expect((await get(`/api/fees/coins?q=coin&offset=${R.SEARCH_OFFSET_MAX}`)).code).eq(200);
      expect((await get("/api/fees/coins?offset=30000")).code).eq(200); // only a search is capped
      const nowMs = Date.now();
      const before = await fi.readCoins(q({ sort: "lifetime", offset: 3 }), nowMs);
      const lacking = before.filter((c: any) => !c.name || !c.imageUrl).map((c: any) => c.mint);
      expect(lacking.length).gt(0);
      const page = await get("/api/fees/coins?sort=lifetime&offset=3&limit=50");
      expect(page.code).eq(200);
      expect(asked.at(-1)).deep.eq(lacking);
      // the same coins in the same order with the names just read: what reading the whole page again gives
      const again = await fi.readCoins(q({ sort: "lifetime", offset: 3 }), nowMs);
      const strip = (c: any) => ({ ...c, creatorAvgPerDayEstimateLamports: undefined });
      expect(page.body.coins.map(strip)).deep.eq(again.map(strip));
      expect(page.body.coins.filter((c: any) => lacking.includes(c.mint)).every((c: any) => c.name === `Named ${c.mint}`)).eq(true);
    } finally { api.close(); await fi.close(); }
  });
});
