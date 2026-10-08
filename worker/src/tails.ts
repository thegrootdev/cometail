// Tails: coins launched by the owner's wallet on a fee-sale config and pointed at an existing coin. No program
// of ours is involved; the owner claims a tail's creator curve fees from /admin and splits them in the same
// transaction (half kept, a quarter to the burn reserve, a quarter locked as liquidity in the target's pool).
// This module records what those transactions did, from the events Meteora emitted and the reserve's balance,
// and traces the SOL each claim sent to the reserve to the buybacks that spent it, first in, first out.
//
// Two walks, each with its own cursor (same scheme as the burn index: a cycle walks newest -> previous head
// in pages and only completes when it reaches it; an unreadable transaction stops the pass, never skipped):
//   - per tail, the signatures of its locked position (every claim adds to and locks it): "tailClaim" rows;
//   - the burn reserve's signatures (every split, transfer and buyback touches it): "reserveFlow" rows.
import { utils } from "@coral-xyz/anchor";
import { PublicKey } from "@solana/web3.js";
import { NATIVE_MINT } from "@solana/spl-token";
import { BurnClient } from "@cometail/client";
import { deriveDbcPoolAddress } from "@meteora-ag/dynamic-bonding-curve-sdk";
import { burnParser } from "./burn";
import { DAMM_V2_PROGRAM_ID, DBC_PROGRAM_ID } from "./chain";
import { readTx } from "./indexer";
import type { Store, TailEventRow } from "./store";
import { log } from "./tx";

/** A configured tail: `COMETAIL_TAILS=<tail mint>:<its DBC config>:<target's DAMM v2 pool>[:<locked position>]`, comma separated. */
export type TailSpec = { mint: PublicKey; config: PublicKey; curve: PublicKey; targetPool: PublicKey; position: PublicKey | null };
export function parseTails(v: string): TailSpec[] {
  return v.split(",").map((s) => s.trim()).filter(Boolean).map((s) => {
    const [mint, config, targetPool, position] = s.split(":").map((x) => x.trim());
    if (!mint || !config || !targetPool) throw new Error(`COMETAIL_TAILS entry needs mint:config:targetPool[:position] (got ${s})`);
    const m = new PublicKey(mint), c = new PublicKey(config);
    return { mint: m, config: c, curve: deriveDbcPoolAddress(NATIVE_MINT, m, c), targetPool: new PublicKey(targetPool), position: position ? new PublicKey(position) : null };
  });
}

// ---------------------------------------------------------------------------------------------------------------
// Event decoding. Anchor's emit_cpi events are inner instructions of the emitting program to itself: 8 bytes of
// tag, 8 of the event discriminator, then the borsh fields. Layouts from idls/dynamic_bonding_curve.json and
// idls/cp_amm.json (the pinned versions the mainnet programs run).
const EVENT_TAG = Buffer.from([0xe4, 0x45, 0xa5, 0x2e, 0x51, 0xcb, 0x9a, 0x1d]);
const EVT = {
  claimCreatorTradingFee: Buffer.from([154, 228, 215, 202, 133, 155, 214, 138]),
  swap2: Buffer.from([189, 66, 51, 168, 38, 80, 117, 153]),
  liquidityChange: Buffer.from([197, 171, 78, 127, 224, 211, 87, 13]),
  permanentLock: Buffer.from([145, 143, 162, 218, 218, 80, 67, 11]),
};
const pk = (b: Buffer, o: number) => new PublicKey(b.subarray(o, o + 32)).toBase58();
const u64 = (b: Buffer, o: number) => b.readBigUInt64LE(o);
const u128 = (b: Buffer, o: number) => b.readBigUInt64LE(o) + (b.readBigUInt64LE(o + 8) << 64n);

