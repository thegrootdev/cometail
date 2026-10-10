// $COMETAIL burned from paired-coin fees: the paired configs' fee claimer claims on /admin/fees; the claim pays into a
// fresh account created in the same transaction, half of it is burned there and the rest is sent to the claimer's
// $COMETAIL account (web/src/lib/protocol-fees.ts, buildPairedClaim). This walks that account's whole history (every
// such claim sends to it) and records the burns proven to come from the claimer's own claim payment (burnsIn), apart
// any other burn from that account, and apart burns whose provenance is not proven. Saved under meta `paired_burns`,
// with the parser's version: a saved walk from another version is rebuilt from the start. Complete only when the walk reached the account's first transaction and nothing
// newer was left; an unreadable transaction stops the pass (retried next time, never skipped).
import { utils } from "@coral-xyz/anchor";
import { Connection, PublicKey } from "@solana/web3.js";
import { getAssociatedTokenAddressSync, TOKEN_PROGRAM_ID } from "@solana/spl-token";
import { readTx, type IndexedTx } from "./indexer";
import type { Store } from "./store";
import { log } from "./tx";

const META = "paired_burns";
const DBC = "dbcij3LWUppWqq96dh6gJWwBifmcGfLSB5D4DuSMaqN", DAMM = "cpamdpZCGKUy5JxQXB4dcpGPiikHawvSWAd6mEn1sGG";
/** Bumped whenever burnsIn's classification changes, so saved results are never reused across versions. */
export const PAIRED_BURNS_VERSION = 2;
export interface PairedBurn { signature: string; slot: number; blockTime: number | null; amountRaw: string; withClaim: boolean; kind: "claim" | "other" | "unproven" }
export interface PairedBurns { version: number; account: string; mint: string; claimer: string; configs: string[]; head: string | null; burns: PairedBurn[]; complete: boolean; atMs: number }

type Sig = { signature: string; slot: number; err: unknown; blockTime?: number | null };
export interface PairedBurnDeps { getSignatures: (account: PublicKey, o: { before?: string; until?: string; limit: number }) => Promise<Sig[]>; readTx: (sig: string) => Promise<IndexedTx | null> }
export const pairedBurnDeps = (c: Connection): PairedBurnDeps => ({
  getSignatures: (a, o) => c.getSignaturesForAddress(a, { limit: o.limit, before: o.before, until: o.until }, "confirmed") as Promise<Sig[]>,
  readTx: (s) => readTx(c, s),
});

/** The supported claims, by discriminator (hex): program, and the indexes of the quote destination, the quote vault it
 *  pays from, the quote mint, the account that must sign as the fee claimer or position owner, and the DBC config
 *  (DBC claim_trading_fee, DBC partner_withdraw_surplus, DAMM v2 claim_position_fee; account orders from Meteora's IDLs;
 *  web/src/lib/protocol-fees.ts CLAIM_QUOTE_DESTINATION). */
const CLAIMS: Record<string, { program: string; dest: number; vault: number; mint: number; signer: number; config: number | null }> = {
  "08ec5931987db151": { program: DBC, dest: 4, vault: 6, mint: 8, signer: 9, config: 1 },
  "a8ad4864c962265c": { program: DBC, dest: 3, vault: 4, mint: 5, signer: 6, config: 1 },
  "b4269a118521a2d3": { program: DAMM, dest: 4, vault: 6, mint: 8, signer: 10, config: null },
};
const TOKEN = TOKEN_PROGRAM_ID.toBase58();
type Ix = { program: string; accounts: string[]; data: Buffer; top: number; inner: boolean };
/** A classic token instruction that moves `mint` tokens: its kind, source (null for a mint), destination and amount. */
function tokenMove(ix: Ix, mint: string): { kind: "transfer" | "burn" | "mint"; from: string | null; to: string | null; amount: bigint } | null {
  if (ix.program !== TOKEN || ix.data.length < 9) return null;
  const n = ix.data.readBigUInt64LE(1), a = ix.accounts;
  switch (ix.data[0]) {
    case 3: return { kind: "transfer", from: a[0], to: a[1], amount: n }; // Transfer: [source, destination, authority] (mint unnamed)
    case 12: return a[1] === mint ? { kind: "transfer", from: a[0], to: a[2], amount: n } : null; // TransferChecked: [source, mint, destination, authority]
    case 7: case 14: return a[0] === mint ? { kind: "mint", from: null, to: a[1], amount: n } : null; // MintTo(Checked): [mint, destination, authority]
    case 8: case 15: return a[1] === mint ? { kind: "burn", from: a[0], to: null, amount: n } : null; // Burn(Checked): [account, mint, authority]
    default: return null;
  }
}

