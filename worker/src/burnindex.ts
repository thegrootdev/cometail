// The burn program's history: every FeesSplit and BuybackBurned event, with its signature, slot and
// time, read from the transactions that touch the program's state account (every instruction writes
// it). Oldest first, behind its own cursor; a transaction that cannot be read yet stops the pass
// there (coverage "partial") and is retried, never skipped.
import { BN } from "@coral-xyz/anchor";
import { PublicKey } from "@solana/web3.js";
import { BurnClient } from "@cometail/client";
import { Chain } from "./chain";
import { burnParser } from "./burn";
import { readTx } from "./indexer";
import type { EventRow, Store } from "./store";
import { log } from "./tx";

export const BURN_EVENT_NAMES = { FeesSplit: "burnSplit", BuybackBurned: "burnBuyback" } as const;
const CURSOR = "burn_cursor", COVERAGE = "burn_coverage";
const PER_PASS = 200;

function plain(v: any): any {
  if (v instanceof BN) return v.toString();
  if (v instanceof PublicKey) return v.toBase58();
  if (Array.isArray(v)) return v.map(plain);
  if (v && typeof v === "object") return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, plain(x)]));
  return v;
}

export async function burnIndexPass(chain: Chain, store: Store): Promise<number> {
  const state = new BurnClient(chain.connection).a.burnState;
  const cursor = await store.getMeta(CURSOR);
  // newest first down to the cursor (or the program's first transaction)
  const sigs: { signature: string; slot: number; err: unknown; blockTime?: number | null }[] = [];
  let before: string | undefined;
  for (;;) {
    const page = await chain.connection.getSignaturesForAddress(state, { limit: 100, before, until: cursor ?? undefined }, "confirmed");
    sigs.push(...page);
    if (page.length < 100 || sigs.length >= 5_000) break;
    before = page[page.length - 1].signature;
  }
  if (!sigs.length) { await store.setMeta(COVERAGE, JSON.stringify({ status: "complete", atMs: Date.now() })); return 0; }
  const oldestFirst = sigs.reverse().slice(0, PER_PASS);
  const rows: EventRow[] = [];
  let last = cursor, stopped = false;
  for (const s of oldestFirst) {
    if (!s.err) {
      const tx: any = await readTx(chain.connection, s.signature);
      if (!tx) { stopped = true; break; }
      let ordinal = 0;
      for (const ev of burnParser.parseLogs(tx.meta?.logMessages ?? [])) {
        const name = BURN_EVENT_NAMES[ev.name as keyof typeof BURN_EVENT_NAMES];
        if (!name) continue;
        rows.push({ signature: s.signature, idx: ordinal++, slot: s.slot, blockTime: tx.blockTime ?? s.blockTime ?? null, name, vault: null, data: plain(ev.data) } as EventRow);
      }
    }
    last = s.signature;
  }
  if (last && last !== cursor) await store.insertEventsWithCursor(rows, CURSOR, last);
  const complete = !stopped && oldestFirst.length === sigs.length;
  await store.setMeta(COVERAGE, JSON.stringify({ status: complete ? "complete" : "partial", atMs: Date.now() }));
  if (rows.length) log("burn index", { events: rows.length, complete });
  return rows.length;
}

export async function burnCoverage(store: Store): Promise<{ status: "complete" | "partial" | "unavailable"; atMs: number | null }> {
  const v = await store.getMeta(COVERAGE);
  if (!v) return { status: "unavailable", atMs: null };
  try { const j = JSON.parse(v); return { status: j.status, atMs: j.atMs }; } catch { return { status: "unavailable", atMs: null }; }
}