export type TailEvents = {
  claims: { pool: string; base: bigint; quote: bigint }[];
  swaps: { pool: string; direction: number; amountIn: bigint; out: bigint }[];
  liquidity: { pool: string; position: string; owner: string; a: bigint; b: bigint; delta: bigint; changeType: number }[];
  /** `total` is the pool's permanently locked liquidity across every position, not this position's. */
  locks: { pool: string; position: string; amount: bigint; total: bigint }[];
};
export function decodeEvents(inner: { programId: PublicKey; data: Buffer }[]): TailEvents {
  const out: TailEvents = { claims: [], swaps: [], liquidity: [], locks: [] };
  for (const ix of inner) {
    const d = ix.data;
    if (d.length < 16 || !d.subarray(0, 8).equals(EVENT_TAG)) continue;
    const disc = d.subarray(8, 16), b = d.subarray(16);
    if (ix.programId.equals(DBC_PROGRAM_ID) && disc.equals(EVT.claimCreatorTradingFee)) out.claims.push({ pool: pk(b, 0), base: u64(b, 32), quote: u64(b, 40) });
    if (!ix.programId.equals(DAMM_V2_PROGRAM_ID)) continue;
    if (disc.equals(EVT.swap2)) {
      // pool, trade_direction u8, collect_fee_mode u8, has_referral bool, params {amount_0, amount_1, swap_mode u8},
      // swap_result {included_fee_input_amount, excluded_fee_input_amount, amount_left, output_amount, ...}
      const r = 32 + 3 + 17;
      out.swaps.push({ pool: pk(b, 0), direction: b[32], amountIn: u64(b, r), out: u64(b, r + 24) });
    } else if (disc.equals(EVT.liquidityChange)) {
      // pool, position, owner, token_a_amount, token_b_amount, 2 transfer-fee amounts, 2 reserves, liquidity_delta u128, 2 thresholds, change_type u8
      out.liquidity.push({ pool: pk(b, 0), position: pk(b, 32), owner: pk(b, 64), a: u64(b, 96), b: u64(b, 104), delta: u128(b, 144), changeType: b[176] });
    } else if (disc.equals(EVT.permanentLock)) {
      out.locks.push({ pool: pk(b, 0), position: pk(b, 32), amount: u128(b, 64), total: u128(b, 80) });
    }
  }
  return out;
}

/** What a transaction looked like, reduced to what the tail index reads. */
export type TxView = { signature: string; slot: number; blockTime: number | null; err: boolean; signer: string; inner: { programId: PublicKey; data: Buffer }[]; logs: string[]; tokenDelta: (account: PublicKey) => bigint | null };

export function txView(signature: string, tx: any): TxView | null {
  if (!tx?.meta || !Array.isArray(tx.meta.logMessages) || tx.meta.logMessages.some((l: string) => /Log truncated/i.test(l))) return null;
  const keys = tx.transaction.message.getAccountKeys({ accountKeysFromLookups: tx.meta.loadedAddresses ?? undefined });
  const inner = (tx.meta.innerInstructions ?? []).flatMap((g: any) => g.instructions.map((ix: any) => ({ programId: keys.get(ix.programIdIndex)!, data: Buffer.from(utils.bytes.bs58.decode(ix.data)) })));
  const balance = (list: any[] | undefined, i: number) => { const e = (list ?? []).find((x: any) => x.accountIndex === i); return e ? BigInt(e.uiTokenAmount.amount) : 0n; };
  return {
    signature, slot: tx.slot, blockTime: tx.blockTime ?? null, err: !!tx.meta.err, signer: keys.get(0)!.toBase58(), inner, logs: tx.meta.logMessages,
    tokenDelta: (account) => {
      for (let i = 0; i < keys.length; i++) if (keys.get(i)!.equals(account)) return balance(tx.meta.postTokenBalances, i) - balance(tx.meta.preTokenBalances, i);
      return null;
    },
  };
}

/** A tail claim: the creator claim of this tail's curve, the transfer to the reserve, the swap into the target
 *  and the liquidity added to and locked in the configured position, all in one transaction. Anything else
 *  touching the position (its creation, a lock without a claim) is not a claim and returns null. */
export function parseTailClaim(v: TxView, tail: { mint: string; curve: string; targetPool: string; position: string }, reserve: PublicKey) {
  if (v.err) return null;
  const e = decodeEvents(v.inner);
  const claim = e.claims.find((c) => c.pool === tail.curve);
  const add = e.liquidity.find((l) => l.position === tail.position && l.pool === tail.targetPool && l.changeType === 0);
  const lock = e.locks.find((l) => l.position === tail.position);
  if (!claim || !add || !lock) return null;
  const swap = e.swaps.find((s) => s.pool === tail.targetPool);
  const toBurn = v.tokenDelta(reserve) ?? 0n;
  return {
    tail: tail.mint, creator: v.signer, claimedLamports: claim.quote.toString(), toBurnLamports: (toBurn > 0n ? toBurn : 0n).toString(),
    swapInLamports: swap ? swap.amountIn.toString() : "0", swapOutRaw: swap ? swap.out.toString() : "0",
    addedRaw: add.a.toString(), addedLamports: add.b.toString(), liquidity: add.delta.toString(), lockedLiquidity: lock.amount.toString(),
  };
}

/** The reserve's net change in a transaction, and what a buyback in it burned. */
export function parseReserveFlow(v: TxView, reserve: PublicKey) {
  if (v.err) return null;
  const delta = v.tokenDelta(reserve);
  if (delta === null || delta === 0n) return null;
  let burned: string | null = null, spent: string | null = null;
  for (const ev of burnParser.parseLogs(v.logs)) if (ev.name === "BuybackBurned") { burned = String((ev.data as any).burned); spent = String((ev.data as any).spent); }
  return { delta: delta.toString(), burnedRaw: burned, spentLamports: spent };
}

