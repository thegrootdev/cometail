// The tail index (worker/src/tails.ts) on synthetic transactions built from the pinned layouts:
//   - the walk: pages, completion, unreadable stops, resumes, idempotence;
//   - claims found and recorded whether split or not, each leg bound to its own instruction (review 156 R2, R3);
//   - the reserve's gross ledger: balance-linked order inside a slot, mixed inflow and buyback in one transaction,
//     tokens burned but not bought, breaks and ambiguity reported as unknown (R4, R5);
//   - the view: nothing totals to zero before its history is complete (R6).
// The happy path against the real Meteora binaries is gate 22.
import { createHash } from "crypto";
import { Keypair, PublicKey } from "@solana/web3.js";
import { NATIVE_MINT, TOKEN_PROGRAM_ID } from "@solana/spl-token";
import { expect } from "chai";
import fs from "fs";
import os from "os";
import path from "path";
import { BURN_PROGRAM_ID } from "@cometail/client";
import { openStore } from "../../worker/src/store";
import { deriveDammV2PoolAddress } from "@meteora-ag/dynamic-bonding-curve-sdk";
import { DAMM_V2_MIGRATION_CONFIGS } from "../../worker/src/chain";
import { creatorPositions, migrationPositions, originOf, parseCreatorTx, parsePositionTx, parseReserveTx, parseTails, refreshSources, tailIndexPass, traceReserve, tailView, walkPass, type Ix, type ReserveRow, type TxView, type WalkDeps } from "../../worker/src/tails";

const DBC = new PublicKey("dbcij3LWUppWqq96dh6gJWwBifmcGfLSB5D4DuSMaqN"), DAMM = new PublicKey("cpamdpZCGKUy5JxQXB4dcpGPiikHawvSWAd6mEn1sGG");
const TAG = Buffer.from([0xe4, 0x45, 0xa5, 0x2e, 0x51, 0xcb, 0x9a, 0x1d]);
const D = {
  claim: [154, 228, 215, 202, 133, 155, 214, 138], migFee: [26, 203, 84, 85, 161, 23, 100, 214], swapEv: [189, 66, 51, 168, 38, 80, 117, 153],
  liq: [197, 171, 78, 127, 224, 211, 87, 13], lockEv: [145, 143, 162, 218, 218, 80, 67, 11], posFee: [198, 182, 183, 52, 97, 12, 49, 56],
  dbcClaimIx: [82, 220, 250, 189, 3, 85, 107, 45], swapIx: [248, 198, 158, 145, 225, 117, 135, 200], addIx: [181, 157, 89, 67, 143, 182, 52, 72], lockIx: [165, 176, 125, 6, 231, 171, 186, 213],
};
const u8 = (v: number) => Buffer.from([v]);
const u64 = (v: bigint | number) => { const b = Buffer.alloc(8); b.writeBigUInt64LE(BigInt(v)); return b; };
const u128 = (v: bigint) => Buffer.concat([u64(v & 0xffffffffffffffffn), u64(v >> 64n)]);
const key = (p: PublicKey) => p.toBuffer();
const ev = (programId: PublicKey, disc: number[], ...fields: Buffer[]): Ix => ({ programId, accounts: [], data: Buffer.concat([TAG, Buffer.from(disc), ...fields]) });
const ixOf = (programId: PublicKey, disc: number[], accounts: PublicKey[]): Ix => ({ programId, accounts, data: Buffer.from(disc) });
const transfer = (source: PublicKey, dest: PublicKey, authority: PublicKey, amount: bigint): Ix => ({ programId: TOKEN_PROGRAM_ID, accounts: [source, dest, authority], data: Buffer.concat([u8(3), u64(amount)]) });
const disc = (name: string) => createHash("sha256").update(`event:${name}`).digest().subarray(0, 8);
const burnLog = (data: Buffer) => [`Program ${BURN_PROGRAM_ID.toBase58()} invoke [1]`, `Program data: ${data.toString("base64")}`, `Program ${BURN_PROGRAM_ID.toBase58()} success`];
const buybackLog = (spent: bigint, received: bigint, burned: bigint) => burnLog(Buffer.concat([disc("BuybackBurned"), u64(spent), u64(received), u64(burned), u64(1n), u64(1000n), u64(1000n), u64(1n)]));
const splitLog = (pool: PublicKey, claimant: PublicKey, claimed: bigint, toReserve: bigint) => burnLog(Buffer.concat([disc("ClaimSplit"), u8(3), key(pool), key(claimant), u64(claimed), u64(0n), u64(toReserve), u64(claimed - toReserve), key(claimant)]));