/** One transaction's burns of `mint`, against the watched fee claimer and its $COMETAIL account `account`.
 *  A burn is the claimer's fee burn (`amount`) only when everything about the fresh account it burns from is proven:
 *  - a supported claim instruction, top level, pays into it; the claimer signs that claim as its fee claimer (or the
 *    position's owner), its quote mint is `mint`, and (for a DBC claim, when `configs` is given) its config is one of them;
 *  - the account held nothing of `mint` before the transaction, and the only `mint` that entered it in the whole
 *    transaction is what the claims' own transfers (inner instructions of those claims, from the claim's quote vault)
 *    paid: P, with P > 0;
 *  - out of it went exactly floor(P/2) burned and P - floor(P/2) transferred, all of that to `account`.
 *  A burn from any other account a claim paid into (unrelated claimer, other inflows, a different split, a zero payout)
 *  is `unproven` and stays out of the fee total. A burn from `account` itself is `other`. */
export function burnsIn(tx: IndexedTx, w: { account: string; mint: string; claimer: string; configs?: Set<string> | null }): { amount: bigint; withClaim: boolean; other: bigint; unproven: bigint } {
  const { account, mint, claimer } = w;
  const msg = tx.transaction.message;
  const keys = msg.getAccountKeys({ accountKeysFromLookups: tx.meta?.loadedAddresses });
  const key = (i: number) => keys.get(i)?.toBase58() ?? "";
  const signers = new Set<string>();
  // signers: the first numRequiredSignatures keys (no header known: no signer, so nothing is bound)
  for (let i = 0; i < (msg.header?.numRequiredSignatures ?? 0); i++) signers.add(key(i));
  const all: Ix[] = msg.compiledInstructions.map((ix, top) => ({ program: key(ix.programIdIndex), accounts: ix.accountKeyIndexes.map(key), data: Buffer.from(ix.data), top, inner: false }));
  for (const g of tx.meta?.innerInstructions ?? []) for (const ix of g.instructions) all.push({ program: key(ix.programIdIndex), accounts: ix.accounts.map(key), data: Buffer.from(utils.bytes.bs58.decode(ix.data)), top: g.index, inner: true });
  // accounts that held the mint before the transaction (a fresh account has no pre-balance, or a zero one)
  const held = new Set<string>();
  for (const b of (tx.meta as any)?.preTokenBalances ?? []) if (b.mint === mint && BigInt(b.uiTokenAmount?.amount ?? "0") > 0n) held.add(key(b.accountIndex));
  // every account a recognized claim pays into, and what the claimer's own claims proved they paid there
  const paidInto = new Set<string>();
  const proven = new Map<string, bigint>(), unbound = new Set<string>();
  for (const ix of all) {
    const c = CLAIMS[ix.data.subarray(0, 8).toString("hex")];
    if (!c || ix.program !== c.program || !ix.accounts[c.dest]) continue;
    const dest = ix.accounts[c.dest];
    paidInto.add(dest);
    const bound = !ix.inner && ix.accounts[c.signer] === claimer && signers.has(claimer) && ix.accounts[c.mint] === mint
      && (c.config === null || !w.configs || w.configs.has(ix.accounts[c.config]));
    if (!bound) { unbound.add(dest); continue; }
    // the claim's actual payout: its own inner transfers from its quote vault into the destination
    let paid = 0n;
    for (const t of all) {
      if (!t.inner || t.top !== ix.top) continue;
      const m = tokenMove(t, mint);
      if (m && m.kind === "transfer" && m.from === ix.accounts[c.vault] && m.to === dest) paid += m.amount;
    }
    proven.set(dest, (proven.get(dest) ?? 0n) + paid);
  }
  // per fresh account: everything that entered it, burned from it, and left it (and where to)
  const flows = new Map<string, { inflow: bigint; burned: bigint; out: bigint; outElsewhere: boolean }>();
  const flow = (k: string) => flows.get(k) ?? (flows.set(k, { inflow: 0n, burned: 0n, out: 0n, outElsewhere: false }), flows.get(k)!);
  let other = 0n;
  for (const ix of all) {
    const m = tokenMove(ix, mint);
    if (!m) continue;
    if (m.to && paidInto.has(m.to)) flow(m.to).inflow += m.amount;
    if (m.from && paidInto.has(m.from)) {
      const f = flow(m.from);
      if (m.kind === "burn") f.burned += m.amount;
      else { f.out += m.amount; if (m.to !== account) f.outElsewhere = true; }
    } else if (m.kind === "burn" && m.from === account) other += m.amount;
  }
  let amount = 0n, unproven = 0n;
  for (const [dest, f] of flows) {
    if (f.burned === 0n) continue;
    const P = proven.get(dest) ?? 0n;
    const ok = !unbound.has(dest) && proven.has(dest) && !held.has(dest) && dest !== account && P > 0n && f.inflow === P
      && f.burned === P / 2n && f.out === P - P / 2n && !f.outElsewhere;
    if (ok) amount += f.burned; else unproven += f.burned;
  }
  return { amount, withClaim: amount > 0n, other, unproven };
}

