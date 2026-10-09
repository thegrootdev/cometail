// The make-up reservation (web/src/lib/makeup-reservation.ts) that keeps /admin/tails from paying a tail claim's
// make-up twice from one browser (two tabs, a lagging index): taken under a lock every tab shares before any
// network read; never expiring with time; a signed one settled only from the chain; a page that lost its
// reservation stops before signing or sending; no locks or no storage, no make-up.
import { expect } from "chai";
import { recordSigned, releaseUnsigned, reserve, settle, stillReserved } from "../../web/src/lib/makeup-reservation";

/** Web Locks as browsers give them: one holder per name at a time, across every tab of the origin. */
function fakeLocks() {
  const tails = new Map<string, Promise<unknown>>();
  return {
    request: (name: string, _o: unknown, fn: () => Promise<unknown>) => {
      const prev = tails.get(name) ?? Promise.resolve();
      const run = prev.then(() => fn());
      tails.set(name, run.catch(() => undefined));
      return run;
    },
  };
}
function fakeStorage() {
  const m = new Map<string, string>();
  return { getItem: (k: string) => m.get(k) ?? null, setItem: (k: string, v: string) => void m.set(k, v), removeItem: (k: string) => void m.delete(k), map: m };
}
function browser(o: { locks?: boolean; storage?: boolean } = {}) {
  const store = fakeStorage();
  Object.defineProperty(globalThis, "navigator", { value: o.locks === false ? {} : { locks: fakeLocks() }, configurable: true, writable: true });
  Object.defineProperty(globalThis, "window", { value: o.storage === false ? {} : { localStorage: store }, configurable: true, writable: true });
  return store;
}
type Status = { err: unknown; confirmationStatus: string } | null;
function chain(o: { status?: Status[]; height?: number; valid?: boolean; throws?: boolean }) {
  const statuses = [...(o.status ?? [null])];
  return {
    getSignatureStatuses: async () => { if (o.throws) throw new Error("rpc down"); return { value: [statuses.length > 1 ? statuses.shift()! : statuses[0]] }; },
    getBlockHeight: async () => o.height ?? 0,
    isBlockhashValid: async () => ({ value: o.valid ?? true }),
  } as any;
}
const M = "Mint1111111111111111111111111111111111111111", C = "Claim111";
const signed = { signature: "Sig1", blockhash: "Hash1", lastValidBlockHeight: 100 };

