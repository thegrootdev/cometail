// Tails: coins launched by the owner's wallet on a fee-sale config and pointed at an existing coin. No program of
// ours is involved; the owner claims a tail's creator fees from /admin/tails and splits them in the same
// transaction (half kept, a quarter to the burn reserve, a quarter locked as liquidity in the target's pool). The
// split is voluntary, so this module records every claim, split or not, and what each transaction actually did:
//
//   - Claims are found through the transactions of the curve's creator (DBC requires the creator's signature for
//     every creator claim and every graduation withdrawal) and, after graduation, of the creator's positions in
//     the tail's own pool (every fee claim of a position touches it). A claim is recorded whether or not it was
//     split; each split leg is bound to its own top-level instruction after the claim and to the claim's accounts
//     (the transfer from the claim's destination to the reserve; the SOL -> target buy from that account; the add
//     to a position of the creator in the target pool; the lock of exactly what was added). Missing legs make a
//     claim "unsplit" or "incomplete", and repeated legs "ambiguous": nothing is guessed.
//   - The burn reserve gets a gross ledger: every token transfer into or out of it, in execution order within each
//     transaction, each buyback's outflow tied to its BuybackBurned event. Transactions are ordered by slot and,
//     within a slot, by linking each one's starting balance to the previous one's ending balance. SOL that entered
//     the reserve is traced first in, first out to the buybacks that spent it, and is credited with the $COMETAIL
//     those buybacks *bought* (tokens otherwise present in the bought account and burned with them are not
//     credited). Anything the ledger cannot prove (a broken balance chain, an unexplained movement, more than one
//     consistent order inside a slot) leaves the affected attribution unknown, never approximate.
//
// Each address is walked with the burn index's cursor scheme (a cycle walks newest -> previous head in pages and
// completes only when it reaches it; an unreadable transaction stops the pass and is retried, never skipped).
import { utils } from "@coral-xyz/anchor";
import { PublicKey } from "@solana/web3.js";
import { NATIVE_MINT, TOKEN_PROGRAM_ID } from "@solana/spl-token";
import { BurnClient } from "@cometail/client";
import { deriveDammV2PoolAddress, deriveDbcPoolAddress } from "@meteora-ag/dynamic-bonding-curve-sdk";
import { burnParser } from "./burn";
import { Chain, DAMM_V2_MIGRATION_CONFIGS, DAMM_V2_PROGRAM_ID, DBC_PROGRAM_ID, DBC_PROGRESS } from "./chain";
import { readTx } from "./indexer";
import type { Store, TailEventRow } from "./store";
import { log } from "./tx";

/** A configured tail: `COMETAIL_TAILS=<tail mint>:<its DBC config>:<target's DAMM v2 pool>`, comma separated. */
export type TailSpec = { mint: PublicKey; config: PublicKey; curve: PublicKey; targetPool: PublicKey };
export function parseTails(v: string): TailSpec[] {
  return v.split(",").map((s) => s.trim()).filter(Boolean).map((s) => {
    const parts = s.split(":").map((x) => x.trim());
    if (parts.length !== 3 || parts.some((p) => !p)) throw new Error(`COMETAIL_TAILS entry needs mint:config:targetPool (got ${s})`);
    const m = new PublicKey(parts[0]), c = new PublicKey(parts[1]);
    return { mint: m, config: c, curve: deriveDbcPoolAddress(NATIVE_MINT, m, c), targetPool: new PublicKey(parts[2]) };
  });
}

// ---------------------------------------------------------------------------------------------------------------
// Transactions, reduced to what the tail index reads.
export type Ix = { programId: PublicKey; accounts: PublicKey[]; data: Buffer };
export type TxView = {
  signature: string; slot: number; blockTime: number | null; err: boolean;
  top: Ix[]; inner: Map<number, Ix[]>; logs: string[];
  /** The account's token amount before and after, when the account is in the transaction (absent before = 0). */
  balance: (account: PublicKey) => { pre: bigint; post: bigint } | null;
  /** The owner of a token account after the transaction, when it holds a balance then. */
  ownerAfter: (account: PublicKey) => string | null;
};

export function txView(signature: string, tx: any): TxView | null {
  if (!tx?.meta || !Array.isArray(tx.meta.logMessages) || tx.meta.logMessages.some((l: string) => /Log truncated/i.test(l))) return null;
  const keys = tx.transaction.message.getAccountKeys({ accountKeysFromLookups: tx.meta.loadedAddresses ?? undefined });
  const key = (i: number) => keys.get(i)!;
  const top: Ix[] = tx.transaction.message.compiledInstructions.map((ix: any) => ({ programId: key(ix.programIdIndex), accounts: ix.accountKeyIndexes.map(key), data: Buffer.from(ix.data) }));
  const inner = new Map<number, Ix[]>();
  for (const g of tx.meta.innerInstructions ?? []) inner.set(g.index, g.instructions.map((ix: any) => ({ programId: key(ix.programIdIndex), accounts: (ix.accounts ?? []).map(key), data: Buffer.from(utils.bytes.bs58.decode(ix.data)) })));
  const amount = (list: any[] | undefined, i: number) => { const e = (list ?? []).find((x: any) => x.accountIndex === i); return e ? BigInt(e.uiTokenAmount.amount) : 0n; };
  return {
    signature, slot: tx.slot, blockTime: tx.blockTime ?? null, err: !!tx.meta.err, top, inner, logs: tx.meta.logMessages,
    balance: (account) => {
      for (let i = 0; i < keys.length; i++) if (key(i).equals(account)) return { pre: amount(tx.meta.preTokenBalances, i), post: amount(tx.meta.postTokenBalances, i) };
      return null;
    },
    ownerAfter: (account) => {
      for (let i = 0; i < keys.length; i++) if (key(i).equals(account)) { const e = (tx.meta.postTokenBalances ?? []).find((x: any) => x.accountIndex === i); return e?.owner ?? null; }
      return null;
    },
  };
}