export async function readPairedBurns(store: Store): Promise<PairedBurns | null> {
  const v = await store.getMeta(META);
  if (!v) return null;
  try { return JSON.parse(v) as PairedBurns; } catch { return null; }
}

/** One pass: everything newer than the saved head, read oldest first. Returns the number of burns added. */
export async function pairedBurnPass(deps: PairedBurnDeps, store: Store, a: { mint: string; claimer: string; configs?: string[] }): Promise<number> {
  const account = getAssociatedTokenAddressSync(new PublicKey(a.mint), new PublicKey(a.claimer)).toBase58();
  const configs = [...(a.configs ?? [])].sort();
  const saved = await readPairedBurns(store);
  // reused only when saved by this parser version for the same account, claimer and configs; otherwise rebuilt
  const same = saved && saved.version === PAIRED_BURNS_VERSION && saved.account === account && saved.mint === a.mint && saved.claimer === a.claimer && JSON.stringify(saved.configs ?? []) === JSON.stringify(configs);
  const state: PairedBurns = same ? saved! : { version: PAIRED_BURNS_VERSION, account, mint: a.mint, claimer: a.claimer, configs, head: null, burns: [], complete: false, atMs: 0 };
  const watched = { account, mint: a.mint, claimer: a.claimer, configs: configs.length ? new Set(configs) : null };
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
      const b = burnsIn(tx, watched);
      const at = { signature: s.signature, slot: s.slot, blockTime: tx.blockTime ?? s.blockTime ?? null };
      if (b.amount > 0n) { state.burns.push({ ...at, amountRaw: b.amount.toString(), withClaim: true, kind: "claim" }); added++; }
      if (b.other > 0n) { state.burns.push({ ...at, amountRaw: b.other.toString(), withClaim: false, kind: "other" }); added++; }
      if (b.unproven > 0n) { state.burns.push({ ...at, amountRaw: b.unproven.toString(), withClaim: false, kind: "unproven" }); added++; }
    }
    state.head = s.signature;
  }
  state.complete = !stopped; state.atMs = Date.now();
  await store.setMeta(META, JSON.stringify(state));
  if (added || stopped) log("paired burns", { added, complete: state.complete });
  return added;
}
