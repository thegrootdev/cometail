// The burn program's history and its view (review 133): the index never skips a transaction (5,001
// signatures, an unreadable one mid-walk, new ones arriving during a backfill, restarts), burn events live
// in their own table (a vault event of the same signature and index cannot drop them), retries are
// idempotent, the view reads state and reserve from one snapshot, and burns are listed apart from splits.
import { createHash } from "crypto";
import { PublicKey, Keypair } from "@solana/web3.js";
import { expect } from "chai";
import fs from "fs";
import os from "os";
import path from "path";
import { BURN_PROGRAM_ID } from "@cometail/client";
import { openStore } from "../../worker/src/store";
import { burnIndexPass, readCursor, BURN_EVENT_NAMES, type BurnIndexDeps } from "../../worker/src/burnindex";
import { burnHistory, parseBurnCursor } from "../../worker/src/burnview";

const disc = (name: string) => createHash("sha256").update(`event:${name}`).digest().subarray(0, 8);
const u64 = (v: bigint) => { const b = Buffer.alloc(8); b.writeBigUInt64LE(v); return b; };
const i64 = (v: bigint) => { const b = Buffer.alloc(8); b.writeBigInt64LE(v); return b; };
function splitLog(claimed: bigint, carried = 0n): string {
  const amount = claimed + carried, half = amount / 2n;
  const data = Buffer.concat([disc("ClaimSplit"), Buffer.from([0]), Keypair.generate().publicKey.toBuffer(), PublicKey.default.toBuffer(), u64(claimed), u64(carried), u64(half), u64(amount - half), Keypair.generate().publicKey.toBuffer()]);
  return `Program data: ${data.toString("base64")}`;
}
function buyLog(spent: bigint, burned: bigint): string {
  const data = Buffer.concat([disc("BuybackBurned"), u64(spent), u64(burned), u64(burned), u64(1n), u64(1_000n), u64(1_000n), i64(1n)]);
  return `Program data: ${data.toString("base64")}`;
}
const wrap = (lines: string[]) => [`Program ${BURN_PROGRAM_ID.toBase58()} invoke [1]`, ...lines, `Program ${BURN_PROGRAM_ID.toBase58()} success`];
const sigOf = (i: number) => createHash("sha256").update(`sig${i}`).digest().toString("hex").replace(/[0OIl]/g, "1").slice(0, 88).padEnd(88, "A");

/** A chain of `n` burn transactions (sig1 oldest); every one carries one split, every 7th a buyback too. */
function chain(n: number) {
  const sigs = Array.from({ length: n }, (_, i) => ({ signature: sigOf(i + 1), slot: 1000 + i, err: null as unknown, blockTime: 1_700_000_000 + i }));
  const unreadable = new Set<string>();
  const deps: BurnIndexDeps = {
    getSignatures: async ({ before, until, limit }) => {
      const desc = [...sigs].reverse();
      let start = 0;
      if (before) { start = desc.findIndex((s) => s.signature === before) + 1; if (start === 0) return []; }
      const out: typeof sigs = [];
      for (let k = start; k < desc.length && out.length < limit; k++) { if (until && desc[k].signature === until) break; out.push(desc[k]); }
      return out;
    },
    readLogs: async (sig) => {
      if (unreadable.has(sig)) return null;
      const i = sigs.findIndex((s) => s.signature === sig) + 1;
      return { logs: wrap(i % 7 === 0 ? [splitLog(BigInt(i)), buyLog(BigInt(i), BigInt(i) * 10n)] : [splitLog(BigInt(i))]), blockTime: 1_700_000_000 + i };
    },
  };
  return { sigs, deps, unreadable, add: (k: number) => { for (let j = 0; j < k; j++) { const i = sigs.length + 1; sigs.push({ signature: sigOf(i), slot: 1000 + i, err: null, blockTime: 1_700_000_000 + i }); } } };
}
async function freshStore() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "burn-index-"));
  const store = openStore(`sqlite:${path.join(dir, "store.sqlite")}`); await store.init();
  return store;
}
const coverage = async (store: any) => JSON.parse((await store.getMeta("burn_coverage")) ?? "{}").status;
async function runToEnd(deps: BurnIndexDeps, store: any, perPass = 300) { for (let i = 0; i < 100; i++) { await burnIndexPass(deps, store, perPass); if ((await coverage(store)) === "complete") return i + 1; } throw new Error("never completed"); }

