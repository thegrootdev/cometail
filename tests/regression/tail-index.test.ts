// The tail index's walk (worker/src/tails.ts): pages newest to oldest, completes only when the whole history
// is read, stops at an unreadable transaction (retried, never skipped), resumes across passes and stores each
// row once; the view traces reserve inflows to buybacks and totals a tail's claims.
import { createHash } from "crypto";
import { Keypair, PublicKey } from "@solana/web3.js";
import { NATIVE_MINT } from "@solana/spl-token";
import { expect } from "chai";
import fs from "fs";
import os from "os";
import path from "path";
import { openStore } from "../../worker/src/store";
import { parseTails, tailView, walkPass, type TxView, type WalkDeps } from "../../worker/src/tails";

const sigOf = (i: number) => createHash("sha256").update(`tail${i}`).digest().toString("hex").replace(/[0OIl]/g, "1").slice(0, 88).padEnd(88, "A");
async function freshStore() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "tail-index-"));
  const store = openStore(`sqlite:${path.join(dir, "store.sqlite")}`); await store.init();
  return store;
}
function chain(n: number) {
  const sigs = Array.from({ length: n }, (_, i) => ({ signature: sigOf(i + 1), slot: 1000 + i, err: null as unknown, blockTime: 1_700_000_000 + i }));
  const unreadable = new Set<string>();
  const view = (s: (typeof sigs)[number]): TxView => ({ signature: s.signature, slot: s.slot, blockTime: s.blockTime, err: false, signer: "x", inner: [], logs: [], tokenDelta: () => null });
  const deps: WalkDeps = {
    getSignatures: async (_a, { before, until, limit }) => {
      const desc = [...sigs].reverse();
      let start = 0;
      if (before) { start = desc.findIndex((s) => s.signature === before) + 1; if (start === 0) return []; }
      const out: typeof sigs = [];
      for (let k = start; k < desc.length && out.length < limit; k++) { if (until && desc[k].signature === until) break; out.push(desc[k]); }
      return out;
    },
    readView: async (sig) => (unreadable.has(sig) ? null : view(sigs.find((s) => s.signature === sig)!)),
  };
  return { sigs, deps, unreadable, add: (k: number) => { for (let j = 0; j < k; j++) { const i = sigs.length + 1; sigs.push({ signature: sigOf(i), slot: 1000 + i, err: null, blockTime: 1_700_000_000 + i }); } } };
}
const rowsOf = (v: TxView) => [{ signature: v.signature, idx: 0, slot: v.slot, blockTime: v.blockTime, name: "reserveFlow", data: { delta: "1", burnedRaw: null, spentLamports: null } }];