describe("make-up reservation", () => {
  it("two tabs at once: exactly one reserves, before either reads anything", async () => {
    browser();
    const [a, b] = await Promise.all([reserve(M, C, "tab-a"), reserve(M, C, "tab-b")]);
    expect([a, b].filter((x) => x === null).length).eq(1);
    expect((a ?? b)!.id).eq("tab-a");
  });
  it("never expires with time: an unsigned reservation stays held however old it is", async () => {
    browser();
    await reserve(M, C, "tab-a");
    const realNow = Date.now;
    Date.now = () => realNow() + 10 * 24 * 3600_000;
    try {
      expect((await reserve(M, C, "tab-b"))?.id).eq("tab-a");
      expect((await settle(chain({}), M, C)).kind).eq("reserved");
    } finally { Date.now = realNow; }
  });
  it("a page whose reservation was released, or taken by another page, stops before signing and before sending", async () => {
    browser();
    await reserve(M, C, "tab-a");
    expect(await releaseUnsigned(M, C, "tab-b")).eq(false); // only the same reservation
    expect(await releaseUnsigned(M, C, "tab-a")).eq(true); // the owner's manual release
    expect(await reserve(M, C, "tab-b")).eq(null);
    let err = "";
    await stillReserved(M, C, "tab-a").catch((e) => { err = e.message; });
    expect(err).match(/released or taken elsewhere/);
    err = "";
    await recordSigned(M, C, "tab-a", signed).catch((e) => { err = e.message; });
    expect(err).match(/nothing was sent/);
    await stillReserved(M, C, "tab-b");
    await recordSigned(M, C, "tab-b", signed);
    // once signed it cannot be released by hand, and nobody else can sign under it
    expect(await releaseUnsigned(M, C, "tab-b")).eq(false);
    err = "";
    await recordSigned(M, C, "tab-b", { ...signed, signature: "Sig2" }).catch((e) => { err = e.message; });
    expect(err).match(/nothing was sent/);
  });
  it("a signed one is settled from the chain only: landed stays, failed or expired-unseen is released, otherwise pending", async () => {
    const cases: [Parameters<typeof chain>[0], string, boolean][] = [
      [{ status: [{ err: null, confirmationStatus: "confirmed" }] }, "landed", true],
      [{ status: [{ err: null, confirmationStatus: "finalized" }] }, "landed", true],
      [{ status: [{ err: { InstructionError: [1, 1] }, confirmationStatus: "confirmed" }] }, "none", false],
      [{ status: [{ err: null, confirmationStatus: "processed" }] }, "pending", true],
      // a failure seen only at processed can be rolled back: held, even with the blockhash expired
      [{ status: [{ err: { InstructionError: [1, 1] }, confirmationStatus: "processed" }], height: 99 }, "pending", true],
      [{ status: [{ err: { InstructionError: [1, 1] }, confirmationStatus: "processed" }], height: 101 }, "pending", true],
      [{ status: [{ err: { InstructionError: [1, 1] } } as any] }, "pending", true], // no confirmation level given
      [{ status: [{ err: { InstructionError: [1, 1] }, confirmationStatus: "finalized" }] }, "none", false],
      [{ status: [null], height: 100 }, "pending", true], // blockhash still valid (height == last valid)
      [{ status: [null], height: 101 }, "none", false], // expired and never seen: can never land
      [{ status: [null, { err: null, confirmationStatus: "confirmed" }], height: 101 }, "landed", true], // seen on the last look
      [{ throws: true }, "unknown", true],
    ];
    for (const [c, kind, kept] of cases) {
      const store = browser();
      await reserve(M, C, "tab-a"); await recordSigned(M, C, "tab-a", signed);
      expect((await settle(chain(c), M, C)).kind, JSON.stringify(c)).eq(kind);
      expect(store.map.size === 1, JSON.stringify(c)).eq(kept);
      if (kept) expect(await reserve(M, C, "tab-b"), JSON.stringify(c)).not.eq(null);
    }
    // a wallet-replaced blockhash (no last valid height): validity is asked for that blockhash
    for (const [valid, kind] of [[true, "pending"], [false, "none"]] as const) {
      browser();
      await reserve(M, C, "tab-a"); await recordSigned(M, C, "tab-a", { ...signed, lastValidBlockHeight: null });
      expect((await settle(chain({ status: [null], valid }), M, C)).kind).eq(kind);
    }
  });
  it("a processed failure holds the claim until a confirmed outcome settles it, either way", async () => {
    const failed = { err: { InstructionError: [1, 1] }, confirmationStatus: "processed" };
    for (const [later, kind] of [[{ err: null, confirmationStatus: "confirmed" }, "landed"], [{ err: { InstructionError: [1, 1] }, confirmationStatus: "confirmed" }, "none"]] as const) {
      browser();
      await reserve(M, C, "tab-a"); await recordSigned(M, C, "tab-a", signed);
      expect((await settle(chain({ status: [failed], height: 101 }), M, C)).kind).eq("pending");
      expect((await reserve(M, C, "tab-b"))?.id).eq("tab-a"); // a second page is still blocked
      expect((await settle(chain({ status: [later] }), M, C)).kind).eq(kind);
      expect((await reserve(M, C, "tab-b")) === null).eq(kind === "none");
    }
  });
  it("no Web Locks or no storage: nothing is reserved, so nothing is sent; unreadable data counts as held", async () => {
    browser({ locks: false });
    let err = "";
    await reserve(M, C, "a").catch((e) => { err = e.message; });
    expect(err).match(/no Web Locks/);
    browser({ storage: false });
    err = "";
    await reserve(M, C, "a").catch((e) => { err = e.message; });
    expect(err).match(/no local storage/);
    const store = browser();
    store.setItem(`cometail:tail-makeup:${M}:${C}`, "{not json");
    expect((await reserve(M, C, "a"))?.id).eq("unreadable");
    expect(await releaseUnsigned(M, C, "unreadable")).eq(true); // the owner can still clear it by hand
  });
});
