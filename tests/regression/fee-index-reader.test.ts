// The Fee Index's slow reads run in reader threads, never on the indexer's thread that also serves the API.
// On the mainnet index of 2026-10-19 (438,039 pools) the launchpad summary held that thread 4.1-4.7 s, the names
// and logos still due 2.0 and 2.1 s, a search 3.5 s, a deep page 3.7 s: every API answer waited (spike 203).
// These checks build an index of 100,000 pools in a file and hold: the threads answer exactly what the in-process
// reads answer; the API keeps answering /api/health while a slow Fee Index read runs (and, as a control, does not
// when the same read runs in-process); a read past its limit is refused and its thread starts again; a Fee Index
// route whose reader is down answers 503 while the rest of the API answers.
import { expect } from "chai";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import * as http from "http";
import { EventEmitter } from "events";
import { NATIVE_MINT } from "@solana/spl-token";
import { FeeIndex } from "../../worker/src/feeindex";
import { IndexReader, ReaderUnavailable } from "../../worker/src/feeindex-reader";
import { startApi } from "../../worker/src/api";
import { openStore } from "../../worker/src/store";

const POOLS = 100_000;
const OURS = ["CFG0", "CFG7"];
const opts = (readerThreads: boolean) => ({ fullEveryHours: 24, deltaEveryMinutes: 5, pageDelayMs: 0, claimLookupsPerPass: 10, namesPerPass: 50, imagesPerPass: 50, ourConfigs: OURS, readerThreads });

let file = "";
before(async function () {
  this.timeout(120_000);
  file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "fi-reader-")), "fi.sqlite");
  const store = openStore("sqlite::memory:"); await store.init();
  const fi = new FeeIndex({ connection: {} } as any, store, file, opts(false));
  await fi.open();
  for (let c = 0; c < 50; c++) fi.rememberConfig({ config: `CFG${c}`, quoteMint: NATIVE_MINT.toBase58(), feeClaimer: `L${c % 9}`, creatorPct: 50 + (c % 3) * 25, activationType: 1, partnerLocked: 0, creatorLocked: 100, threshold: 10n ** 12n, reasons: c % 4 === 0 ? ["creator liquidity vests"] : [] });
  const db = fi.db.db;
  const put = db.prepare("insert into fi_pools (pool, config, creator, mint, progress, ttq, creator_fee, partner_fee, quote_reserve, activation, launched_at, finish_ts, creator_life, day_income, day_hours, changed_at, updated_at) values (?, ?, ?, ?, ?, ?, ?, ?, 0, 0, ?, 0, ?, ?, ?, ?, ?)");
  const name = db.prepare("insert into fi_names (mint, name, symbol, uri, checked_at) values (?, ?, ?, ?, ?)");
  const now = Date.now();
  db.exec("begin");
  for (let i = 0; i < POOLS; i++) {
    const ttq = BigInt(1_000 + ((i * 7919) % 1_000_003));
    put.run(`P${i}`, `CFG${i % 50}`, `C${i % 997}`, `M${i}`, i % 11 === 0 ? 3 : 0, ttq.toString(), (ttq / 3n).toString(), (ttq / 5n).toString(), now - (i % 400) * 3_600_000, (ttq / 2n).toString(), ((i * 31) % 5_000).toString(), i % 13 === 0 ? 7 : 24, now, now);
    if (i % 2 === 0) name.run(`M${i}`, `Coin ${i}`, `C${i}`, i % 6 === 0 ? `https://meta.example/${i}.json` : null, i % 10 === 0 ? 0 : now);
  }
  db.exec("commit");
  fi.db.setMeta("first_full_at", String(now - 2 * 86_400_000));
  await fi.close();
});

/** The longest gap between 5 ms ticks of this thread while `work` runs. */
async function heldWhile(work: () => Promise<unknown>): Promise<number> {
  let max = 0, last = Date.now();
  const t = setInterval(() => { const n = Date.now(); max = Math.max(max, n - last); last = n; }, 5);
  await new Promise((r) => setTimeout(r, 30));
  await work();
  await new Promise((r) => setTimeout(r, 30));
  clearInterval(t);
  return max;
}