describe("tail index walk", () => {
  it("reads 450 transactions across passes, completes once, and stores each once", async () => {
    const store = await freshStore();
    const c = chain(450);
    const a = Keypair.generate().publicKey;
    const r1 = await walkPass(c.deps, store, a, "reserve", rowsOf, 200);
    expect(r1).deep.eq({ stored: 200, complete: false });
    const r2 = await walkPass(c.deps, store, a, "reserve", rowsOf, 200);
    expect(r2.complete).eq(false);
    const r3 = await walkPass(c.deps, store, a, "reserve", rowsOf, 200);
    expect(r3).deep.eq({ stored: 50, complete: true });
    expect((await store.listTailEvents("reserveFlow")).length).eq(450);
    // new transactions: only those are read
    c.add(5);
    expect(await walkPass(c.deps, store, a, "reserve", rowsOf, 200)).deep.eq({ stored: 5, complete: true });
    expect((await store.listTailEvents("reserveFlow")).length).eq(455);
    // a re-read of the same history stores nothing twice
    await store.setMeta("walk:reserve", JSON.stringify({ head: null, newHead: null, tail: null, target: null }));
    for (let i = 0; i < 4; i++) await walkPass(c.deps, store, a, "reserve", rowsOf, 200);
    expect((await store.listTailEvents("reserveFlow")).length).eq(455);
  });

  it("stops at an unreadable transaction and is not complete until it reads", async () => {
    const store = await freshStore();
    const c = chain(30);
    const a = Keypair.generate().publicKey;
    c.unreadable.add(sigOf(12));
    const r = await walkPass(c.deps, store, a, "reserve", rowsOf, 200);
    expect(r.complete).eq(false);
    expect((await store.listTailEvents("reserveFlow")).length).eq(18); // 30..13
    expect(JSON.parse((await store.getMeta("walk_coverage:reserve"))!).status).eq("partial");
    c.unreadable.clear();
    expect((await walkPass(c.deps, store, a, "reserve", rowsOf, 200)).complete).eq(true);
    expect((await store.listTailEvents("reserveFlow")).length).eq(30);
  });

  it("COMETAIL_TAILS: mint:config:targetPool[:position], the curve derived from the mint and config", () => {
    const [m, c, p, pos] = [0, 1, 2, 3].map(() => Keypair.generate().publicKey);
    const [t] = parseTails(` ${m.toBase58()}:${c.toBase58()}:${p.toBase58()}:${pos.toBase58()} `);
    expect(t.mint.equals(m) && t.config.equals(c) && t.targetPool.equals(p) && t.position!.equals(pos)).true;
    const big = m.toBuffer().compare(NATIVE_MINT.toBuffer()) > 0;
    const [curve] = PublicKey.findProgramAddressSync([Buffer.from("pool"), c.toBuffer(), (big ? m : NATIVE_MINT).toBuffer(), (big ? NATIVE_MINT : m).toBuffer()], new PublicKey("dbcij3LWUppWqq96dh6gJWwBifmcGfLSB5D4DuSMaqN"));
    expect(t.curve.equals(curve)).true;
    expect(parseTails("")).deep.eq([]);
    expect(parseTails(`${m.toBase58()}:${c.toBase58()}:${p.toBase58()}`)[0].position).eq(null);
    expect(() => parseTails(`${m.toBase58()}:${c.toBase58()}`)).throw(/mint:config:targetPool/);
  });

  it("the view: claims newest first, burned only once the reserve ledger is complete, totals summed", async () => {
    const store = await freshStore();
    const [m, c, p, pos] = [0, 1, 2, 3].map(() => Keypair.generate().publicKey);
    const tails = parseTails(`${m.toBase58()}:${c.toBase58()}:${p.toBase58()}:${pos.toBase58()}`);
    const claim = (signature: string, slot: number, claimed: bigint) => ({ signature, idx: 0, slot, blockTime: 1, name: "tailClaim", data: { tail: m.toBase58(), creator: "w", claimedLamports: String(claimed), toBurnLamports: String(claimed / 4n), swapInLamports: String(claimed / 8n + 1n), swapOutRaw: "500", addedRaw: "490", addedLamports: String(claimed / 8n - 3n), liquidity: "7", lockedLiquidity: "7" } });
    const flow = (signature: string, slot: number, delta: bigint, burned: bigint | null = null) => ({ signature, idx: 0, slot, blockTime: 1, name: "reserveFlow", data: { delta: String(delta), burnedRaw: burned === null ? null : String(burned), spentLamports: delta < 0n ? String(-delta) : null } });
    await store.insertTailEvents([claim("c1", 10, 400n), claim("c2", 20, 800n), flow("c1", 10, 100n), flow("b1", 15, -60n, 600n), flow("c2", 20, 200n)], "walk:x", "{}");
    let v: any = (await tailView(store, tails, null)).tails[0];
    expect(v.claims.map((r: any) => r.signature)).deep.eq(["c2", "c1"]);
    expect(v.claims[1].burn).eq(null); // the reserve ledger's coverage is unknown: no burned figure
    await store.setMeta("walk_coverage:reserve", JSON.stringify({ status: "complete", atMs: 1 }));
    v = (await tailView(store, tails, m.toBase58())).tails[0];
    expect(v.claims[1].burn).deep.eq({ spentLamports: "60", waitingLamports: "40", burnedRaw: "600", buybacks: ["b1"] });
    expect(v.claims[0].burn).deep.eq({ spentLamports: "0", waitingLamports: "200", burnedRaw: "0", buybacks: [] });
    expect(v.claims[1].keptLamports).eq(String(400n - 100n - 51n - 47n));
    expect(v.totals).deep.include({ claims: 2, claimedLamports: "1200", toBurnLamports: "300", burnedRaw: "600", liquidityLamports: String(47n + 97n), liquidityRaw: "980", lockedLiquidity: "14" });
    expect((await tailView(store, tails, Keypair.generate().publicKey.toBase58())).tails).deep.eq([]);
  });
});
