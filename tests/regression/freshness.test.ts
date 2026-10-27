// The worker keeps /api/stats and /api/burn past their age while one read refreshes them, and keeps them when a read
// fails (spike 228, worker/src/refresh.ts), so an answer that arrives is not always a new read. The home figures, the
// home burn line and the burn panel showed every answer that arrived as live. Each answer now carries servedAtMs, and
// web/src/lib/freshness.ts shows a figure as live only while its own read is recent, with its read time otherwise.
import { expect } from "chai";
import http from "http";
import { startApi } from "../../worker/src/api";
import { staleWhileRefresh } from "../../worker/src/refresh";
import { openStore } from "../../worker/src/store";
import { burnPanelRead, burnStatState, homeNumbersState, isLive, LIVE_FOR_MS, pollFigures, RECHECK_MS, utcTime } from "../../web/src/lib/freshness";
import { burnPanel, home } from "../../web/src/content/cometail";

const MIN = 60_000;
const T = Date.parse("2026-10-27T03:00:00Z");
const stats = (generatedAtMs: number, burnReadAtMs: number | null, servedAtMs?: number) =>
  ({ generatedAtMs, ...(servedAtMs === undefined ? {} : { servedAtMs }), burn: burnReadAtMs === null ? null : { readAtMs: burnReadAtMs } });