const k = () => Keypair.generate().publicKey;
const curve = k(), target = k(), reserve = k(), creator = k(), dest = k(), xAta = k(), position = k(), other = k();
const T = { curve: curve.toBase58(), targetPool: target.toBase58(), reserve: reserve.toBase58() };
/** The claim's top-level instruction and its event: DBC claim_creator_trading_fee accounts, token_b_account [3], creator [8]. */
const claimLeg = (quote: bigint, pool = curve): [Ix, Ix[]] => [ixOf(DBC, D.dbcClaimIx, [k(), pool, k(), dest, k(), k(), k(), NATIVE_MINT, creator]), [ev(DBC, D.claim, key(pool), u64(0n), u64(quote))]];
const burnLeg = (amount: bigint, from = dest): [Ix, Ix[]] => [transfer(from, reserve, creator, amount), []];
const buyLeg = (amountIn: bigint, out: bigint, direction = 1, input = dest): [Ix, Ix[]] => [ixOf(DAMM, D.swapIx, [k(), target, input, xAta]), [ev(DAMM, D.swapEv, key(target), u8(direction), u8(2), u8(0), u64(amountIn), u64(0n), u8(0), u64(amountIn), u64(amountIn), u64(0n), u64(out))]];
const addLeg = (a: bigint, b: bigint, delta: bigint, pos = position): [Ix, Ix[]] => [ixOf(DAMM, D.addIx, [target, pos]), [ev(DAMM, D.liq, key(target), key(pos), key(creator), u64(a), u64(b), u64(a), u64(b), u64(0n), u64(0n), u128(delta), u64(a), u64(b), u8(0))]];
const lockLeg = (amount: bigint, pos = position): [Ix, Ix[]] => [ixOf(DAMM, D.lockIx, [target, pos]), [ev(DAMM, D.lockEv, key(target), key(pos), u128(amount), u128(amount * 7n))]];
function view(legs: [Ix, Ix[]][], o: { logs?: string[]; reserve?: [bigint, bigint]; signature?: string; slot?: number; owners?: Map<string, string> } = {}): TxView {
  const inner = new Map<number, Ix[]>(); legs.forEach(([, i], n) => { if (i.length) inner.set(n, i); });
  return { signature: o.signature ?? "s", slot: o.slot ?? 1, blockTime: 1, err: false, top: legs.map(([t]) => t), inner, logs: o.logs ?? [], balance: (a) => (o.reserve && a.equals(reserve) ? { pre: o.reserve[0], post: o.reserve[1] } : null), ownerAfter: (a) => o.owners?.get(a.toBase58()) ?? null };
}

describe("tail index: claims (review 156 R2, R3)", () => {
  it("a full split is bound leg by leg; a claim with nothing after it is recorded as not split", () => {
    const full = parseCreatorTx(view([claimLeg(400n), burnLeg(100n), buyLeg(51n, 5000n), addLeg(4900n, 49n, 77n), lockLeg(77n)]), T).claims;
    expect(full).deep.eq([{ kind: "curve", claimedLamports: "400", creator: creator.toBase58(), status: "split", toBurn: { lamports: "100", source: dest.toBase58() }, buy: { inLamports: "51", outRaw: "5000" }, add: { position: position.toBase58(), addedRaw: "4900", addedLamports: "49", liquidity: "77" }, lockedLiquidity: "77" }]);
    const raw = parseCreatorTx(view([claimLeg(400n)]), T).claims;
    expect(raw.map((c) => [c.status, c.claimedLamports, c.toBurn])).deep.eq([["unsplit", "400", null]]);
  });
  it("missing legs make it incomplete; a lock of a different amount is not a lock of the add", () => {
    const onlyBurn = parseCreatorTx(view([claimLeg(400n), burnLeg(100n)]), T).claims[0];
    expect([onlyBurn.status, onlyBurn.toBurn?.lamports, onlyBurn.add]).deep.eq(["incomplete", "100", null]);
    const badLock = parseCreatorTx(view([claimLeg(400n), burnLeg(100n), buyLeg(51n, 5000n), addLeg(4900n, 49n, 77n), lockLeg(76n)]), T).claims[0];
    expect([badLock.status, badLock.lockedLiquidity]).deep.eq(["incomplete", null]);
  });
  it("a reverse swap, a swap from another account, a transfer from another account and legs before the claim are not split legs", () => {
    const c = parseCreatorTx(view([burnLeg(999n), buyLeg(9n, 9n), claimLeg(400n), buyLeg(999999n, 7n, 0), buyLeg(5n, 5n, 1, other), burnLeg(55n, other), burnLeg(100n), buyLeg(51n, 5000n), addLeg(4900n, 49n, 77n), lockLeg(77n)]), T).claims[0];
    expect([c.status, c.toBurn?.lamports, c.buy?.inLamports]).deep.eq(["split", "100", "51"]);
  });
  it("two buys, two adds or two transfers to the reserve after one claim are ambiguous: no legs reported", () => {
    for (const legs of [
      [claimLeg(400n), burnLeg(100n), buyLeg(25n, 2500n), buyLeg(26n, 2500n), addLeg(4900n, 49n, 77n), lockLeg(77n)],
      [claimLeg(400n), burnLeg(100n), buyLeg(51n, 5000n), addLeg(2000n, 20n, 30n), addLeg(2900n, 29n, 47n), lockLeg(77n)],
      [claimLeg(400n), burnLeg(50n), burnLeg(50n), buyLeg(51n, 5000n), addLeg(4900n, 49n, 77n), lockLeg(77n)],
    ]) {
      const c = parseCreatorTx(view(legs as [Ix, Ix[]][]), T).claims[0];
      expect([c.status, c.toBurn, c.buy, c.add]).deep.eq(["ambiguous", null, null, null]);
    }
    // two claims of the same curve in one transaction: both ambiguous
    expect(parseCreatorTx(view([claimLeg(400n), claimLeg(10n), burnLeg(100n)]), T).claims.map((c) => c.status)).deep.eq(["ambiguous", "ambiguous"]);
  });
  it("another curve's claim is ignored; the creator's graduation payout is recorded apart", () => {
    expect(parseCreatorTx(view([claimLeg(400n, k())]), T).claims).deep.eq([]);
    const p = parseCreatorTx(view([[ixOf(DBC, [1, 2, 3, 4, 5, 6, 7, 8], []), [ev(DBC, D.migFee, key(curve), u64(20n), u8(1)), ev(DBC, D.migFee, key(curve), u64(9n), u8(0))]]]), T);
    expect(p.payouts).deep.eq([{ kind: "migrationFee", lamports: "20" }]);
  });
  it("graduated position claims: through the burn owner claim is split, a direct claim is not split", () => {
    const pool = k();
    const fee = (feeB: bigint): [Ix, Ix[]] => [ixOf(DAMM, [1, 1, 1, 1, 1, 1, 1, 1], []), [ev(DAMM, D.posFee, key(pool), key(position), key(creator), u64(0n), u64(feeB))]];
    expect(parsePositionTx(view([fee(1000n)], { logs: splitLog(pool, creator, 1000n, 500n) }), new Set([position.toBase58()]), pool.toBase58())).deep.eq([{ kind: "pool", position: position.toBase58(), owner: creator.toBase58(), claimedLamports: "1000", status: "split", toBurn: { lamports: "500" } }]);
    expect(parsePositionTx(view([fee(1000n)]), new Set([position.toBase58()]), pool.toBase58())[0].status).eq("unsplit");
    expect(parsePositionTx(view([fee(1000n)]), new Set([k().toBase58()]), pool.toBase58())).deep.eq([]);
  });
});

