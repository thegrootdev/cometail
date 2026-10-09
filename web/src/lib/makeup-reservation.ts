// The one-time make-up of a tail claim (/admin/tails) must never be paid twice from this browser. A per-claim
// reservation in localStorage is taken, changed and released only inside a Web Lock shared by every tab of the
// site, before anything is read over the network. It names the page that holds it; once the wallet has signed, it
// also holds the transaction's signature and blockhash, recorded before the transaction is sent. A reservation
// never expires with time: a signed one is released only when the chain shows the transaction failed (confirmed), or that it
// never landed and its blockhash has expired; one that landed stays (the make-up is done). One with no signature
// may belong to a page that is still building; only the owner releases it by hand, and a page whose reservation
// was released or replaced stops before its wallet signs or before it sends. Without Web Locks or storage, no
// make-up is sent from this browser at all.
import type { Connection } from "@solana/web3.js";

export type Reservation = {
  id: string; at: number; phase: "reserved" | "signed";
  signature?: string; blockhash?: string; lastValidBlockHeight?: number | null;
};
export type ReservationState =
  | { kind: "none" }
  | { kind: "reserved"; r: Reservation }
  | { kind: "pending"; r: Reservation }
  | { kind: "landed"; r: Reservation }
  | { kind: "unknown"; r: Reservation; reason: string };

const key = (mint: string, claim: string) => `cometail:tail-makeup:${mint}:${claim}`;
const lockName = (mint: string, claim: string) => `cometail-tail-makeup-${mint}-${claim}`;

/** Runs `fn` while holding this claim's lock, in every tab of the site; refuses when the browser has none. */
async function exclusive<T>(mint: string, claim: string, fn: () => T): Promise<T> {
  const locks = typeof navigator !== "undefined" ? (navigator as Navigator & { locks?: LockManager }).locks : undefined;
  if (!locks?.request) throw new Error("this browser has no Web Locks: make-ups are not sent from it");
  return locks.request(lockName(mint, claim), { mode: "exclusive" }, async () => fn());
}
function storage(): Storage {
  const s = typeof window !== "undefined" ? window.localStorage : undefined;
  if (!s) throw new Error("this browser has no local storage: make-ups are not sent from it");
  return s;
}
function readNow(mint: string, claim: string): Reservation | null {
  const v = storage().getItem(key(mint, claim));
  if (v === null) return null;
  try { const r = JSON.parse(v); if (r && typeof r.id === "string" && (r.phase === "reserved" || r.phase === "signed")) return r; } catch { /* below */ }
  // something unreadable under this key is treated as held, never as free
  return { id: "unreadable", at: 0, phase: "reserved" };
}

/** Takes the reservation for this page (`id`), or returns the one already there. */
export function reserve(mint: string, claim: string, id: string): Promise<Reservation | null> {
  return exclusive(mint, claim, () => {
    const r = readNow(mint, claim);
    if (r) return r;
    storage().setItem(key(mint, claim), JSON.stringify({ id, at: Date.now(), phase: "reserved" } satisfies Reservation));
    return null;
  });
}
/** Throws unless this page still holds the reservation and has not signed under it. */
export function stillReserved(mint: string, claim: string, id: string): Promise<void> {
  return exclusive(mint, claim, () => {
    const r = readNow(mint, claim);
    if (!r || r.id !== id || r.phase !== "reserved") throw new Error("this make-up's reservation was released or taken elsewhere: nothing was sent");
  });
}
/** Records what the wallet signed, before it is sent; throws (nothing is sent) unless this page still holds it. */
export function recordSigned(mint: string, claim: string, id: string, s: { signature: string; blockhash: string; lastValidBlockHeight: number | null }): Promise<void> {
  return exclusive(mint, claim, () => {
    const r = readNow(mint, claim);
    if (!r || r.id !== id || r.phase !== "reserved") throw new Error("this make-up's reservation was released or taken elsewhere: nothing was sent");
    storage().setItem(key(mint, claim), JSON.stringify({ ...r, phase: "signed", ...s } satisfies Reservation));
  });
}
/** Releases a reservation that never reached a signature: only the same one (same id), only while unsigned. */
export function releaseUnsigned(mint: string, claim: string, id: string): Promise<boolean> {
  return exclusive(mint, claim, () => {
    const r = readNow(mint, claim);
    if (!r || r.id !== id || r.phase !== "reserved") return false;
    storage().removeItem(key(mint, claim));
    return true;
  });
}
export function current(mint: string, claim: string): Promise<Reservation | null> {
  return exclusive(mint, claim, () => readNow(mint, claim));
}

/** What a reservation means now. A signed one is read from the chain: landed (done, never again), failed or
 *  expired without landing (released here), or still able to land (pending). */
export async function settle(connection: Connection, mint: string, claim: string): Promise<ReservationState> {
  const r = await current(mint, claim);
  if (!r) return { kind: "none" };
  if (r.phase === "reserved") return { kind: "reserved", r };
  if (!r.signature || !r.blockhash) return { kind: "unknown", r, reason: "the reservation holds no transaction identity" };
  const status = async () => (await connection.getSignatureStatuses([r.signature!], { searchTransactionHistory: true })).value[0];
  try {
    const s = await status();
    // only a confirmed (or finalized) outcome settles it, success or failure: a processed one can still be rolled back
    const settled = !!s && (s.confirmationStatus === "confirmed" || s.confirmationStatus === "finalized");
    if (s && settled && s.err === null) return { kind: "landed", r };
    if (s && settled) return (await releaseSigned(mint, claim, r)) ? { kind: "none" } : settle(connection, mint, claim);
    if (s) return { kind: "pending", r }; // processed (or no level given), whatever its result: it may still change
    // not seen: it can still land while its blockhash is valid
    const expired = r.lastValidBlockHeight != null
      ? (await connection.getBlockHeight("confirmed")) > r.lastValidBlockHeight
      : !(await connection.isBlockhashValid(r.blockhash, { commitment: "confirmed" })).value;
    if (!expired) return { kind: "pending", r };
    // the blockhash expired: one more look, then it can never land
    if (await status()) return settle(connection, mint, claim);
    return (await releaseSigned(mint, claim, r)) ? { kind: "none" } : settle(connection, mint, claim);
  } catch (e: unknown) {
    return { kind: "unknown", r, reason: String((e as Error)?.message ?? e) };
  }
}
function releaseSigned(mint: string, claim: string, seen: Reservation): Promise<boolean> {
  return exclusive(mint, claim, () => {
    const r = readNow(mint, claim);
    if (!r || r.id !== seen.id || r.signature !== seen.signature) return false;
    storage().removeItem(key(mint, claim));
    return true;
  });
}