describe("burn index: never skips a transaction", () => {
  it("5,001 transactions at 300 per pass: every one stored, partial until the last pass, then complete", async () => {
    const c = chain(5001), store = await freshStore();
    await burnIndexPass(c.deps, store, 300);
    expect(await coverage(store)).eq("partial");
    const passes = await runToEnd(c.deps, store);
    expect(passes).gte(16);
    expect(await store.countBurnEvents(BURN_EVENT_NAMES.ClaimSplit)).eq(5001);
    expect(await store.countBurnEvents(BURN_EVENT_NAMES.BuybackBurned)).eq(Math.floor(5001 / 7));
    const oldest = await store.listBurnEvents(BURN_EVENT_NAMES.ClaimSplit, 1, { slot: 1001, idx: 0, signature: sigOf(2) });
    expect(oldest[0].signature).eq(sigOf(1));
    expect((await readCursor(store)).head).eq(sigOf(5001));
  });
  it("an unreadable transaction stops the pass at it, the next pass resumes there, and nothing is skipped", async () => {
    const c = chain(400), store = await freshStore();
    c.unreadable.add(sigOf(250));
    await burnIndexPass(c.deps, store, 1000);
    expect(await coverage(store)).eq("partial");
    expect(await store.countBurnEvents(BURN_EVENT_NAMES.ClaimSplit)).eq(150); // 400..251
    await burnIndexPass(c.deps, store, 1000);
    expect(await store.countBurnEvents(BURN_EVENT_NAMES.ClaimSplit)).eq(150);
    c.unreadable.clear();
    await runToEnd(c.deps, store);
    expect(await store.countBurnEvents(BURN_EVENT_NAMES.ClaimSplit)).eq(400);
  });
  it("transactions arriving during a backfill and after a long downtime are all picked up", async () => {
    const c = chain(1000), store = await freshStore();
    await burnIndexPass(c.deps, store, 300);
    c.add(700); // new transactions while the first cycle is open
    await runToEnd(c.deps, store);
    // the first cycle ended at its top: the 700 new ones belong to the next cycle
    await runToEnd(c.deps, store);
    expect(await store.countBurnEvents(BURN_EVENT_NAMES.ClaimSplit)).eq(1700);
    c.add(6000); // downtime: more than one walk's worth
    await runToEnd(c.deps, store);
    expect(await store.countBurnEvents(BURN_EVENT_NAMES.ClaimSplit)).eq(7700);
    expect((await readCursor(store)).head).eq(sigOf(7700));
  });
  it("a cursor from the first release (a bare signature) is not trusted as complete: the history is rebuilt", async () => {
    const c = chain(500), store = await freshStore();
    await store.setMeta("burn_cursor", sigOf(500));
    await runToEnd(c.deps, store);
    expect(await store.countBurnEvents(BURN_EVENT_NAMES.ClaimSplit)).eq(500);
  });
});

describe("burn index: its own table, idempotent", () => {
  it("a vault event with the same signature and index does not drop the burn event, in either order; retries add nothing", async () => {
    const c = chain(3), store = await freshStore();
    await store.insertEvents([{ signature: sigOf(3), idx: 0, slot: 1002, blockTime: 1, name: "harvested", vault: "V", data: {} }], sigOf(3));
    await runToEnd(c.deps, store);
    expect(await store.countBurnEvents(BURN_EVENT_NAMES.ClaimSplit)).eq(3);
    await store.insertEvents([{ signature: sigOf(1), idx: 0, slot: 1000, blockTime: 1, name: "harvested", vault: "V", data: {} }], sigOf(1));
    expect((await store.listEvents(null, 10)).length).eq(2);
    // a retry of the same rows (a crash before the cursor moved) adds nothing
    const rows = await store.listBurnEvents(BURN_EVENT_NAMES.ClaimSplit, 10, null);
    await store.insertBurnEvents(rows, JSON.stringify(await readCursor(store)));
    expect(await store.countBurnEvents(BURN_EVENT_NAMES.ClaimSplit)).eq(3);
  });
});