describe("tail index: the reserve's gross ledger (review 156 R4, R5)", () => {
  const row = (signature: string, slot: number, legs: [Ix, Ix[]][], pre: bigint, post: bigint, logs: string[] = []): ReserveRow => ({ signature, slot, tx: parseReserveTx(view(legs, { reserve: [pre, post], logs, signature, slot }), reserve)! });
  const inflow = (amount: bigint, from = other): [Ix, Ix[]] => [transfer(from, reserve, creator, amount), []];
  const buyback = (spent: bigint): [Ix, Ix[]] => [ixOf(BURN_PROGRAM_ID, [9, 9, 9, 9, 9, 9, 9, 9], []), [transfer(reserve, k(), k(), spent)]];

  it("orders transactions inside a slot by their balances, not by signature", () => {
    const rows = [row("z-tail", 10, [inflow(100n)], 0n, 100n), row("a-other", 10, [inflow(100n)], 100n, 200n), row("buy", 11, [buyback(100n)], 200n, 100n, buybackLog(100n, 1000n, 1000n))];
    for (const order of [rows, [...rows].reverse(), [rows[1], rows[0], rows[2]]]) {
      const { traced, verified } = traceReserve(order);
      expect(verified).eq(true);
      expect(traced.get("z-tail#0")).deep.eq({ spentLamports: 100n, boughtRaw: 1000n, buybacks: ["buy"], exact: true });
      expect(traced.get("a-other#0")).deep.eq({ spentLamports: 0n, boughtRaw: 0n, buybacks: [], exact: true });
    }
  });
  it("more than one consistent order inside a slot makes those inflows inexact", () => {
    const rows = [row("start", 9, [inflow(100n)], 0n, 100n), row("x", 10, [inflow(100n)], 100n, 200n), row("y", 10, [buyback(100n)], 200n, 100n, buybackLog(100n, 1000n, 1000n)), row("z", 10, [inflow(100n)], 100n, 200n)];
    const { traced } = traceReserve(rows);
    expect(traced.get("x#0")!.exact).eq(false);
    expect(traced.get("z#0")!.exact).eq(false);
    expect(traced.get("start#0")!.exact).eq(true);
  });
  it("with two buybacks in an ambiguous slot, even SOL that arrived before it is attributed inexactly", () => {
    const rows = [row("start", 9, [inflow(200n)], 0n, 200n), row("x", 10, [inflow(100n)], 200n, 300n), row("y1", 10, [buyback(100n)], 300n, 200n, buybackLog(100n, 1000n, 1000n)), row("y2", 10, [buyback(100n)], 200n, 100n, buybackLog(100n, 3000n, 3000n)), row("z", 10, [inflow(100n)], 100n, 200n)];
    expect(traceReserve(rows).traced.get("start#0")!.exact).eq(false);
  });
  it("an inflow and a buyback in one transaction are gross legs in execution order", () => {
    const rows = [row("old", 10, [inflow(100n)], 0n, 100n), row("mixed", 11, [inflow(100n), buyback(150n)], 100n, 50n, buybackLog(150n, 1500n, 1500n))];
    const { traced, verified } = traceReserve(rows);
    expect(verified).eq(true);
    expect(traced.get("old#0")).deep.eq({ spentLamports: 100n, boughtRaw: 1000n, buybacks: ["mixed"], exact: true });
    expect(traced.get("mixed#0")).deep.eq({ spentLamports: 50n, boughtRaw: 500n, buybacks: ["mixed"], exact: true });
  });
  it("credits what a buyback bought, not tokens that were already in the bought account and burned with them", () => {
    const { traced } = traceReserve([row("tail", 10, [inflow(100n)], 0n, 100n), row("buy", 11, [buyback(100n)], 100n, 0n, buybackLog(100n, 500n, 1000n))]);
    expect(traced.get("tail#0")!.boughtRaw).eq(500n);
  });
  it("an unexplained movement, a gap in the balance chain, or a spend without its event makes what follows inexact", () => {
    const gap = traceReserve([row("a", 10, [inflow(100n)], 0n, 100n), row("b", 12, [inflow(50n)], 130n, 180n)]);
    expect([gap.verified, gap.traced.get("a#0")!.exact, gap.traced.get("b#0")!.exact]).deep.eq([false, false, false]);
    const unexplained = row("u", 10, [inflow(100n)], 0n, 90n);
    expect(unexplained.tx.ok).eq(false);
    expect(traceReserve([unexplained]).verified).eq(false);
    const noEvent = row("n", 11, [buyback(100n)], 100n, 0n);
    expect(noEvent.tx.ok).eq(false);
  });
});