// ---------------------------------------------------------------------------------------------------------------
// Events. Anchor's emit_cpi events are inner instructions of the emitting program to itself: 8 bytes of tag, 8 of
// the event discriminator, then the borsh fields (layouts from the pinned idls/).
const EVENT_TAG = Buffer.from([0xe4, 0x45, 0xa5, 0x2e, 0x51, 0xcb, 0x9a, 0x1d]);
const EVT = {
  claimCreatorTradingFee: Buffer.from([154, 228, 215, 202, 133, 155, 214, 138]),
  withdrawMigrationFee: Buffer.from([26, 203, 84, 85, 161, 23, 100, 214]),
  creatorWithdrawSurplus: Buffer.from([152, 73, 21, 15, 66, 87, 53, 157]),
  swap2: Buffer.from([189, 66, 51, 168, 38, 80, 117, 153]),
  liquidityChange: Buffer.from([197, 171, 78, 127, 224, 211, 87, 13]),
  permanentLock: Buffer.from([145, 143, 162, 218, 218, 80, 67, 11]),
  claimPositionFee: Buffer.from([198, 182, 183, 52, 97, 12, 49, 56]),
  updatePoolCreator: Buffer.from([107, 225, 165, 237, 91, 158, 213, 220]),
};
/** Instruction discriminators of the top-level legs (cp-amm swap / swap2, add_liquidity, permanent_lock_position; DBC claim). */
const IX = {
  dbcClaimCreator: Buffer.from([82, 220, 250, 189, 3, 85, 107, 45]),
  swap: Buffer.from([248, 198, 158, 145, 225, 117, 135, 200]), swap2: Buffer.from([65, 75, 63, 76, 235, 91, 91, 136]),
  addLiquidity: Buffer.from([181, 157, 89, 67, 143, 182, 52, 72]), permanentLock: Buffer.from([165, 176, 125, 6, 231, 171, 186, 213]),
  dbcInitSpl: Buffer.from([140, 85, 215, 176, 102, 54, 104, 79]), dbcInit2022: Buffer.from([169, 118, 51, 78, 145, 110, 220, 155]),
  dbcMigrateDammV2: Buffer.from([156, 169, 230, 103, 53, 228, 80, 64]),
};
const pk = (b: Buffer, o: number) => new PublicKey(b.subarray(o, o + 32)).toBase58();
const u64 = (b: Buffer, o: number) => b.readBigUInt64LE(o);
const u128 = (b: Buffer, o: number) => b.readBigUInt64LE(o) + (b.readBigUInt64LE(o + 8) << 64n);
const isDisc = (d: Buffer, disc: Buffer) => d.length >= 8 && d.subarray(0, 8).equals(disc);

export type Event =
  | { kind: "creatorClaim"; pool: string; base: bigint; quote: bigint }
  | { kind: "migrationFee"; pool: string; fee: bigint; flag: number }
  | { kind: "creatorSurplus"; pool: string; amount: bigint }
  | { kind: "creatorUpdate"; pool: string; creator: string; newCreator: string }
  | { kind: "swap"; pool: string; direction: number; amountIn: bigint; out: bigint }
  | { kind: "liquidity"; pool: string; position: string; owner: string; a: bigint; b: bigint; delta: bigint; changeType: number }
  | { kind: "lock"; pool: string; position: string; amount: bigint; total: bigint }
  | { kind: "positionFee"; pool: string; position: string; owner: string; feeA: bigint; feeB: bigint };

