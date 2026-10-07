// The burn program's history: every ClaimSplit and BuybackBurned event with its signature, slot and time,
// read from the transactions that touch the program's state account (every instruction writes it), into
// their own table (`burn_events`: a vault event of the same transaction can never collide with them).
//
// Cursor (meta `burn_cursor`, saved with the rows in one transaction):
//   head    - the newest signature of the last COMPLETED cycle: everything at or before it is stored;
//   newHead - the newest signature when the current cycle began (the cycle's top);
//   tail    - the oldest signature this cycle has processed so far (walking down from newHead);
//   target  - the head when the cycle began: the walk stops there.
// A cycle walks newHead -> target in pages; the head moves to newHead only once the walk reaches the
// target (or the program's first transaction). A cap, a restart or downtime of any length leaves the
// cycle open and the next pass resumes below its tail; an unreadable transaction stops the pass at it
// (retried next time, never skipped). Coverage is "complete" only when no cycle is open and nothing is
// newer than the head.
import { BN } from "@coral-xyz/anchor";
import { Connection, PublicKey } from "@solana/web3.js";
import { BurnClient } from "@cometail/client";
import { burnParser } from "./burn";
import { readTx } from "./indexer";
import type { EventRow, Store } from "./store";
import { log } from "./tx";

export const BURN_EVENT_NAMES = { ClaimSplit: "burnSplit", BuybackBurned: "burnBuyback" } as const;
export type BurnCursor = { head: string | null; newHead: string | null; tail: string | null; target: string | null };
const COVERAGE = "burn_coverage";
/** Signatures processed per pass at most. */
export const BURN_INDEX_PER_PASS = 300;

type Sig = { signature: string; slot: number; err: unknown; blockTime?: number | null };
export interface BurnIndexDeps {
  getSignatures: (opts: { before?: string; until?: string; limit: number }) => Promise<Sig[]>;
  readLogs: (signature: string) => Promise<{ logs: string[]; blockTime: number | null } | null>;
}

function plain(v: any): any {
  if (v instanceof BN) return v.toString();
  if (v instanceof PublicKey) return v.toBase58();
  if (Array.isArray(v)) return v.map(plain);
  if (v && typeof v === "object") return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, plain(x)]));
  return v;
}

export function chainDeps(connection: Connection): BurnIndexDeps {
  const state = new BurnClient(connection).a.burnState;
  return {
    getSignatures: (o) => connection.getSignaturesForAddress(state, { limit: o.limit, before: o.before, until: o.until }, "confirmed") as Promise<Sig[]>,
    // a transaction without its log messages, or with truncated logs, is unreadable (retried, never read as empty)
    readLogs: async (sig) => {
      const tx: any = await readTx(connection, sig);
      const logs = tx?.meta?.logMessages;
      if (!tx || !Array.isArray(logs) || logs.some((l: string) => /Log truncated/i.test(l))) return null;
      return { logs, blockTime: tx.blockTime ?? null };
    },
  };
}

export async function readCursor(store: Store): Promise<BurnCursor> {
  const v = await store.getMeta("burn_cursor");
  if (!v) return { head: null, newHead: null, tail: null, target: null };
  try { const j = JSON.parse(v); if (j && typeof j === "object" && "head" in j) return j as BurnCursor; } catch { /* the first release stored a bare signature */ }
  // a bare signature from the first candidate is not trusted as a completed head: rebuild from the start
  return { head: null, newHead: null, tail: null, target: null };
}

/** One pass. Returns the number of events stored. */
export async function burnIndexPass(deps: BurnIndexDeps, store: Store, perPass = BURN_INDEX_PER_PASS): Promise<number> {
  const c = await readCursor(store);
  if (!c.newHead) {
    const top = await deps.getSignatures({ limit: 1 });
    if (!top.length || top[0].signature === c.head) { await store.setMeta(COVERAGE, JSON.stringify({ status: c.head || !top.length ? "complete" : "partial", atMs: Date.now() })); return 0; }
    c.newHead = top[0].signature; c.target = c.head; c.tail = null;
  }
  const rows: EventRow[] = [];
  let processed = 0, stopped = false, reachedTarget = false;
  // the first page of a cycle starts at newHead itself (skipping anything newer: the next cycle takes it)
  let before: string | undefined = c.tail ?? undefined, skipToTop = !c.tail;
  outer: while (processed < perPass) {
    const page = await deps.getSignatures({ before, until: c.target ?? undefined, limit: 100 });
    let list = page;
    if (skipToTop) {
      const at = list.findIndex((s) => s.signature === c.newHead);
      // the cycle's top must be found; if it is not, the cycle restarts next pass (never marked complete)
      if (at < 0) { if (page.length < 100) { c.newHead = null; c.tail = null; c.target = null; stopped = true; break; } before = page[page.length - 1].signature; continue; }
      list = list.slice(at); skipToTop = false;
    }
    for (const s of list) {
      if (processed >= perPass) break outer;
      if (!s.err) {
        const tx = await deps.readLogs(s.signature);
        if (!tx) { stopped = true; break outer; }
        let ordinal = 0;
        for (const ev of burnParser.parseLogs(tx.logs)) {
          const name = BURN_EVENT_NAMES[ev.name as keyof typeof BURN_EVENT_NAMES];
          if (!name) continue;
          rows.push({ signature: s.signature, idx: ordinal++, slot: s.slot, blockTime: tx.blockTime ?? s.blockTime ?? null, name, vault: null, data: plain(ev.data) });
        }
      }
      c.tail = s.signature; processed++;
    }
    if (page.length < 100) { reachedTarget = !stopped; break; }
    before = page[page.length - 1].signature;
  }
  if (reachedTarget && !stopped) { c.head = c.newHead; c.newHead = null; c.tail = null; c.target = null; }
  await store.insertBurnEvents(rows, JSON.stringify(c));
  // complete only when no cycle is open AND nothing on chain is newer than the head
  let complete = c.newHead === null && !stopped;
  if (complete) { const top = await deps.getSignatures({ limit: 1 }); complete = !top.length || top[0].signature === c.head; }
  await store.setMeta(COVERAGE, JSON.stringify({ status: complete ? "complete" : "partial", atMs: Date.now() }));
  if (rows.length || !complete) log("burn index", { events: rows.length, processed, complete });
  return rows.length;
}

export async function burnCoverage(store: Store): Promise<{ status: "complete" | "partial" | "unavailable"; atMs: number | null }> {
  const v = await store.getMeta(COVERAGE);
  if (!v) return { status: "unavailable", atMs: null };
  try { const j = JSON.parse(v); return { status: j.status, atMs: j.atMs }; } catch { return { status: "unavailable", atMs: null }; }
}