// ---------------------------------------------------------------------------------------------------------------
// The walk. Same cursor scheme as burnindex.ts, keyed per address.
type Sig = { signature: string; slot: number; err: unknown; blockTime?: number | null };
export type WalkDeps = { getSignatures: (address: PublicKey, o: { before?: string; until?: string; limit: number }) => Promise<Sig[]>; readView: (signature: string) => Promise<TxView | null> };
export type WalkCursor = { head: string | null; newHead: string | null; tail: string | null; target: string | null };
export const TAIL_INDEX_PER_PASS = 200;

export function chainWalkDeps(connection: any): WalkDeps {
  return {
    getSignatures: (address, o) => connection.getSignaturesForAddress(address, { limit: o.limit, before: o.before, until: o.until }, "confirmed"),
    readView: async (sig) => txView(sig, await readTx(connection, sig)),
  };
}

async function readWalkCursor(store: Store, key: string): Promise<WalkCursor> {
  const v = await store.getMeta(key);
  try { const j = v ? JSON.parse(v) : null; if (j && typeof j === "object" && "head" in j) return j; } catch { /* fresh */ }
  return { head: null, newHead: null, tail: null, target: null };
}

/** One pass over `address`'s signatures; `rowsOf` turns a readable transaction into rows. Returns rows stored
 *  and whether the walk is complete (no open cycle and nothing newer than the head). */
export async function walkPass(deps: WalkDeps, store: Store, address: PublicKey, key: string, rowsOf: (v: TxView) => TailEventRow[], perPass = TAIL_INDEX_PER_PASS) {
  const cursorKey = `walk:${key}`, coverageKey = `walk_coverage:${key}`;
  const c = await readWalkCursor(store, cursorKey);
  if (!c.newHead) {
    const top = await deps.getSignatures(address, { limit: 1 });
    if (!top.length || top[0].signature === c.head) { await store.setMeta(coverageKey, JSON.stringify({ status: "complete", atMs: Date.now() })); return { stored: 0, complete: true }; }
    c.newHead = top[0].signature; c.target = c.head; c.tail = null;
  }
  const rows: TailEventRow[] = [];
  let processed = 0, stopped = false, reachedTarget = false;
  let before: string | undefined = c.tail ?? undefined, skipToTop = !c.tail;
  outer: while (processed < perPass) {
    const page = await deps.getSignatures(address, { before, until: c.target ?? undefined, limit: 100 });
    let list = page;
    if (skipToTop) {
      const at = list.findIndex((s) => s.signature === c.newHead);
      if (at < 0) { if (page.length < 100) { c.newHead = null; c.tail = null; c.target = null; stopped = true; break; } before = page[page.length - 1].signature; continue; }
      list = list.slice(at); skipToTop = false;
    }
    for (const s of list) {
      if (processed >= perPass) break outer;
      if (!s.err) {
        const v = await deps.readView(s.signature);
        if (!v) { stopped = true; break outer; }
        rows.push(...rowsOf(v));
      }
      c.tail = s.signature; processed++;
    }
    if (page.length < 100) { reachedTarget = !stopped; break; }
    before = page[page.length - 1].signature;
  }
  if (reachedTarget && !stopped) { c.head = c.newHead; c.newHead = null; c.tail = null; c.target = null; }
  await store.insertTailEvents(rows, cursorKey, JSON.stringify(c));
  let complete = c.newHead === null && !stopped;
  if (complete) { const top = await deps.getSignatures(address, { limit: 1 }); complete = !top.length || top[0].signature === c.head; }
  await store.setMeta(coverageKey, JSON.stringify({ status: complete ? "complete" : "partial", atMs: Date.now() }));
  if (rows.length || !complete) log("tail index", { key, rows: rows.length, processed, complete });
  return { stored: rows.length, complete };
}

/** The indexer's tail pass: the reserve ledger, then each tail's claims. */
export async function tailIndexPass(deps: WalkDeps, store: Store, tails: TailSpec[], reserve: PublicKey) {
  const row = (v: TxView, name: string, data: any): TailEventRow => ({ signature: v.signature, idx: 0, slot: v.slot, blockTime: v.blockTime, name, data });
  await walkPass(deps, store, reserve, "reserve", (v) => { const f = parseReserveFlow(v, reserve); return f ? [row(v, "reserveFlow", f)] : []; });
  for (const t of tails) {
    if (!t.position) continue;
    const spec = { mint: t.mint.toBase58(), curve: t.curve.toBase58(), targetPool: t.targetPool.toBase58(), position: t.position.toBase58() };
    await walkPass(deps, store, t.position, `tail:${spec.mint}`, (v) => { const c = parseTailClaim(v, spec, reserve); return c ? [row(v, "tailClaim", c)] : []; });
  }
}