export function decodeEvents(ixs: Ix[]): Event[] {
  const out: Event[] = [];
  for (const ix of ixs) {
    const d = ix.data;
    if (d.length < 16 || !d.subarray(0, 8).equals(EVENT_TAG)) continue;
    const disc = d.subarray(8, 16), b = d.subarray(16);
    if (ix.programId.equals(DBC_PROGRAM_ID)) {
      if (disc.equals(EVT.claimCreatorTradingFee)) out.push({ kind: "creatorClaim", pool: pk(b, 0), base: u64(b, 32), quote: u64(b, 40) });
      else if (disc.equals(EVT.withdrawMigrationFee)) out.push({ kind: "migrationFee", pool: pk(b, 0), fee: u64(b, 32), flag: b[40] });
      else if (disc.equals(EVT.creatorWithdrawSurplus)) out.push({ kind: "creatorSurplus", pool: pk(b, 0), amount: u64(b, 32) });
      else if (disc.equals(EVT.updatePoolCreator)) out.push({ kind: "creatorUpdate", pool: pk(b, 0), creator: pk(b, 32), newCreator: pk(b, 64) });
    } else if (ix.programId.equals(DAMM_V2_PROGRAM_ID)) {
      // EvtSwap2: pool, trade_direction u8 (1 = B -> A, a buy of token A), collect_fee_mode u8, has_referral bool,
      // params {amount_0, amount_1, swap_mode u8}, swap_result {included_fee_input_amount, excluded_fee_input_amount, amount_left, output_amount, ...}
      if (disc.equals(EVT.swap2)) out.push({ kind: "swap", pool: pk(b, 0), direction: b[32], amountIn: u64(b, 52), out: u64(b, 76) });
      // EvtLiquidityChange: pool, position, owner, token_a_amount, token_b_amount, 2 transfer-fee amounts, 2 reserves, liquidity_delta u128, 2 thresholds, change_type u8 (0 = add)
      else if (disc.equals(EVT.liquidityChange)) out.push({ kind: "liquidity", pool: pk(b, 0), position: pk(b, 32), owner: pk(b, 64), a: u64(b, 96), b: u64(b, 104), delta: u128(b, 144), changeType: b[176] });
      // EvtPermanentLockPosition: pool, position, lock_liquidity_amount u128, total_permanent_locked_liquidity u128 (the pool's, not the position's)
      else if (disc.equals(EVT.permanentLock)) out.push({ kind: "lock", pool: pk(b, 0), position: pk(b, 32), amount: u128(b, 64), total: u128(b, 80) });
      // EvtClaimPositionFee: pool, position, owner, fee_a_claimed, fee_b_claimed
      else if (disc.equals(EVT.claimPositionFee)) out.push({ kind: "positionFee", pool: pk(b, 0), position: pk(b, 32), owner: pk(b, 64), feeA: u64(b, 96), feeB: u64(b, 104) });
    }
  }
  return out;
}
const eventsOf = (v: TxView, i: number) => decodeEvents(v.inner.get(i) ?? []);

/** SPL Token Transfer (3) and TransferChecked (12): source, destination, authority, amount. */
function transferOf(ix: Ix): { source: string; dest: string; authority: string; amount: bigint } | null {
  if (!ix.programId.equals(TOKEN_PROGRAM_ID) || ix.data.length < 9) return null;
  if (ix.data[0] === 3 && ix.accounts.length >= 3) return { source: ix.accounts[0].toBase58(), dest: ix.accounts[1].toBase58(), authority: ix.accounts[2].toBase58(), amount: u64(ix.data, 1) };
  if (ix.data[0] === 12 && ix.accounts.length >= 4) return { source: ix.accounts[0].toBase58(), dest: ix.accounts[2].toBase58(), authority: ix.accounts[3].toBase58(), amount: u64(ix.data, 1) };
  return null;
}

// ---------------------------------------------------------------------------------------------------------------
// Claims of a tail's curve, from the creator's transactions.
export type CurveTarget = { curve: string; targetPool: string; reserve: string };
export type SplitStatus = "split" | "unsplit" | "incomplete" | "ambiguous";
export type CurveClaim = {
  kind: "curve"; claimedLamports: string; creator: string; status: SplitStatus;
  toBurn: { lamports: string; source: string } | null;
  buy: { inLamports: string; outRaw: string } | null;
  add: { position: string; addedRaw: string; addedLamports: string; liquidity: string } | null;
  lockedLiquidity: string | null;
};