describe("live figures only while their read is recent (spike 228)", () => {
  it("the worker stamps a kept /api/stats and /api/burn answer with the time it left, so its age shows", async () => {
    const store = openStore("sqlite::memory:"); await store.init();
    const kept = { stats: { schemaVersion: 1, generatedAtMs: Date.now() - 5 * MIN, burn: { readAtMs: Date.now() - 6 * MIN } }, burn: { status: "live", generatedAtMs: Date.now() - 4 * MIN } };
    const port = 20_000 + Math.floor(Math.random() * 2_000);
    const api = await startApi(store, { host: "127.0.0.1", port, origins: [], ratePerMinute: 10_000, cluster: "localnet", stats: async () => kept.stats, burnView: async () => kept.burn });
    const get = (p: string) => new Promise<any>((res, rej) => http.get(`http://127.0.0.1:${port}${p}`, (r) => { let b = ""; r.on("data", (d) => (b += d)); r.on("end", () => res(JSON.parse(b))); }).on("error", rej));
    try {
      const before = Date.now(); const s = await get("/api/stats"); const b = await get("/api/burn");
      expect(s.servedAtMs).to.be.within(before, Date.now()); expect(b.servedAtMs).to.be.within(before, Date.now());
      expect(s.generatedAtMs).to.eq(kept.stats.generatedAtMs); expect(b.generatedAtMs).to.eq(kept.burn.generatedAtMs);
      expect((kept.stats as any).servedAtMs).to.eq(undefined); // the kept document itself is not changed
      // a cached HTTP 200: what the pages make of it
      const h = homeNumbersState(s, false);
      expect(h.live).to.eq(false); expect(h.docLive).to.eq(false);
      expect(h.stale).to.eq(`${home.numbers.stale} · ${utcTime(kept.stats.burn.readAtMs)}`);
      expect(burnStatState(b, false).live).to.eq(false);
      expect(burnPanelRead(b)).to.deep.eq({ live: false, line: burnPanel.lastKnownAt(utcTime(kept.burn.generatedAtMs)) });
    } finally { await new Promise((r) => api.close(r)); await (store as any).close?.(); }
  });

  it("home figures: a new document is live; an old one is last known with its read time; a failed read keeps last known", () => {
    const fresh = homeNumbersState(stats(T, T - 10_000, T + 20_000), false);
    expect(fresh).to.deep.include({ live: true, docLive: true, burnLive: true, label: home.numbers.label, title: undefined, stale: null });
    const old = homeNumbersState(stats(T, T - 10_000, T + 4 * MIN), false);
    expect(old).to.deep.include({ live: false, docLive: false, burnLive: false, label: home.numbers.lastKnown });
    expect(old.stale).to.eq(`${home.numbers.stale} · ${utcTime(T - 10_000)}`); // the burn read inside it is the oldest
    expect(old.title).to.contain(home.numbers.lastKnown).and.contain("02:59:50 GMT");
    // a document that is new but failed to arrive since: last known, as before
    const failed = homeNumbersState(stats(T, T, T + 1_000), true);
    expect(failed).to.deep.include({ live: false, docLive: false, label: home.numbers.lastKnown });
    expect(failed.stale).to.eq(`${home.numbers.stale} · ${utcTime(T)}`);
  });

  it("a new stats document carrying an old burn read: traded and fees live, the burn figure last known with its time", () => {
    const f = homeNumbersState(stats(T, T - 7 * MIN, T + 30_000), false);
    expect(f).to.deep.include({ live: false, docLive: true, burnLive: false, label: home.numbers.lastKnown });
    expect(f.stale).to.eq(`${home.numbers.stale} · ${utcTime(T - 7 * MIN)}`);
    // no burn figure at all (program not live): nothing to mark
    expect(homeNumbersState(stats(T, null, T + 30_000), false)).to.deep.include({ live: true, burnLive: true, stale: null });
  });

  it("a genuinely new read restores live; the limit is measured on the worker's clock, not the visitor's", () => {
    expect(homeNumbersState(stats(T - 4 * MIN, T - 4 * MIN, T), false).live).to.eq(false);
    expect(homeNumbersState(stats(T, T, T + 1_000), false).live).to.eq(true);
    // the visitor's clock never enters: an answer read and served long ago (by the visitor's clock) is still live
    expect(isLive(T, T + LIVE_FOR_MS.burn, LIVE_FOR_MS.burn)).to.eq(true);
    expect(isLive(T, T + LIVE_FOR_MS.burn + 1, LIVE_FOR_MS.burn)).to.eq(false);
    expect(isLive(null, T, LIVE_FOR_MS.burn)).to.eq(false);
    // a worker older than the cache sends no servedAtMs and read for every answer: live, as before
    expect(isLive(T - 60 * MIN, undefined, LIVE_FOR_MS.stats)).to.eq(true);
  });

  it("the home burn line and the burn panel: the live indicator only for a recent read, the read time otherwise", () => {
    const live = { status: "live", generatedAtMs: T, servedAtMs: T + 20_000 };
    expect(burnStatState(live, false)).to.deep.eq({ live: true, title: undefined, stale: null });
    expect(burnPanelRead(live)).to.deep.eq({ live: true, line: burnPanel.readAt(utcTime(T)) });
    const kept = { ...live, servedAtMs: T + 3 * MIN };
    expect(burnStatState(kept, false)).to.deep.include({ live: false, stale: `${home.lastKnown} · ${utcTime(T)}` });
    expect(burnStatState(kept, false).title).to.contain(home.burnedLastKnown);
    expect(burnPanelRead(kept)).to.deep.eq({ live: false, line: burnPanel.lastKnownAt(utcTime(T)) });
    // a failed read (or a non-live status) after a live one: the last figure, last known with its time
    expect(burnStatState(live, true)).to.deep.include({ live: false, stale: `${home.lastKnown} · ${utcTime(T)}` });
    // the wording no longer claims a failure
    expect(home.numbers.lastKnown).to.not.match(/failed/); expect(home.burnedLastKnown).to.not.match(/not answering/);
  });

  it("the stats build waits for a burn read newer than its age (fresh), and falls back to the last one if it fails", async () => {
    let t = 0, n = 0; let fail = false;
    const c = staleWhileRefresh(async () => { if (fail) throw new Error("rpc down"); return ++n; }, { ttlMs: 100, maxStaleMs: 1000, now: () => t });
    expect(await c.fresh()).to.eq(1);
    t = 50; expect(await c.fresh()).to.eq(1); expect(n).to.eq(1); // young: as it is
    t = 200; expect(await c.get()).to.eq(1); await new Promise((r) => setImmediate(r)); // get serves the kept one...
    t = 400; expect(await c.fresh()).to.eq(3); // ...fresh waits for a new read (get's refresh made 2)
    t = 600; fail = true; expect(await c.fresh()).to.eq(3); // a failed read: the last one, dated by its own read time
    const none = staleWhileRefresh(async () => { throw new Error("rpc down"); }, { ttlMs: 100, maxStaleMs: 1000 });
    let caught: unknown = null; try { await none.fresh(); } catch (e) { caught = e; }
    expect(String(caught)).to.contain("rpc down");
  });

  it("a page asks again soon after an answer that is not live, at its own pace otherwise", async () => {
    const waits: number[] = []; const real = global.setTimeout;
    (global as any).setTimeout = (fn: () => void, ms: number) => { waits.push(ms); return real(() => undefined, 0); };
    try {
      const answers = [true, false]; let i = 0;
      const stop = pollFigures(async () => answers[i++] ?? false, 60_000);
      await new Promise((r) => setImmediate(r));
      expect(waits).to.deep.eq([RECHECK_MS]);
      stop();
    } finally { (global as any).setTimeout = real; }
  });
});
