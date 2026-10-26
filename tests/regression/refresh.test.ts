// Answers that read outside the process (the SOL price, /api/stats, /api/burn) must not hold a visitor while a
// price source or the RPC stalls (spike 228: on 2026-10-25 a stalled lookup held token, burn, price and stats
// answers 9 to 21 s). worker/src/refresh.ts: a fresh value as it is, an older one at once with one refresh behind it,
// a wait only with no value or one past its limit, one shared read, and a failed read keeps the last value.
import { expect } from "chai";
import { staleWhileRefresh } from "../../worker/src/refresh";
import { priceCache } from "../../worker/src/api";

const deferred = <T>() => { let res!: (v: T) => void, rej!: (e: unknown) => void; const p = new Promise<T>((a, b) => { res = a; rej = b; }); return { p, res, rej }; };
const tick = () => new Promise((r) => setImmediate(r));

describe("stale-while-refresh (spike 228)", () => {
  it("serves a fresh value without reading, and shares one read among concurrent first callers", async () => {
    let t = 0, reads = 0; const d = deferred<number>();
    const c = staleWhileRefresh(() => { reads++; return d.p; }, { ttlMs: 100, maxStaleMs: 1000, now: () => t });
    const a = c.get(), b = c.get();
    d.res(7);
    expect([await a, await b]).to.deep.eq([7, 7]);
    expect(reads).to.eq(1);
    t = 50; expect(await c.get()).to.eq(7); expect(reads).to.eq(1);
  });

  it("past its ttl returns the last value at once while one refresh runs, then the new one", async () => {
    let t = 0, reads = 0; let d = deferred<number>();
    const c = staleWhileRefresh(() => { reads++; return d.p; }, { ttlMs: 100, maxStaleMs: 1000, now: () => t });
    const first = c.get(); d.res(1); await first;
    t = 200; d = deferred<number>();
    // the refresh hangs: every caller still gets the last value at once, and only one read is started
    expect(await c.get()).to.eq(1); expect(await c.get()).to.eq(1);
    expect(reads).to.eq(2);
    d.res(2); await tick();
    expect(await c.get()).to.eq(2);
    expect(reads).to.eq(2);
  });

  it("a failed or refused refresh keeps the last value; past maxStaleMs the caller waits and gets the failure", async () => {
    let t = 0; let next: () => Promise<number | null> = async () => 5; const errors: unknown[] = [];
    const c = staleWhileRefresh(() => next(), { ttlMs: 100, maxStaleMs: 1000, keep: (v) => v !== null, now: () => t, onError: (e) => errors.push(e) });
    expect(await c.get()).to.eq(5);
    t = 200; next = async () => { throw new Error("rpc down"); };
    expect(await c.get()).to.eq(5); await tick();
    expect(errors.length).to.eq(1);
    next = async () => null; // refused (e.g. "unavailable"): not kept
    expect(await c.get()).to.eq(5); await tick();
    expect(c.peek()).to.deep.eq({ at: 0, value: 5 });
    t = 1500; // too old: the caller waits for the read and sees its result, the old value is not served
    expect(await c.get()).to.eq(null);
    next = async () => { throw new Error("rpc down"); };
    let caught: unknown = null; try { await c.get(); } catch (e) { caught = e; }
    expect(String(caught)).to.contain("rpc down");
  });

  it("the SOL price: a stalled source no longer holds an answer once a price exists", async () => {
    let t = 1_000_000, calls = 0; let mode: "ok" | "hang" = "ok"; let hung: (() => void) | null = null;
    const fake = (async (url: string) => {
      calls++;
      if (mode === "hang") await new Promise<void>((r) => { hung = r; });
      return { ok: true, json: async () => (String(url).includes("jup.ag") ? { So11111111111111111111111111111111111111112: { usdPrice: 150 } } : { solana: { usd: 150 } }) } as any;
    }) as unknown as typeof fetch;
    const price = priceCache(fake, () => t);
    expect((await price())?.solUsd).to.eq(150);
    t += 61_000; mode = "hang";
    const started = Date.now(); const p = await price();
    expect(p?.solUsd).to.eq(150); expect(Date.now() - started).to.be.below(100);
    expect(calls).to.eq(2);
    // no source answers on the first read at all: null, as before
    const none = priceCache((async () => { throw new Error("down"); }) as unknown as typeof fetch, () => t);
    expect(await none()).to.eq(null);
    (hung as (() => void) | null)?.();
  });
});
