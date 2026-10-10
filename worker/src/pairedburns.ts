// $COMETAIL burned from paired-coin fees: the paired configs' fee claimer claims on /admin/fees, and the same
// transaction burns half of what the claim paid from the claimer's $COMETAIL account (web/src/lib/protocol-fees.ts,
// buildPairedClaim). This walks that account's whole history (it is small: claims and burns) and records every
// Burn or BurnChecked of the mint from it, with whether the same transaction called DBC or DAMM v2 (the claim).
// Saved under meta `paired_burns`. Complete only when the walk reached the account's first transaction and nothing
// newer was left; an unreadable transaction stops the pass (retried next time, never skipped).
import { utils } from "@coral-xyz/anchor";
import { Connection, PublicKey } from "@solana/web3.js";
import { getAssociatedTokenAddressSync, TOKEN_PROGRAM_ID } from "@solana/spl-token";
import { readTx, type IndexedTx } from "./indexer";
import type { Store } from "./store";
import { log } from "./tx";

const META = "paired_burns";
const DBC = "dbcij3LWUppWqq96dh6gJWwBifmcGfLSB5D4DuSMaqN", DAMM = "cpamdpZCGKUy5JxQXB4dcpGPiikHawvSWAd6mEn1sGG";
export interface PairedBurn { signature: string; slot: number; blockTime: number | null; amountRaw: string; withClaim: boolean }
export interface PairedBurns { account: string; mint: string; claimer: string; head: string | null; burns: PairedBurn[]; complete: boolean; atMs: number }

type Sig = { signature: string; slot: number; err: unknown; blockTime?: number | null };
export interface PairedBurnDeps { getSignatures: (account: PublicKey, o: { before?: string; until?: string; limit: number }) => Promise<Sig[]>; readTx: (sig: string) => Promise<IndexedTx | null> }
export const pairedBurnDeps = (c: Connection): PairedBurnDeps => ({
  getSignatures: (a, o) => c.getSignaturesForAddress(a, { limit: o.limit, before: o.before, until: o.until }, "confirmed") as Promise<Sig[]>,
  readTx: (s) => readTx(c, s),
});

/** The burns of `mint` from `account` in one transaction (top-level and inner instructions), and whether it called DBC or DAMM v2. */
export function burnsIn(tx: IndexedTx, account: string, mint: string): { amount: bigint; withClaim: boolean } {
  const keys = tx.transaction.message.getAccountKeys({ accountKeysFromLookups: tx.meta?.loadedAddresses });
  const key = (i: number) => keys.get(i)?.toBase58() ?? "";
  const all: { program: string; accounts: string[]; data: Buffer }[] = tx.transaction.message.compiledInstructions.map((ix) => ({ program: key(ix.programIdIndex), accounts: ix.accountKeyIndexes.map(key), data: Buffer.from(ix.data) }));
  for (const g of tx.meta?.innerInstructions ?? []) for (const ix of g.instructions) all.push({ program: key(ix.programIdIndex), accounts: ix.accounts.map(key), data: Buffer.from(utils.bytes.bs58.decode(ix.data)) });
  let amount = 0n;
  for (const ix of all) {
    // SPL Token Burn (8) and BurnChecked (15): [token account, mint, authority], then the u64 amount
    if (ix.program !== TOKEN_PROGRAM_ID.toBase58() || ix.data.length < 9 || (ix.data[0] !== 8 && ix.data[0] !== 15)) continue;
    if (ix.accounts[0] !== account || ix.accounts[1] !== mint) continue;
    amount += ix.data.readBigUInt64LE(1);
  }
  return { amount, withClaim: all.some((ix) => ix.program === DBC || ix.program === DAMM) };
}

export async function readPairedBurns(store: Store): Promise<PairedBurns | null> {
  const v = await store.getMeta(META);
  if (!v) return null;
  try { return JSON.parse(v) as PairedBurns; } catch { return null; }
}

/** One pass: everything newer than the saved head, read oldest first. Returns the number of burns added. */
export async function pairedBurnPass(deps: PairedBurnDeps, store: Store, a: { mint: string; claimer: string }): Promise<number> {
  const account = getAssociatedTokenAddressSync(new PublicKey(a.mint), new PublicKey(a.claimer)).toBase58();
  const saved = await readPairedBurns(store);
  const state: PairedBurns = saved && saved.account === account && saved.mint === a.mint ? saved : { account, mint: a.mint, claimer: a.claimer, head: null, burns: [], complete: false, atMs: 0 };
  const fresh: Sig[] = [];
  let before: string | undefined;
  for (;;) {
    const page = await deps.getSignatures(new PublicKey(account), { before, until: state.head ?? undefined, limit: 1000 });
    fresh.push(...page);
    if (page.length < 1000) break;
    before = page[page.length - 1].signature;
  }
  let added = 0, stopped = false;
  for (const s of fresh.reverse()) {
    if (!s.err) {
      const tx = await deps.readTx(s.signature);
      if (!tx) { stopped = true; break; }
      const b = burnsIn(tx, account, a.mint);
      if (b.amount > 0n) { state.burns.push({ signature: s.signature, slot: s.slot, blockTime: tx.blockTime ?? s.blockTime ?? null, amountRaw: b.amount.toString(), withClaim: b.withClaim }); added++; }
    }
    state.head = s.signature;
  }
  state.complete = !stopped; state.atMs = Date.now();
  await store.setMeta(META, JSON.stringify(state));
  if (added || stopped) log("paired burns", { added, complete: state.complete });
  return added;
}