// ---------------------------------------------------------------------------------------------------------------
// The view.

/** First in, first out: each buyback spends the oldest SOL still in the reserve. Returns, per inflow signature,
 *  how much of it buybacks have spent, the $COMETAIL those buybacks burned in proportion, and which buybacks. */
export function traceReserve(flows: { signature: string; slot: number; delta: bigint; burned: bigint | null; spent: bigint | null }[]) {
  const queue: { signature: string; left: bigint }[] = [];
  const out = new Map<string, { spentLamports: bigint; burnedRaw: bigint; buybacks: string[]; exact: boolean }>();
  for (const f of flows) {
    if (f.delta > 0n) { queue.push({ signature: f.signature, left: f.delta }); out.set(f.signature, { spentLamports: 0n, burnedRaw: 0n, buybacks: [], exact: true }); continue; }
    let need = -f.delta;
    const total = need;
    while (need > 0n && queue.length) {
      const head = queue[0];
      const take = head.left < need ? head.left : need;
      const o = out.get(head.signature)!;
      o.spentLamports += take;
      if (f.burned !== null) o.burnedRaw += (f.burned * take) / total; else o.exact = false;
      if (!o.buybacks.includes(f.signature)) o.buybacks.push(f.signature);
      head.left -= take; need -= take;
      if (head.left === 0n) queue.shift();
    }
  }
  return out;
}

export async function tailView(store: Store, tails: TailSpec[], mint: string | null) {
  const flows = (await store.listTailEvents("reserveFlow")).map((r) => ({ signature: r.signature, slot: r.slot, delta: BigInt(r.data.delta), burned: r.data.burnedRaw === null ? null : BigInt(r.data.burnedRaw), spent: r.data.spentLamports === null ? null : BigInt(r.data.spentLamports) }));
  const reserveCoverage = await coverage(store, "reserve");
  const traced = traceReserve(flows);
  const claims = await store.listTailEvents("tailClaim");
  const out = [];
  for (const t of tails) {
    const m = t.mint.toBase58();
    if (mint && m !== mint) continue;
    const rows = claims.filter((r) => r.data.tail === m).map((r) => {
      const tr = traced.get(r.signature);
      const toBurn = BigInt(r.data.toBurnLamports);
      return {
        signature: r.signature, slot: r.slot, blockTime: r.blockTime,
        claimedLamports: r.data.claimedLamports, keptLamports: (BigInt(r.data.claimedLamports) - toBurn - BigInt(r.data.swapInLamports) - BigInt(r.data.addedLamports)).toString(),
        toBurnLamports: r.data.toBurnLamports,
        burn: reserveCoverage.status === "complete" && tr ? { spentLamports: tr.spentLamports.toString(), waitingLamports: (toBurn - tr.spentLamports).toString(), burnedRaw: tr.exact ? tr.burnedRaw.toString() : null, buybacks: tr.buybacks } : null,
        liquidity: { swapInLamports: r.data.swapInLamports, addedLamports: r.data.addedLamports, addedRaw: r.data.addedRaw, liquidity: r.data.lockedLiquidity },
      };
    }).sort((a, b) => b.slot - a.slot);
    const sum = (f: (r: any) => string | null | undefined) => rows.reduce((s, r) => s + BigInt(f(r) ?? "0"), 0n).toString();
    const burnKnown = rows.every((r) => r.burn && r.burn.burnedRaw !== null);
    out.push({
      mint: m, config: t.config.toBase58(), curve: t.curve.toBase58(), targetPool: t.targetPool.toBase58(), position: t.position?.toBase58() ?? null,
      totals: {
        claims: rows.length, claimedLamports: sum((r) => r.claimedLamports), keptLamports: sum((r) => r.keptLamports), toBurnLamports: sum((r) => r.toBurnLamports),
        burnedRaw: burnKnown ? sum((r) => r.burn?.burnedRaw) : null, liquidityLamports: sum((r) => r.liquidity.addedLamports), liquidityRaw: sum((r) => r.liquidity.addedRaw),
        lockedLiquidity: sum((r) => r.liquidity.liquidity),
      },
      claims: rows,
      coverage: { claims: t.position ? await coverage(store, `tail:${m}`) : { status: "unavailable", atMs: null }, reserve: reserveCoverage },
    });
  }
  return { tails: out };
}

async function coverage(store: Store, key: string): Promise<{ status: "complete" | "partial" | "unavailable"; atMs: number | null }> {
  const v = await store.getMeta(`walk_coverage:${key}`);
  try { const j = v ? JSON.parse(v) : null; return j ? { status: j.status, atMs: j.atMs } : { status: "unavailable", atMs: null }; } catch { return { status: "unavailable", atMs: null }; }
}

export function reserveAddress(): PublicKey { return new BurnClient().a.reserve; }