describe("tail index: walk and view", () => {
  async function freshStore() {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "tail-index-"));
    const store = openStore(`sqlite:${path.join(dir, "store.sqlite")}`); await store.init();
    return store;
  }
  const sigOf = (i: number) => createHash("sha256").update(`tail${i}`).digest().toString("hex").replace(/[0OIl]/g, "1").slice(0, 88).padEnd(88, "A");
  function chain(n: number) {
    const sigs = Array.from({ length: n }, (_, i) => ({ signature: sigOf(i + 1), slot: 1000 + i, err: null as unknown, blockTime: 1_700_000_000 + i }));
    const unreadable = new Set<string>();
    const deps: WalkDeps = {
      getSignatures: async (_a, { before, until, limit }) => {
        const desc = [...sigs].reverse();
        let start = 0;
        if (before) { start = desc.findIndex((s) => s.signature === before) + 1; if (start === 0) return []; }
        const out: typeof sigs = [];
        for (let j = start; j < desc.length && out.length < limit; j++) { if (until && desc[j].signature === until) break; out.push(desc[j]); }
        return out;
      },
      readView: async (sig) => (unreadable.has(sig) ? null : { ...view([]), signature: sig }),
    };
    return { sigs, deps, unreadable, add: (m: number) => { for (let j = 0; j < m; j++) { const i = sigs.length + 1; sigs.push({ signature: sigOf(i), slot: 1000 + i, err: null, blockTime: 1_700_000_000 + i }); } } };
  }
  const rowsOf = (v: TxView) => [{ signature: v.signature, idx: 0, slot: v.slot, blockTime: v.blockTime, name: "probe", data: {} }];

  it("reads 450 transactions across passes, completes once, stores each once, stops at an unreadable one", async () => {
    const store = await freshStore();
    const c = chain(450), a = k();
    expect(await walkPass(c.deps, store, a, "x", rowsOf, 200)).deep.eq({ stored: 200, complete: false });
    await walkPass(c.deps, store, a, "x", rowsOf, 200);
    expect(await walkPass(c.deps, store, a, "x", rowsOf, 200)).deep.eq({ stored: 50, complete: true });
    c.add(5);
    expect(await walkPass(c.deps, store, a, "x", rowsOf, 200)).deep.eq({ stored: 5, complete: true });
    await store.setMeta("walk:x", JSON.stringify({ head: null, newHead: null, tail: null, target: null }));
    for (let i = 0; i < 4; i++) await walkPass(c.deps, store, a, "x", rowsOf, 200);
    expect((await store.listTailEvents("probe")).length).eq(455);
    const s2 = await freshStore(), c2 = chain(30);
    c2.unreadable.add(sigOf(12));
    expect((await walkPass(c2.deps, s2, a, "y", rowsOf, 200)).complete).eq(false);
    expect((await s2.listTailEvents("probe")).length).eq(18);
    c2.unreadable.clear();
    expect((await walkPass(c2.deps, s2, a, "y", rowsOf, 200)).complete).eq(true);
  });

  it("COMETAIL_TAILS: mint:config:targetPool, the curve derived from the mint and config", () => {
    const [m, c, p] = [k(), k(), k()];
    const [t] = parseTails(` ${m.toBase58()}:${c.toBase58()}:${p.toBase58()} `);
    const big = m.toBuffer().compare(NATIVE_MINT.toBuffer()) > 0;
    const [cv] = PublicKey.findProgramAddressSync([Buffer.from("pool"), c.toBuffer(), (big ? m : NATIVE_MINT).toBuffer(), (big ? NATIVE_MINT : m).toBuffer()], DBC);
    expect(t.mint.equals(m) && t.config.equals(c) && t.targetPool.equals(p) && t.curve.equals(cv)).true;
    expect(parseTails("")).deep.eq([]);
    expect(() => parseTails(`${m.toBase58()}:${c.toBase58()}`)).throw(/mint:config:targetPool/);
  });

  it("the view: no totals before the history is complete; every claim listed with its status; burn only when proven", async () => {
    const store = await freshStore();
    const m = k();
    const tails = parseTails(`${m.toBase58()}:${k().toBase58()}:${target.toBase58()}`);
    // fresh: no sources, no coverage -> nothing is zero, everything unknown (R6)
    let v: any = (await tailView(store, tails, null)).tails[0];
    expect(v.totals).deep.eq({ claims: null, notSplit: null, ambiguous: null, claimedLamports: null, toBurnLamports: null, boughtRaw: null, liquidityLamports: null, liquidityRaw: null, lockedLiquidity: null, payoutLamports: null });
    const c = creator.toBase58();
    await store.setMeta(`tail_sources:${m.toBase58()}`, JSON.stringify({ v: 2, origin: { creator: c, signature: "first" }, creators: [c], graduated: false, pool: null, migration: null }));
    await store.setMeta(`walk_coverage:tail:${m.toBase58()}:creator:${c}`, JSON.stringify({ status: "complete", atMs: 1 }));
    v = (await tailView(store, tails, null)).tails[0];
    expect(v.totals.claims).eq(0); // complete and empty: a verified zero
    expect(v.totals.boughtRaw).eq(null); // the reserve walk is not complete
    // one split claim, one unsplit claim; the reserve saw the split's quarter and a buyback spent part of it
    const split = parseCreatorTx(view([claimLeg(400n), burnLeg(100n), buyLeg(51n, 5000n), addLeg(4900n, 49n, 77n), lockLeg(77n)]), T).claims[0];
    const unsplit = parseCreatorTx(view([claimLeg(300n)]), T).claims[0];
    const rv = (sig: string, slot: number, legs: [Ix, Ix[]][], pre: bigint, post: bigint, logs: string[] = []) => ({ signature: sig, idx: 0, slot, blockTime: 1, name: "reserveTx", data: parseReserveTx(view(legs, { reserve: [pre, post], logs }), reserve) });
    await store.insertTailEvents([
      { signature: "claim1", idx: 0, slot: 10, blockTime: 1, name: `tailClaim:${m.toBase58()}`, data: split },
      { signature: "claim2", idx: 0, slot: 20, blockTime: 2, name: `tailClaim:${m.toBase58()}`, data: unsplit },
      rv("claim1", 10, [claimLeg(400n), burnLeg(100n)], 0n, 100n),
      rv("buy", 15, [[ixOf(BURN_PROGRAM_ID, [9, 9, 9, 9, 9, 9, 9, 9], []), [transfer(reserve, k(), k(), 60n)]]], 100n, 40n, buybackLog(60n, 600n, 600n)),
    ], "walk:z", "{}");
    v = (await tailView(store, tails, m.toBase58())).tails[0];
    expect(v.claims.map((x: any) => [x.signature, x.status, x.keptLamports, x.burn])).deep.eq([["claim2", "unsplit", "300", null], ["claim1", "split", String(400n - 100n - 51n - 49n), null]]);
    expect(v.totals).deep.include({ claims: 2, notSplit: 1, claimedLamports: "700", toBurnLamports: "100", boughtRaw: null, liquidityLamports: "49", liquidityRaw: "4900", lockedLiquidity: "77" });
    await store.setMeta("walk_coverage:reserve", JSON.stringify({ status: "complete", atMs: 1 }));
    v = (await tailView(store, tails, m.toBase58())).tails[0];
    expect(v.claims[1].burn).deep.eq({ spentLamports: "60", waitingLamports: "40", boughtRaw: "600", buybacks: ["buy"] });
    expect(v.totals.boughtRaw).eq("600");
    expect(v.coverage.reserveVerified).eq(true);
    // an unclear claim: its legs are unknown, so no total of legs (re-review 1)
    const amb = parseCreatorTx(view([claimLeg(400n), burnLeg(50n), burnLeg(50n)]), T).claims[0];
    expect(amb.status).eq("ambiguous");
    await store.insertTailEvents([{ signature: "claim3", idx: 0, slot: 30, blockTime: 3, name: `tailClaim:${m.toBase58()}`, data: amb }], "walk:z", "{}");
    v = (await tailView(store, tails, m.toBase58())).tails[0];
    expect(v.totals).deep.include({ claims: 3, notSplit: 2, ambiguous: 1, claimedLamports: "1100", toBurnLamports: null, boughtRaw: null, liquidityLamports: null, liquidityRaw: null, lockedLiquidity: null });
    expect(v.claims[0].keptLamports).eq(null);
  });

  it("two tails claimed in one transaction: both claims stored and listed under their own tail (re-review 2)", async () => {
    const store = await freshStore();
    const curve2 = k();
    const [m1, m2, cfg] = [k(), k(), k()];
    const tails = parseTails(`${m1.toBase58()}:${cfg.toBase58()}:${target.toBase58()},${m2.toBase58()}:${cfg.toBase58()}:${target.toBase58()}`);
    // curves derived from the mints; one transaction claims both, by the same creator
    const both = view([claimLeg(400n, tails[0].curve), claimLeg(300n, tails[1].curve)], { signature: "both", slot: 5 });
    const sigs = [{ signature: "both", slot: 5, err: null, blockTime: 1 }];
    const deps: WalkDeps = { getSignatures: async (_a, o) => (o.before ? [] : sigs), readView: async () => both };
    // what refreshSources would have saved for each tail
    const sources = async (t: any) => { const src = { v: 2, origin: { creator: creator.toBase58(), signature: "first" }, creators: [creator.toBase58()], graduated: false, pool: null, migration: null }; await store.setMeta(`tail_sources:${t.mint.toBase58()}`, JSON.stringify(src)); return src; };
    for (let i = 0; i < 2; i++) await tailIndexPass(deps, store, tails, reserve, sources);
    for (const [t, amount] of [[m1, "400"], [m2, "300"]] as const) {
      const v: any = (await tailView(store, tails, t.toBase58())).tails[0];
      expect(v.claims.map((c: any) => [c.signature, c.claimedLamports, c.status])).deep.eq([["both", amount, "unsplit"]]);
      expect(v.totals.claims).eq(1);
    }
    void curve2;
  });

  it("sources: the origin from the curve's first transaction, every handover from followed creators, the migration's positions (re-review 3)", async () => {
    const store = await freshStore();
    const [m, cfg] = [k(), k()];
    const [t] = parseTails(`${m.toBase58()}:${cfg.toBase58()}:${target.toBase58()}`);
    const [A, B, C] = [k(), k(), k()];
    const initIx = ixOf(DBC, [140, 85, 215, 176, 102, 54, 104, 79], [cfg, k(), A, m, NATIVE_MINT, t.curve]);
    expect(originOf(view([[initIx, []]]), t.curve.toBase58())).eq(A.toBase58());
    // the curve's history: many trades, the creation first (oldest)
    const curveSigs = Array.from({ length: 2500 }, (_, i) => ({ signature: `c${2500 - i}`, slot: 2500 - i, err: null, blockTime: 1 }));
    const updates = [{ signature: "handover", idx: 0, slot: 50, blockTime: 1, name: `tailCreatorUpdate:${m.toBase58()}`, data: { creator: A.toBase58(), newCreator: B.toBase58() } }];
    let pool: any = { creator: C, migrationProgress: 0 };
    const chain: any = { dbcPool: async () => pool, dbc: { account: { poolConfig: { fetch: async () => ({ migrationFeeOption: 6 }) } } } };
    const nft1 = k(), pos1 = k(), nft2 = k(), pos2 = k(), partner = k();
    const migrateIx = ixOf(DBC, [156, 169, 230, 103, 53, 228, 80, 64], [t.curve, k(), cfg, k(), k(), k(), nft1, pos1, k(), nft2, pos2]);
    const deps: WalkDeps = {
      getSignatures: async (addr, o) => {
        if (addr.equals(t.curve)) { const start = o.before ? curveSigs.findIndex((x) => x.signature === o.before) + 1 : 0; return curveSigs.slice(start, start + o.limit); }
        return o.before ? [] : [{ signature: "migration", slot: 900, err: null, blockTime: 1 }];
      },
      readView: async (sig) => (sig === "c1" ? view([[initIx, []]]) : sig === "migration" ? view([[migrateIx, []]], { owners: new Map([[nft1.toBase58(), partner.toBase58()], [nft2.toBase58(), B.toBase58()]]) }) : null),
    };
    let s = await refreshSources(chain, deps, store, t);
    expect(s.origin).deep.eq({ creator: A.toBase58(), signature: "c1" });
    expect(s.creators).deep.eq([A.toBase58(), C.toBase58()]);
    // a handover found in A's history adds B, even though B is no longer the creator
    await store.insertTailEvents(updates, "walk:u", "{}");
    s = await refreshSources(chain, deps, store, t);
    expect(s.creators).deep.eq([A.toBase58(), C.toBase58(), B.toBase58()]);
    // coverage: complete only once every creator's walk is
    for (const c of [A, C]) await store.setMeta(`walk_coverage:tail:${m.toBase58()}:creator:${c.toBase58()}`, JSON.stringify({ status: "complete", atMs: 1 }));
    expect(((await tailView(store, [t], null)).tails[0] as any).coverage.claims.status).eq("unavailable");
    await store.setMeta(`walk_coverage:tail:${m.toBase58()}:creator:${B.toBase58()}`, JSON.stringify({ status: "complete", atMs: 1 }));
    expect(((await tailView(store, [t], null)).tails[0] as any).coverage.claims.status).eq("complete");
    // graduated: the migration gave B (a creator then) the second position; its NFT may have moved since, it is followed anyway
    pool = { creator: C, migrationProgress: 3 };
    s = await refreshSources(chain, deps, store, t);
    expect(s.migration).deep.eq({ signature: "migration", positions: [{ position: pos1.toBase58(), owner: partner.toBase58() }, { position: pos2.toBase58(), owner: B.toBase58() }] });
    expect(creatorPositions(s)).deep.eq([pos2.toBase58()]);
    // a migration that does not say who got the NFTs: owners unknown, never "no creator position"
    expect(migrationPositions(view([[migrateIx, []]], { owners: new Map() }), t.curve.toBase58())).deep.eq([{ position: pos1.toBase58(), owner: null }, { position: pos2.toBase58(), owner: null }]);
    expect(((await tailView(store, [t], null)).tails[0] as any).coverage.claims.status).eq("unavailable"); // the position is not walked yet
    // without a readable origin, coverage is never complete
    const fresh = await freshStore();
    const blind: WalkDeps = { ...deps, readView: async () => null };
    await refreshSources({ ...chain, dbcPool: async () => ({ creator: C, migrationProgress: 0 }) }, blind, fresh, t);
    await fresh.setMeta(`walk_coverage:tail:${m.toBase58()}:creator:${C.toBase58()}`, JSON.stringify({ status: "complete", atMs: 1 }));
    expect(((await tailView(fresh, [t], null)).tails[0] as any).coverage.claims.status).eq("unavailable");
  });

  it("re-review 160: A creates, hands to B, B claims 400, the migration gives B the position, B hands to C, B claims 600 from the position; the worker starts afterwards", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "tail-160-"));
    const file = `sqlite:${path.join(dir, "store.sqlite")}`;
    const [m, cfg] = [k(), k()];
    const [t] = parseTails(`${m.toBase58()}:${cfg.toBase58()}:${target.toBase58()}`);
    const curveS = t.curve.toBase58();
    const dammPool = deriveDammV2PoolAddress(DAMM_V2_MIGRATION_CONFIGS[6], m, NATIVE_MINT);
    const [A, B, C, partner] = [k(), k(), k(), k()];
    const nftB = k(), posB = k(), nftX = k(), posX = k();
    const handover = (from: PublicKey, to: PublicKey): [Ix, Ix[]] => [ixOf(DBC, [20, 7, 169, 33, 58, 147, 166, 33], [t.curve, cfg, from, to]), [ev(DBC, [107, 225, 165, 237, 91, 158, 213, 220], key(t.curve), key(from), key(to))]];
    const views: Record<string, TxView> = {
      create: view([[ixOf(DBC, [140, 85, 215, 176, 102, 54, 104, 79], [cfg, k(), A, m, NATIVE_MINT, t.curve]), []]], { signature: "create", slot: 1 }),
      "a-to-b": view([handover(A, B)], { signature: "a-to-b", slot: 2 }),
      "b-claim": view([claimLeg(400n, t.curve)], { signature: "b-claim", slot: 3 }),
      migration: view([[ixOf(DBC, [156, 169, 230, 103, 53, 228, 80, 64], [t.curve, k(), cfg, k(), dammPool, k(), nftX, posX, k(), nftB, posB]), []]], { signature: "migration", slot: 4, owners: new Map([[nftX.toBase58(), partner.toBase58()], [nftB.toBase58(), B.toBase58()]]) }),
      "b-to-c": view([handover(B, C)], { signature: "b-to-c", slot: 5 }),
      "b-pos-claim": view([[ixOf(DAMM, [1, 1, 1, 1, 1, 1, 1, 1], []), [ev(DAMM, D.posFee, key(dammPool), key(posB), key(B), u64(0n), u64(600n))]]], { signature: "b-pos-claim", slot: 6 }),
    };
    const history: Record<string, string[]> = { // newest first, per address
      [curveS]: ["trade3", "b-to-c", "trade2", "b-claim", "a-to-b", "trade1", "create"],
      [A.toBase58()]: ["a-to-b", "create"], [B.toBase58()]: ["b-to-c", "migration", "b-claim", "a-to-b"], [C.toBase58()]: ["b-to-c"],
      [dammPool.toBase58()]: ["trade4", "migration"], [posB.toBase58()]: ["b-pos-claim", "migration"], [posX.toBase58()]: ["migration"],
    };
    const deps: WalkDeps = {
      getSignatures: async (addr, o) => {
        const list = history[addr.toBase58()] ?? [];
        let start = o.before ? list.indexOf(o.before) + 1 : 0;
        const out = [];
        for (let i = start; i < list.length && out.length < o.limit; i++) { if (o.until && list[i] === o.until) break; out.push({ signature: list[i], slot: views[list[i]]?.slot ?? 0, err: null, blockTime: 1 }); }
        return out;
      },
      readView: async (sig) => views[sig] ?? view([], { signature: sig }),
    };
    const chain: any = { dbcPool: async () => ({ creator: C, migrationProgress: 3 }), dbc: { account: { poolConfig: { fetch: async () => ({ migrationFeeOption: 6 }) } } } };
    const pass = async (store: any) => { await tailIndexPass(deps, store, [t], reserve, (tt) => refreshSources(chain, deps, store, tt)); return (await tailView(store, [t], null)).tails[0] as any; };
    const check = (v: any) => {
      // whenever the history says complete, both claims are in it, once each
      if (v.coverage.claims.status === "complete") expect(v.claims.map((c: any) => [c.signature, c.source, c.claimedLamports]).sort()).deep.eq([["b-claim", "curve", "400"], ["b-pos-claim", "pool", "600"]]);
    };
    let store = openStore(file); await store.init();
    for (let i = 0; i < 4; i++) check(await pass(store));
    let v: any = await pass(store);
    expect(v.coverage.claims.status).eq("complete");
    expect(v.creators.sort()).deep.eq([A, B, C].map((x) => x.toBase58()).sort());
    expect(v.graduatedPositions).deep.eq([posB.toBase58()]);
    expect(v.totals).deep.include({ claims: 2, claimedLamports: "1000" });
    // a restart on the same store, and more passes: nothing twice, still complete
    await store.close();
    store = openStore(file); await store.init();
    for (let i = 0; i < 3; i++) { v = await pass(store); check(v); }
    expect(v.totals).deep.include({ claims: 2, claimedLamports: "1000" });
    expect(v.coverage.claims.status).eq("complete");
    // a handover recorded but not yet followed keeps the history incomplete
    await store.insertTailEvents([{ signature: "c-to-d", idx: 0, slot: 7, blockTime: 1, name: `tailCreatorUpdate:${m.toBase58()}`, data: { creator: C.toBase58(), newCreator: k().toBase58() } }], "walk:q", "{}");
    expect(((await tailView(store, [t], null)).tails[0] as any).coverage.claims.status).eq("unavailable");
    await store.close();

    // upgrade (review 162): a record saved by the previous version, with the empty positions list that version
    // cached, and creator walks already complete. It must not read as complete until the migration is read again
    // and the recovered position is walked; its origin, creators and history are kept.
    const old = openStore(`sqlite:${path.join(fs.mkdtempSync(path.join(os.tmpdir(), "tail-162-")), "store.sqlite")}`); await old.init();
    const mm = m.toBase58();
    await old.setMeta(`tail_sources:${mm}`, JSON.stringify({ origin: { creator: A.toBase58(), signature: "create" }, creators: [A.toBase58(), C.toBase58(), B.toBase58()], graduated: true, pool: dammPool.toBase58(), migration: { signature: "migration", positions: [] } }));
    for (const c of [A, B, C]) {
      const head = history[c.toBase58()][0];
      await old.setMeta(`walk:tail:${mm}:creator:${c.toBase58()}`, JSON.stringify({ head, newHead: null, tail: null, target: null }));
      await old.setMeta(`walk_coverage:tail:${mm}:creator:${c.toBase58()}`, JSON.stringify({ status: "complete", atMs: 1 }));
    }
    await old.insertTailEvents([
      { signature: "b-claim", idx: 0, slot: 3, blockTime: 1, name: `tailClaim:${mm}`, data: parseCreatorTx(views["b-claim"], { curve: curveS, targetPool: target.toBase58(), reserve: reserve.toBase58() }).claims[0] },
      { signature: "a-to-b", idx: 0, slot: 2, blockTime: 1, name: `tailCreatorUpdate:${mm}`, data: { creator: A.toBase58(), newCreator: B.toBase58() } },
      { signature: "b-to-c", idx: 0, slot: 5, blockTime: 1, name: `tailCreatorUpdate:${mm}`, data: { creator: B.toBase58(), newCreator: C.toBase58() } },
    ], "walk:seed", "{}");
    let o: any = (await tailView(old, [t], null)).tails[0];
    expect(o.coverage.claims.status).eq("unavailable"); // the old migration facts are not trusted
    o = await pass(old);
    expect(o.coverage.claims.status).eq("complete");
    expect(o.graduatedPositions).deep.eq([posB.toBase58()]);
    expect(o.origin).deep.eq({ creator: A.toBase58(), signature: "create" });
    expect(o.claims.map((c: any) => [c.signature, c.claimedLamports]).sort()).deep.eq([["b-claim", "400"], ["b-pos-claim", "600"]]);
    for (let i = 0; i < 2; i++) o = await pass(old);
    expect(o.totals).deep.include({ claims: 2, claimedLamports: "1000" });
    expect(JSON.parse((await old.getMeta(`tail_sources:${mm}`))!).v).eq(2);
    await old.close();
  });
});