describe("burn view: burns listed apart from splits, paged", () => {
  it("100 newer splits do not hide an older burn; every burn pages out with a cursor", async () => {
    const c = chain(130), store = await freshStore();
    await runToEnd(c.deps, store);
    const first = await burnHistory(store, "burns", null, 10);
    expect(first.total).eq(Math.floor(130 / 7));
    expect(first.items.length).eq(10);
    const seen = [...first.items];
    let cursor = first.nextCursor;
    while (cursor) { const p = await burnHistory(store, "burns", parseBurnCursor(cursor) as any, 10); seen.push(...p.items); cursor = p.nextCursor; }
    expect(seen.length).eq(first.total);
    expect(new Set(seen.map((x) => x.signature)).size).eq(first.total);
    expect(parseBurnCursor("nonsense")).eq("invalid");
  });
});

import { BurnClient } from "@cometail/client";
import { BN as AnchorBN } from "@coral-xyz/anchor";
import { AccountLayout, MintLayout, NATIVE_MINT } from "@solana/spl-token";
import { burnViewer } from "../../worker/src/burnview";
describe("burn view: state and reserve from one read", () => {
  it("conservation uses one snapshot: the counters and the reserve come from the same call", async () => {
    const client = new BurnClient();
    const k = () => Keypair.generate().publicKey;
    const st: any = { setupBy: k(), cometailMint: k(), pool: k(), treasury: k(), reserve: k(), inbox: k(), placeholder: k(), bought: k(), baseFeeInfo: Array(32).fill(0), compoundingFeeBps: 5000, feeNumerator: new AnchorBN(10_000_000),
      splitTotal: new AnchorBN(100), splitToReserve: new AnchorBN(50), splitToTreasury: new AnchorBN(50), spentTotal: new AnchorBN(20), burnedTotal: new AnchorBN(7), buybacks: new AnchorBN(1), lastBuyTs: new AnchorBN(1), bump: 255, claimerBump: 255 };
    const stateData = await client.program.coder.accounts.encode("burnState", st);
    const reserveData = Buffer.alloc(165); AccountLayout.encode({ mint: NATIVE_MINT, owner: k(), amount: 30n, delegateOption: 0, delegate: PublicKey.default, state: 1, isNativeOption: 0, isNative: 0n, delegatedAmount: 0n, closeAuthorityOption: 0, closeAuthority: PublicKey.default } as any, reserveData);
    const mintData = Buffer.alloc(82); MintLayout.encode({ mintAuthorityOption: 0, mintAuthority: PublicKey.default, supply: 999n, decimals: 6, isInitialized: true, freezeAuthorityOption: 0, freezeAuthority: PublicKey.default } as any, mintData);
    const calls: number[] = [];
    const connection: any = {
      getMultipleAccountsInfoAndContext: async (keys: PublicKey[]) => { calls.push(keys.length); return { context: { slot: 42 }, value: keys.map((key) => key.equals(client.a.burnState) ? { data: stateData } : key.equals(st.reserve) ? { data: reserveData } : key.equals(st.cometailMint) ? { data: mintData } : null) }; },
    };
    const store = await freshStore();
    const view: any = await burnViewer({ connection, damm: { coder: { accounts: { decode: () => null } } } } as any, store, { cluster: "test", burnConfigs: [], legacyConfigs: [], feeIndex: null })();
    expect(view.status).eq("live");
    expect(view.observedSlot).eq(42);
    expect(view.sentDirectLamports).eq("0"); // 30 + 20 - 50
    expect(calls).deep.eq([1, 4]); // the state alone (to learn the addresses), then all four together
    expect(view.provenance.claimedByProgramLamports).eq(null); // history not indexed: unknown, not zero
  });
});