/** Every creator claim of `t.curve` in the transaction, with the split legs bound to it, and the graduation payouts. */
export function parseCreatorTx(v: TxView, t: CurveTarget): { claims: CurveClaim[]; payouts: { kind: "migrationFee" | "surplus"; lamports: string }[]; creatorUpdates: { creator: string; newCreator: string }[] } {
  if (v.err) return { claims: [], payouts: [], creatorUpdates: [] };
  const payouts: { kind: "migrationFee" | "surplus"; lamports: string }[] = [];
  // a creator handover needs the current creator's signature, so every one is in some creator's own history
  const creatorUpdates = [...v.inner.values()].flatMap(decodeEvents).filter((e): e is Extract<Event, { kind: "creatorUpdate" }> => e.kind === "creatorUpdate" && e.pool === t.curve).map((e) => ({ creator: e.creator, newCreator: e.newCreator }));
  const found: { at: number; quote: bigint; wrapped: boolean; ix: Ix }[] = [];
  for (let i = 0; i < v.top.length; i++) {
    for (const e of eventsOf(v, i)) {
      if (e.kind === "creatorClaim" && e.pool === t.curve) found.push({ at: i, quote: e.quote, wrapped: !(v.top[i].programId.equals(DBC_PROGRAM_ID) && isDisc(v.top[i].data, IX.dbcClaimCreator)), ix: v.top[i] });
      if (e.kind === "migrationFee" && e.pool === t.curve && e.flag === 1) payouts.push({ kind: "migrationFee", lamports: e.fee.toString() });
      if (e.kind === "creatorSurplus" && e.pool === t.curve) payouts.push({ kind: "surplus", lamports: e.amount.toString() });
    }
  }
  const claims = found.map((f): CurveClaim => {
    const base: CurveClaim = { kind: "curve", claimedLamports: f.quote.toString(), creator: "", status: "ambiguous", toBurn: null, buy: null, add: null, lockedLiquidity: null };
    // more than one claim of this curve in one transaction, or a claim inside another program: the legs cannot be bound
    if (found.length > 1 || f.wrapped || f.ix.accounts.length < 9) return base;
    const dest = f.ix.accounts[3].toBase58(), creator = f.ix.accounts[8].toBase58();
    base.creator = creator;
    const transfers: { lamports: string; source: string }[] = [], buys: { inLamports: string; outRaw: string }[] = [];
    const adds: { position: string; addedRaw: string; addedLamports: string; liquidity: string; delta: bigint }[] = [], locks: { position: string; amount: bigint }[] = [];
    for (let j = f.at + 1; j < v.top.length; j++) {
      const ix = v.top[j];
      const tr = transferOf(ix);
      if (tr && tr.dest === t.reserve && tr.source === dest) transfers.push({ lamports: tr.amount.toString(), source: tr.source });
      if (!ix.programId.equals(DAMM_V2_PROGRAM_ID)) continue;
      const ev = eventsOf(v, j);
      if ((isDisc(ix.data, IX.swap) || isDisc(ix.data, IX.swap2)) && ix.accounts[2]?.toBase58() === dest)
        for (const e of ev) if (e.kind === "swap" && e.pool === t.targetPool && e.direction === 1) buys.push({ inLamports: e.amountIn.toString(), outRaw: e.out.toString() });
      if (isDisc(ix.data, IX.addLiquidity))
        for (const e of ev) if (e.kind === "liquidity" && e.pool === t.targetPool && e.changeType === 0 && e.owner === creator) adds.push({ position: e.position, addedRaw: e.a.toString(), addedLamports: e.b.toString(), liquidity: e.delta.toString(), delta: e.delta });
      if (isDisc(ix.data, IX.permanentLock))
        for (const e of ev) if (e.kind === "lock" && e.pool === t.targetPool) locks.push({ position: e.position, amount: e.amount });
    }
    const legs = [transfers, buys, adds, locks];
    if (legs.some((l) => l.length > 1)) return base;
    if (legs.every((l) => l.length === 0)) return { ...base, status: "unsplit" };
    const add = adds[0] ?? null, lock = locks[0] ?? null;
    const lockMatches = !!add && !!lock && lock.position === add.position && lock.amount === add.delta;
    const complete = transfers.length === 1 && buys.length === 1 && lockMatches;
    return {
      ...base, status: complete ? "split" : "incomplete",
      toBurn: transfers[0] ?? null, buy: buys[0] ?? null,
      add: add ? { position: add.position, addedRaw: add.addedRaw, addedLamports: add.addedLamports, liquidity: add.liquidity } : null,
      lockedLiquidity: lockMatches ? lock!.amount.toString() : null,
    };
  });
  return { claims, payouts, creatorUpdates };
}

/** Fee claims of the tail's graduated positions, and whether each went through the burn program's owner claim. */
export type PoolClaim = { kind: "pool"; position: string; owner: string; claimedLamports: string; status: "split" | "unsplit" | "ambiguous"; toBurn: { lamports: string } | null };
export function parsePositionTx(v: TxView, positions: Set<string>, pool: string): PoolClaim[] {
  if (v.err) return [];
  const fees = [...v.inner.values()].flatMap(decodeEvents).filter((e): e is Extract<Event, { kind: "positionFee" }> => e.kind === "positionFee" && positions.has(e.position));
  const splits = [...burnParser.parseLogs(v.logs)].filter((e) => e.name === "ClaimSplit" && Number((e.data as any).source) === 3 && String((e.data as any).pool) === pool);
  return fees.map((f) => {
    const mine = splits.filter((s) => String((s.data as any).claimant) === f.owner);
    const base: PoolClaim = { kind: "pool", position: f.position, owner: f.owner, claimedLamports: f.feeB.toString(), status: "unsplit", toBurn: null };
    if (fees.length > 1 && mine.length) return { ...base, status: "ambiguous" };
    if (mine.length === 0) return base;
    if (mine.length > 1) return { ...base, status: "ambiguous" };
    return { ...base, status: "split", toBurn: { lamports: String((mine[0].data as any).to_reserve) } };
  });
}

