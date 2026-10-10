// $COMETAIL burned from paired-coin fees: the paired configs' fee claimer claims on /admin/fees; the claim pays into a
// fresh account created in the same transaction, half of it is burned there and the rest is sent to the claimer's
// $COMETAIL account (web/src/lib/protocol-fees.ts, buildPairedClaim). This walks that account's whole history (every
// such claim sends to it) and records the burns that came from a claim's payment, and apart any other burn from it.
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

/** Where each supported claim pays its quote: discriminator (hex) -> program and the index of its quote destination
 *  (DBC claim_trading_fee token_b_account, DBC partner_withdraw_surplus token_quote_account, DAMM v2 claim_position_fee
 *  token_b_account; web/src/lib/protocol-fees.ts CLAIM_QUOTE_DESTINATION). */
const CLAIMS: Record<string, { program: string; at: number }> = {
  "08ec5931987db151": { program: DBC, at: 4 },
  "a8ad4864c962265c": { program: DBC, at: 3 },
  "b4269a118521a2d3": { program: DAMM, at: 4 },
};
/** One transaction's burns of `mint`. A burn counts as a paired claim's burn only when its source is the $COMETAIL
 *  destination of a supported claim instruction in the same transaction and that account held nothing of the mint
 *  before it (the fresh account the claim builder creates): what it burned came from that claim's payment. Any other
 *  burn from `account` (the fee claimer's own $COMETAIL account) is reported apart. */
export function burnsIn(tx: IndexedTx, account: string, mint: string): { amount: bigint; withClaim: boolean; other: bigint } {
  const keys = tx.transaction.message.getAccountKeys({ accountKeysFromLookups: tx.meta?.loadedAddresses });
  const key = (i: number) => keys.get(i)?.toBase58() ?? "";
  const all: { program: string; accounts: string[]; data: Buffer }[] = tx.transaction.message.compiledInstructions.map((ix) => ({ program: key(ix.programIdIndex), accounts: ix.accountKeyIndexes.map(key), data: Buffer.from(ix.data) }));
  for (const g of tx.meta?.innerInstructions ?? []) for (const ix of g.instructions) all.push({ program: key(ix.programIdIndex), accounts: ix.accounts.map(key), data: Buffer.from(utils.bytes.bs58.decode(ix.data)) });
  // accounts that held the mint before the transaction (a fresh account has no pre-balance, or a zero one)
  const held = new Set<string>();
  for (const b of (tx.meta as any)?.preTokenBalances ?? []) if (b.mint === mint && BigInt(b.uiTokenAmount?.amount ?? "0") > 0n) held.add(key(b.accountIndex));
  const paidInto = new Set<string>();
  for (const ix of all) {
    const c = CLAIMS[ix.data.subarray(0, 8).toString("hex")];
    if (c && ix.program === c.program && ix.accounts[c.at]) paidInto.add(ix.accounts[c.at]);
  }
  let amount = 0n, other = 0n;
  for (const ix of all) {
    // SPL Token Burn (8) and BurnChecked (15): [token account, mint, authority], then the u64 amount
    if (ix.program !== TOKEN_PROGRAM_ID.toBase58() || ix.data.length < 9 || (ix.data[0] !== 8 && ix.data[0] !== 15) || ix.accounts[1] !== mint) continue;
    const n = ix.data.readBigUInt64LE(1), src = ix.accounts[0];
    if (paidInto.has(src) && !held.has(src)) amount += n;
    else if (src === account) other += n;
  }
  return { amount, withClaim: amount > 0n, other };
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
      const at = { signature: s.signature, slot: s.slot, blockTime: tx.blockTime ?? s.blockTime ?? null };
      if (b.amount > 0n) { state.burns.push({ ...at, amountRaw: b.amount.toString(), withClaim: true }); added++; }
      if (b.other > 0n) { state.burns.push({ ...at, amountRaw: b.other.toString(), withClaim: false }); added++; }
    }
    state.head = s.signature;
  }
  state.complete = !stopped; state.atMs = Date.now();
  await store.setMeta(META, JSON.stringify(state));
  if (added || stopped) log("paired burns", { added, complete: state.complete });
  return added;
}