const QUERIES = [
  { sort: "day", stage: "all", eligible: false, creator: null, search: null, limit: 50, offset: 0 },
  { sort: "avg", stage: "all", eligible: false, creator: null, search: null, limit: 20, offset: 30 },
  { sort: "claimable", stage: "graduated", eligible: true, creator: null, search: null, limit: 20, offset: 0 },
  { sort: "lifetime", stage: "bonding", eligible: false, creator: "C5", search: null, limit: 20, offset: 0 },
  { sort: "day", stage: "all", eligible: false, creator: null, search: "coin 12", limit: 20, offset: 5_000 },
  { sort: "day", stage: "all", eligible: false, creator: null, search: "M4242", limit: 5, offset: 0 },
] as const;

describe("fee index reader threads (spike 203)", () => {
  it("answer exactly what the in-process reads answer", async function () {
    this.timeout(120_000);
    const store = openStore("sqlite::memory:"); await store.init();
    const fi = new FeeIndex({ connection: {} } as any, store, file, opts(true));
    await fi.open();
    try {
      const now = Date.now(); // the average order and the per-day figures depend on the time asked at
      for (const q of QUERIES) expect(await fi.readCoins(q as any, now)).deep.eq(fi.coins(q as any, now));
      expect(await fi.readCoin("M77", now)).deep.eq(fi.coin("M77", now));
      expect(await fi.readCoin("nope")).eq(null);
      expect(await fi.readStatus()).deep.eq(fi.status());
      const fromThread: any = await (fi as any).read("pass", "summarize");
      const here: any = fi.summarize(fromThread.generatedAtMs);
      expect(fromThread).deep.eq(here);
      expect(here.rankedBy).eq("last24h");
      expect(here.ourConfigs.map((c: any) => c.covered)).deep.eq([true, true]);
      expect(await fi.readSummary()).eq(null); // nothing stored before the first pass
      fi.db.setMeta("summary", JSON.stringify(here));
      expect(await fi.readSummary()).deep.eq(here);
      const due: string[] = await (fi as any).read("pass", "namesDue", 50);
      expect(due.length).eq(50);
      expect(due.every((m) => Number(m.slice(1)) % 50 === 0 || Number(m.slice(1)) % 50 === 7)).eq(true); // ours first
      const imgs: any[] = await (fi as any).read("pass", "imagesDue", null, 50);
      expect(imgs.length).eq(50);
    } finally { await fi.close(); }
  });

  it("keep this thread free while a slow read runs (and, run in-process, the same read holds it)", async function () {
    this.timeout(120_000);
    const store = openStore("sqlite::memory:"); await store.init();
    const inproc = new FeeIndex({ connection: {} } as any, store, file, opts(false));
    await inproc.open();
    const t0 = Date.now(); inproc.summarize(); const readMs = Date.now() - t0;
    const heldInproc = await heldWhile(async () => { await (inproc as any).read("pass", "summarize"); await inproc.readCoins(QUERIES[4] as any); });
    await inproc.close();
    const fi = new FeeIndex({ connection: {} } as any, store, file, opts(true));
    await fi.open();
    try {
      const heldThread = await heldWhile(async () => { await Promise.all([(fi as any).read("pass", "summarize"), fi.readCoins(QUERIES[4] as any), fi.readCoins(QUERIES[1] as any)]); });
      console.log(`      summarize in-process ${readMs} ms; this thread held ${heldInproc} ms in-process, ${heldThread} ms with reader threads`);
      expect(readMs).gte(150); // the read is real work at this size
      expect(heldInproc).gte(150);
      expect(heldThread).lt(100);
    } finally { await fi.close(); }
  });

  it("refuse a read past its limit, start the thread again, and refuse at once while it is down", async function () {
    this.timeout(60_000);
    const logs: string[] = [];
    const r = new IndexReader(file, { ourConfigs: OURS, fullEveryHours: 24, deltaEveryMinutes: 5 }, "test", { timeoutMs: 5 }, (msg) => logs.push(msg));
    await r.start();
    let err: unknown = null;
    try { await r.call("summarize"); } catch (e) { err = e; }
    expect(err).instanceOf(ReaderUnavailable); expect(String((err as Error).message)).match(/ran past 5 ms/);
    let now: unknown = null;
    try { await r.call("status"); } catch (e) { now = e; } // the thread is being stopped or is down
    expect(now).instanceOf(ReaderUnavailable);
    await new Promise((res) => setTimeout(res, 1_500));
    (r as any).opts.timeoutMs = 10_000;
    const s: any = await r.call("status");
    expect(s.pools).eq(POOLS);
    expect(logs).include("fee index reader stopped; starting it again");
    await r.close();
  });

  it("a read past its limit retires its thread at once: new reads are refused unposted, waiting reads settle once, one replacement answers (review 203 S1)", async function () {
    this.timeout(30_000);
    class Fake extends EventEmitter { posted: any[] = []; terminated = 0; postMessage(m: unknown) { this.posted.push(m); } terminate() { this.terminated++; } }
    const made: Fake[] = [];
    const makeThread = () => { const f = new Fake(); made.push(f); setImmediate(() => f.emit("message", { ready: true })); return f as any; };
    const logs: string[] = [];
    const r = new IndexReader("unused", { ourConfigs: [], fullEveryHours: 24, deltaEveryMinutes: 5 }, "fake", { timeoutMs: 20, makeThread }, (msg) => logs.push(msg));
    await r.start();
    const settled: string[] = [];
    const a = r.call("summarize").then(() => settled.push("a answered"), (e) => settled.push(`a ${e instanceof ReaderUnavailable} ${e.message}`));
    const b = r.call("status").then(() => settled.push("b answered"), (e) => settled.push(`b ${e instanceof ReaderUnavailable} ${e.message}`));
    await Promise.all([a, b]);
    expect(settled).deep.eq(["a true fee index read summarize ran past 20 ms", "b true fee index reader fake retired after a read ran past 20 ms"]);
    expect(made[0].posted.length).eq(2); expect(made[0].terminated).eq(1);
    // the old thread has not exited yet: a new read is refused at once and never posted to it
    let err: unknown = null;
    try { await r.call("status"); } catch (e) { err = e; }
    expect(err).instanceOf(ReaderUnavailable); expect(made[0].posted.length).eq(2);
    // its late answer and its delayed exit change nothing: no second refusal, no second replacement
    made[0].emit("message", { id: 2, ok: true, value: "late" });
    made[0].emit("exit", 1);
    await new Promise((res) => setTimeout(res, 1_300));
    expect(made.length).eq(2); expect(made[0].terminated).eq(1);
    expect(logs.filter((l) => l === "fee index reader stopped; starting it again").length).eq(1);
    expect(settled.length).eq(2);
    const p = r.call("status");
    const m = made[1].posted[0];
    made[1].emit("message", { id: m.id, ok: true, value: { pools: 5 } });
    expect(await p).deep.eq({ pools: 5 });
    await r.close();
  });

  it("a replacement that fails to start is tried again with capped backoff until one starts; closing during the backoff stops it (review 203 S2)", async function () {
    this.timeout(30_000);
    class Fake extends EventEmitter { posted: any[] = []; terminated = 0; postMessage(m: unknown) { this.posted.push(m); } terminate() { this.terminated++; } }
    const made: Fake[] = [];
    let failNext = 0;
    const makeThread = () => {
      const f = new Fake(); made.push(f);
      const fail = failNext > 0; if (fail) failNext--;
      setImmediate(() => (fail ? f.emit("exit", 1) : f.emit("message", { ready: true })));
      return f as any;
    };
    const sleep = (ms: number) => new Promise((res) => setTimeout(res, ms));
    const logs: string[] = [];
    const r = new IndexReader("unused", { ourConfigs: [], fullEveryHours: 24, deltaEveryMinutes: 5 }, "fake", { timeoutMs: 1_000, makeThread, backoffMs: 20, maxBackoffMs: 80 }, (msg) => logs.push(msg));
    await r.start();
    failNext = 3;
    made[0].emit("exit", 1); // the live thread stops; its three replacements fail to start, the fourth starts
    let refused = 0;
    for (let i = 0; i < 100 && made.length < 5; i++) { try { await r.call("status"); } catch (e) { if (e instanceof ReaderUnavailable) refused++; } await sleep(10); }
    await sleep(20);
    expect(made.length).eq(5);
    expect(refused).gt(0);
    expect(logs.filter((l) => l === "fee index reader stopped; starting it again").length).eq(1);
    expect(logs.filter((l) => l === "fee index reader could not start; trying again").length).eq(3);
    const p = r.call("status");
    made[4].emit("message", { id: made[4].posted[0].id, ok: true, value: "back" });
    expect(await p).eq("back");
    // the restored thread stops again and the first replacement fails: closing during the backoff ends it
    failNext = 1;
    made[4].emit("exit", 1);
    await sleep(60);
    const before = made.length;
    await r.close();
    await sleep(300);
    expect(made.length).eq(before);
    let err: unknown = null;
    try { await r.call("status"); } catch (e) { err = e; }
    expect(err).instanceOf(ReaderUnavailable);
  });

  it("does not open a file that is not there", async () => {
    const r = new IndexReader(path.join(os.tmpdir(), "no-such-dir-203", "x.sqlite"), { ourConfigs: [], fullEveryHours: 24, deltaEveryMinutes: 5 }, "test", {}, () => {});
    let err: unknown = null;
    try { await r.start(); } catch (e) { err = e; }
    expect(err).not.eq(null);
    await r.close();
  });

  it("the API thread stays free while a slow Fee Index page runs; a Fee Index route whose reader is down is a 503, the rest answers", async function () {
    this.timeout(120_000);
    const store = openStore("sqlite::memory:"); await store.init();
    const get = (port: number, p: string) => new Promise<{ code: number; ms: number; body: any }>((res, rej) => { const t = Date.now(); http.get({ host: "127.0.0.1", port, path: p }, (r) => { let b = ""; r.on("data", (d) => (b += d)); r.on("end", () => res({ code: r.statusCode ?? 0, ms: Date.now() - t, body: b ? JSON.parse(b) : null })); }).on("error", rej); });
    const run = async (readerThreads: boolean) => {
      const fi = new FeeIndex({ connection: {} } as any, store, file, opts(readerThreads));
      await fi.open();
      const port = 18_000 + Math.floor(Math.random() * 2_000);
      const api = await startApi(store, { host: "127.0.0.1", port, origins: [], ratePerMinute: 100_000, cluster: "devnet", feeIndex: fi });
      try {
        // the API server runs on this test's thread, so the gap between this thread's ticks is how long the API
        // could not answer anything (a client on the same thread cannot see that itself)
        let page: { code: number; ms: number } = { code: 0, ms: 0 };
        const worst = await heldWhile(async () => { page = await get(port, "/api/fees/coins?sort=avg&offset=50000&limit=20"); });
        expect(page.code).eq(200);
        expect((await get(port, "/api/health")).code).eq(200);
        return { worst, fi, port, api, searchMs: page.ms };
      } catch (e) { api.close(); await fi.close(); throw e; }
    };
    const inproc = await run(false);
    inproc.api.close(); await inproc.fi.close();
    const th = await run(true);
    try {
      console.log(`      avg page at offset 50,000: ${inproc.searchMs} ms in-process (API thread held ${inproc.worst} ms), ${th.searchMs} ms in the reader (held ${th.worst} ms)`);
      expect(inproc.worst).gte(100);
      expect(th.worst).lt(100);
      await (th.fi as any).apiReader.close();
      const refused = await get(th.port, "/api/fees/status");
      expect(refused.code).eq(503); expect(refused.body.error).match(/busy/);
      expect((await get(th.port, "/api/health")).code).eq(200);
    } finally { th.api.close(); await th.fi.close(); }
  });
});