// ---------------------------------------------------------------------------------------------------------------
// The reserve's gross ledger.
export type ReserveLeg = { seq: number; dir: "in" | "out"; lamports: string; topLevel: boolean; spentLamports?: string; receivedRaw?: string };
export type ReserveTx = { pre: string; post: string; legs: ReserveLeg[]; ok: boolean };
export function parseReserveTx(v: TxView, reserve: PublicKey): ReserveTx | null {
  if (v.err) return null;
  const bal = v.balance(reserve);
  const r = reserve.toBase58();
  const legs: ReserveLeg[] = [];
  let seq = 0;
  for (let i = 0; i < v.top.length; i++) {
    for (const [ix, topLevel] of [[v.top[i], true], ...(v.inner.get(i) ?? []).map((x) => [x, false])] as [Ix, boolean][]) {
      const t = transferOf(ix);
      if (!t || t.source === t.dest) continue;
      if (t.dest === r) legs.push({ seq: seq++, dir: "in", lamports: t.amount.toString(), topLevel });
      else if (t.source === r) legs.push({ seq: seq++, dir: "out", lamports: t.amount.toString(), topLevel });
    }
  }
  if (!bal && !legs.length) return null;
  const pre = bal?.pre ?? 0n, post = bal?.post ?? 0n;
  if (!legs.length && pre === post) return null;
  // every outflow is a buyback's spend, in order, equal to its event's `spent`
  const buys = [...burnParser.parseLogs(v.logs)].filter((e) => e.name === "BuybackBurned").map((e) => e.data as any);
  const outs = legs.filter((l) => l.dir === "out");
  let ok = outs.length === buys.length;
  outs.forEach((l, k) => { const b = buys[k]; if (!b || String(b.spent) !== l.lamports) ok = false; else { l.spentLamports = String(b.spent); l.receivedRaw = String(b.received); } });
  const net = legs.reduce((s, l) => s + (l.dir === "in" ? BigInt(l.lamports) : -BigInt(l.lamports)), 0n);
  if (pre + net !== post) ok = false;
  return { pre: pre.toString(), post: post.toString(), legs, ok };
}

export type ReserveRow = { signature: string; slot: number; tx: ReserveTx };
export type Traced = { spentLamports: bigint; boughtRaw: bigint; buybacks: string[]; exact: boolean };

/** Orders the ledger and traces every inflow (key `signature#seq`) first in, first out. Within a slot, transactions
 *  are ordered by chaining each one's starting balance to the previous one's ending balance; a slot with more
 *  than one consistent order makes its inflows inexact; a break in the chain, an unexplained movement, or a spend
 *  with nothing queued makes everything after it inexact. Inexact inflows report what was traced but are never
 *  presented as exact. */
export function traceReserve(rows: ReserveRow[]): { traced: Map<string, Traced>; verified: boolean } {
  const bySlot = new Map<number, ReserveRow[]>();
  for (const r of rows) { const l = bySlot.get(r.slot) ?? []; l.push(r); bySlot.set(r.slot, l); }
  const traced = new Map<string, Traced>();
  const queue: { key: string; left: bigint }[] = [];
  let balance = 0n, broken = false;
  for (const slot of [...bySlot.keys()].sort((a, b) => a - b)) {
    const group = bySlot.get(slot)!;
    // every order of this slot's transactions consistent with the running balance (small groups; capped at two found)
    const orders: ReserveRow[][] = [];
    const walk = (left: ReserveRow[], at: bigint, acc: ReserveRow[]) => {
      if (orders.length > 1) return;
      if (!left.length) { orders.push(acc); return; }
      for (const r of left) if (BigInt(r.tx.pre) === at) walk(left.filter((x) => x !== r), BigInt(r.tx.post), [...acc, r]);
    };
    if (!broken && group.length <= 8) walk(group, balance, []);
    let ordered: ReserveRow[], slotExact = true;
    if (orders.length === 1) ordered = orders[0];
    else { ordered = group; slotExact = false; if (orders.length === 0) broken = true; }
    // when the order inside the slot is not unique: SOL that arrived before the slot is spent first in every
    // consistent order, so its attribution only depends on the order when the slot holds more than one buyback
    const inSlot = new Set(group.flatMap((r) => r.tx.legs.filter((l) => l.dir === "in").map((l) => `${r.signature}#${l.seq}`)));
    const outsInSlot = group.reduce((n, r) => n + r.tx.legs.filter((l) => l.dir === "out").length, 0);
    for (const r of ordered) {
      if (!r.tx.ok) broken = true;
      for (const leg of r.tx.legs) {
        const amount = BigInt(leg.lamports);
        if (leg.dir === "in") {
          const key = `${r.signature}#${leg.seq}`;
          queue.push({ key, left: amount });
          traced.set(key, { spentLamports: 0n, boughtRaw: 0n, buybacks: [], exact: !broken && slotExact });
          continue;
        }
        const spent = BigInt(leg.spentLamports ?? leg.lamports), received = leg.receivedRaw !== undefined ? BigInt(leg.receivedRaw) : null;
        let need = amount;
        while (need > 0n && queue.length) {
          const head = queue[0];
          const take = head.left < need ? head.left : need;
          const o = traced.get(head.key)!;
          o.spentLamports += take;
          if (received === null || spent === 0n) o.exact = false; else o.boughtRaw += (received * take) / spent;
          if (!o.buybacks.includes(r.signature)) o.buybacks.push(r.signature);
          if (broken || (!slotExact && (inSlot.has(head.key) || outsInSlot > 1))) o.exact = false;
          head.left -= take; need -= take;
          if (head.left === 0n) queue.shift();
        }
        if (need > 0n) broken = true; // spent more than the ledger saw arrive
      }
      balance = BigInt(r.tx.post);
    }
    if (!slotExact) for (const r of group) for (const l of r.tx.legs) if (l.dir === "in") { const o = traced.get(`${r.signature}#${l.seq}`); if (o) o.exact = false; }
  }
  if (broken) for (const q of queue) traced.get(q.key)!.exact = false;
  return { traced, verified: !broken };
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

/** What the index follows per tail, saved in meta. `origin` is the creator that signed the curve's creation (from
 *  the curve's first transaction); `creators` grows by every handover found in a followed creator's history, so the
 *  whole chain of creators is followed from the first. After graduation, `migration` holds the positions the
 *  migration transaction gave to one of those creators, so a position NFT moved before the worker looked is still
 *  followed. Claims coverage is only complete when the origin and (after graduation) the migration are known. */
/** The saved shape of TailSources; a record of any other version has its migration facts read again from the chain. */
export const TAIL_SOURCES_VERSION = 2;
export type TailSources = {
  v: number; origin: { creator: string; signature: string } | null; creators: string[]; graduated: boolean;
  /** The migration's two positions with their NFT's owner right after it (raw facts, matched against the creators
   *  every time: a creator learned later still gets its migration position). */
  pool: string | null; migration: { signature: string; positions: { position: string; owner: string | null }[] } | null;
};
export async function readSources(store: Store, mint: string): Promise<TailSources> {
  try {
    const v = await store.getMeta(`tail_sources:${mint}`);
    // an older record (any shape, even an empty positions list) keeps its origin and creators but not its
    // migration facts: those are read again from the chain before coverage can be complete
    if (v) { const j = JSON.parse(v); if (j && "origin" in j) return j.v === TAIL_SOURCES_VERSION ? j : { ...j, v: TAIL_SOURCES_VERSION, migration: null }; }
  } catch { /* fresh */ }
  return { v: TAIL_SOURCES_VERSION, origin: null, creators: [], graduated: false, pool: null, migration: null };
}
/** The migration positions held by one of the tail's creators right after the migration. */
export const creatorPositions = (s: TailSources) => (s.migration?.positions ?? []).filter((p) => p.owner !== null && s.creators.includes(p.owner)).map((p) => p.position);
/** Adds every handover recorded so far to the creators; returns how many were new. */
async function absorbHandovers(store: Store, mint: string, s: TailSources): Promise<number> {
  let added = 0;
  for (const r of await store.listTailEvents(`tailCreatorUpdate:${mint}`)) if (!s.creators.includes(r.data.newCreator)) { s.creators.push(r.data.newCreator); added++; }
  if (added) await store.setMeta(`tail_sources:${mint}`, JSON.stringify(s));
  return added;
}

/** The oldest signature of an address: signatures only, newest to oldest in pages. */
export async function oldestSignature(deps: WalkDeps, address: PublicKey): Promise<string | null> {
  let before: string | undefined, last: string | null = null;
  for (;;) {
    const page = await deps.getSignatures(address, { before, limit: 1000 });
    if (!page.length) return last;
    last = page[page.length - 1].signature;
    if (page.length < 1000) return last;
    before = last;
  }
}
const allIxs = (v: TxView) => v.top.flatMap((ix, i) => [ix, ...(v.inner.get(i) ?? [])]);

/** The creator that signed the curve's creation, from the curve's first transaction. */
export function originOf(v: TxView, curve: string): string | null {
  for (const ix of allIxs(v)) if (ix.programId.equals(DBC_PROGRAM_ID) && (isDisc(ix.data, IX.dbcInitSpl) || isDisc(ix.data, IX.dbcInit2022)) && ix.accounts[5]?.toBase58() === curve) return ix.accounts[2].toBase58();
  return null;
}
/** The migration's two positions and their NFT's owner right after it (null when the transaction does not say). */
export function migrationPositions(v: TxView, curve: string): { position: string; owner: string | null }[] | null {
  for (const ix of allIxs(v)) {
    if (!(ix.programId.equals(DBC_PROGRAM_ID) && isDisc(ix.data, IX.dbcMigrateDammV2) && ix.accounts[0]?.toBase58() === curve)) continue;
    return [[6, 7], [9, 10]].map(([nft, pos]) => ({ position: ix.accounts[pos].toBase58(), owner: v.ownerAfter(ix.accounts[nft]) }));
  }
  return null;
}

/** Refreshes a tail's sources: the origin (once), the current creator, graduation and, once, the migration's positions. */
export async function refreshSources(chain: Chain, deps: WalkDeps, store: Store, t: TailSpec): Promise<TailSources> {
  const m = t.mint.toBase58();
  const s = await readSources(store, m);
  const curve = t.curve.toBase58();
  if (!s.origin) {
    const sig = await oldestSignature(deps, t.curve);
    const v = sig ? await deps.readView(sig) : null;
    const creator = v ? originOf(v, curve) : null;
    if (sig && creator) { s.origin = { creator, signature: sig }; if (!s.creators.includes(creator)) s.creators.unshift(creator); }
  }
  // handovers found in followed creators' histories
  await absorbHandovers(store, m, s);
  const pool = await chain.dbcPool(t.curve);
  if (pool) {
    const current = new PublicKey(pool.creator).toBase58();
    if (!s.creators.includes(current)) s.creators.push(current);
    if (Number(pool.migrationProgress) === DBC_PROGRESS.createdPool) {
      s.graduated = true;
      if (!s.pool) {
        const cfg: any = await (chain.dbc.account as any).poolConfig.fetch(t.config, "confirmed");
        s.pool = deriveDammV2PoolAddress(DAMM_V2_MIGRATION_CONFIGS[Number(cfg.migrationFeeOption)], t.mint, NATIVE_MINT).toBase58();
      }
      if (!s.migration) {
        const sig = await oldestSignature(deps, new PublicKey(s.pool));
        const v = sig ? await deps.readView(sig) : null;
        const positions = v ? migrationPositions(v, curve) : null;
        if (sig && positions) s.migration = { signature: sig, positions };
      }
    }
  }
  await store.setMeta(`tail_sources:${m}`, JSON.stringify(s));
  return s;
}

/** The indexer's tail pass: the reserve ledger, then each tail's creators and graduated positions. Rows are named
 *  per tail (`tailClaim:<mint>` …), so one transaction can hold claims of several tails. */
export async function tailIndexPass(deps: WalkDeps, store: Store, tails: TailSpec[], reserve: PublicKey, sourcesOf: (t: TailSpec) => Promise<TailSources>) {
  const row = (v: TxView, name: string, idx: number, data: any): TailEventRow => ({ signature: v.signature, idx, slot: v.slot, blockTime: v.blockTime, name, data });
  await walkPass(deps, store, reserve, "reserve", (v) => { const r = parseReserveTx(v, reserve); return r ? [row(v, "reserveTx", 0, r)] : []; });
  for (const t of tails) {
    const m = t.mint.toBase58();
    const s = await sourcesOf(t);
    const target: CurveTarget = { curve: t.curve.toBase58(), targetPool: t.targetPool.toBase58(), reserve: reserve.toBase58() };
    // follow the creators until no walk turns up a new handover (each handover adds a creator to follow)
    for (let round = 0; round < 8; round++) {
      for (const c of s.creators) await walkPass(deps, store, new PublicKey(c), `tail:${m}:creator:${c}`, (v) => {
        const p = parseCreatorTx(v, target);
        return [...p.claims.map((x, i) => row(v, `tailClaim:${m}`, i, x)), ...p.payouts.map((x, i) => row(v, `tailPayout:${m}`, i, x)), ...p.creatorUpdates.map((x, i) => row(v, `tailCreatorUpdate:${m}`, i, x))];
      });
      if (!(await absorbHandovers(store, m, s))) break;
    }
    const positions = creatorPositions(s);
    if (s.pool) for (const pos of positions) await walkPass(deps, store, new PublicKey(pos), `tail:${m}:position:${pos}`, (v) => parsePositionTx(v, new Set(positions), s.pool!).map((x, i) => row(v, `tailPoolClaim:${m}`, i, x)));
  }
}

// ---------------------------------------------------------------------------------------------------------------
// The view.
type Coverage = { status: "complete" | "partial" | "unavailable"; atMs: number | null };
async function coverage(store: Store, key: string): Promise<Coverage> {
  const v = await store.getMeta(`walk_coverage:${key}`);
  try { const j = v ? JSON.parse(v) : null; return j ? { status: j.status, atMs: j.atMs } : { status: "unavailable", atMs: null }; } catch { return { status: "unavailable", atMs: null }; }
}
const worst = (cs: Coverage[]): Coverage => (!cs.length || cs.some((c) => c.status === "unavailable") ? { status: "unavailable", atMs: null } : cs.some((c) => c.status === "partial") ? { status: "partial", atMs: Math.min(...cs.map((c) => c.atMs ?? 0)) } : { status: "complete", atMs: Math.min(...cs.map((c) => c.atMs ?? 0)) });

export async function tailView(store: Store, tails: TailSpec[], mint: string | null) {
  const reserveRows = (await store.listTailEvents("reserveTx")).map((r) => ({ signature: r.signature, slot: r.slot, tx: r.data as ReserveTx }));
  const reserveCoverage = await coverage(store, "reserve");
  const { traced, verified } = traceReserve(reserveRows);
  const legsOf = new Map(reserveRows.map((r) => [r.signature, r.tx.legs]));
  /** The reserve inflow a claim's transfer to the burn became: the unique inflow of that amount in that transaction. */
  const burnOf = (signature: string, lamports: string | null, topLevel: boolean) => {
    if (lamports === null || reserveCoverage.status !== "complete") return null;
    const legs = (legsOf.get(signature) ?? []).filter((l) => l.dir === "in" && l.lamports === lamports && l.topLevel === topLevel);
    if (legs.length !== 1) return null;
    const t = traced.get(`${signature}#${legs[0].seq}`);
    if (!t || !t.exact) return null;
    return { spentLamports: t.spentLamports.toString(), waitingLamports: (BigInt(lamports) - t.spentLamports).toString(), boughtRaw: t.boughtRaw.toString(), buybacks: t.buybacks };
  };
  const out = [];
  for (const t of tails) {
    const m = t.mint.toBase58();
    if (mint && m !== mint) continue;
    const [curveClaims, poolClaims, payouts] = await Promise.all([store.listTailEvents(`tailClaim:${m}`), store.listTailEvents(`tailPoolClaim:${m}`), store.listTailEvents(`tailPayout:${m}`)]);
    const s = await readSources(store, m);
    const positions = creatorPositions(s);
    // complete only with the whole chain of sources known: the origin; every handover found so far already followed;
    // after graduation the migration, with an owner for each of its positions
    const pendingHandover = (await store.listTailEvents(`tailCreatorUpdate:${m}`)).some((r) => !s.creators.includes(r.data.newCreator));
    const sourcesKnown = !!s.origin && !pendingHandover && (!s.graduated || (!!s.migration && s.migration.positions.every((p) => p.owner !== null)));
    const walked = worst(await Promise.all([...s.creators.map((c) => coverage(store, `tail:${m}:creator:${c}`)), ...positions.map((p) => coverage(store, `tail:${m}:position:${p}`))]));
    const claimCoverage: Coverage = sourcesKnown ? walked : { status: "unavailable", atMs: null };
    const claims = [
      ...curveClaims.map((r) => {
        const d = r.data as CurveClaim;
        const added = d.add ? BigInt(d.add.addedLamports) : 0n, swapped = d.buy ? BigInt(d.buy.inLamports) : 0n, burned = d.toBurn ? BigInt(d.toBurn.lamports) : 0n;
        return { signature: r.signature, idx: r.idx, slot: r.slot, blockTime: r.blockTime, source: "curve" as const, status: d.status, claimedLamports: d.claimedLamports,
          keptLamports: d.status === "ambiguous" ? null : (BigInt(d.claimedLamports) - burned - swapped - added).toString(),
          toBurnLamports: d.toBurn?.lamports ?? null, burn: d.toBurn ? burnOf(r.signature, d.toBurn.lamports, true) : null,
          liquidity: d.add ? { swapInLamports: d.buy?.inLamports ?? null, addedLamports: d.add.addedLamports, addedRaw: d.add.addedRaw, liquidity: d.add.liquidity, locked: d.lockedLiquidity !== null, position: d.add.position } : null };
      }),
      ...poolClaims.map((r) => {
        const d = r.data as PoolClaim;
        return { signature: r.signature, idx: r.idx, slot: r.slot, blockTime: r.blockTime, source: "pool" as const, status: d.status, claimedLamports: d.claimedLamports,
          keptLamports: d.status === "ambiguous" ? null : (BigInt(d.claimedLamports) - BigInt(d.toBurn?.lamports ?? "0")).toString(),
          toBurnLamports: d.toBurn?.lamports ?? null, burn: d.toBurn ? burnOf(r.signature, d.toBurn.lamports, false) : null, liquidity: null };
      }),
    ].sort((a, b) => b.slot - a.slot || a.signature.localeCompare(b.signature) || a.idx - b.idx);
    const sum = (xs: (string | null | undefined)[]) => xs.reduce((acc, x) => acc + BigInt(x ?? "0"), 0n).toString();
    const known = claimCoverage.status === "complete";
    // an ambiguous claim's legs are unknown, not absent: no total of legs while one is listed
    const legsKnown = known && claims.every((c) => c.status !== "ambiguous");
    const burnKnown = legsKnown && reserveCoverage.status === "complete" && verified && claims.every((c) => c.toBurnLamports === null || c.burn !== null);
    const locked = claims.filter((c) => c.liquidity?.locked);
    const mine = payouts;
    out.push({
      mint: m, config: t.config.toBase58(), curve: t.curve.toBase58(), targetPool: t.targetPool.toBase58(),
      creators: s.creators, origin: s.origin, graduatedPool: s.pool, graduatedPositions: positions, positions: [...new Set(claims.map((c) => c.liquidity?.position).filter((p): p is string => !!p))],
      totals: {
        // every total is null until the history it sums is complete: an empty or partial history is not a zero
        claims: known ? claims.length : null,
        notSplit: known ? claims.filter((c) => c.status !== "split").length : null,
        claimedLamports: known ? sum(claims.map((c) => c.claimedLamports)) : null,
        ambiguous: known ? claims.filter((c) => c.status === "ambiguous").length : null,
        toBurnLamports: legsKnown ? sum(claims.map((c) => c.toBurnLamports)) : null,
        boughtRaw: burnKnown ? sum(claims.map((c) => c.burn?.boughtRaw)) : null,
        liquidityLamports: legsKnown ? sum(locked.map((c) => c.liquidity!.addedLamports)) : null,
        liquidityRaw: legsKnown ? sum(locked.map((c) => c.liquidity!.addedRaw)) : null,
        lockedLiquidity: legsKnown ? sum(locked.map((c) => c.liquidity!.liquidity)) : null,
        payoutLamports: known ? sum(mine.map((p) => p.data.lamports)) : null,
      },
      claims,
      payouts: mine.map((p) => ({ signature: p.signature, idx: p.idx, slot: p.slot, blockTime: p.blockTime, kind: p.data.kind, lamports: p.data.lamports })),
      coverage: { claims: claimCoverage, reserve: reserveCoverage, reserveVerified: verified },
    });
  }
  return { tails: out };
}

export function reserveAddress(): PublicKey { return new BurnClient().a.reserve; }
