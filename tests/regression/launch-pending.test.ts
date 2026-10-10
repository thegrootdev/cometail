// The paired launch's first-buy purchase (web/src/lib/launch-pending.ts): kept for a retry only with the same wallet,
// config and SOL amount; a kept purchase leaves only the launch costs to pay in SOL; a purchase sent but not confirmed
// is settled from the chain (its signature's status, its blockhash's expiry), never from a balance read.
import { expect } from "chai";
import { launchSolNeed, pendingFirstBuy, settleFirstBuy } from "../../web/src/lib/launch-pending";

const sent = { signature: "Sig1", blockhash: "Hash1", lastValidBlockHeight: 100 };
describe("paired launch: the first buy's $COMETAIL across a retry", () => {
  const bought = { owner: "W1", config: "C1", solRaw: "1000000000", cometail: 7n, ...sent, settled: true };
  it("is kept only for the same wallet, config and amount", () => {
    expect(pendingFirstBuy(bought, "W1", "C1", 1_000_000_000n)).eq(bought);
    expect(pendingFirstBuy(bought, "W2", "C1", 1_000_000_000n), "another wallet").eq(null);
    expect(pendingFirstBuy(bought, "W1", "C2", 1_000_000_000n), "another config").eq(null);
    expect(pendingFirstBuy(bought, "W1", "C1", 500_000_000n), "another amount").eq(null);
    expect(pendingFirstBuy(bought, "W1", "C1", null), "an invalid amount").eq(null);
    expect(pendingFirstBuy(bought, null, "C1", 1_000_000_000n), "no wallet").eq(null);
    expect(pendingFirstBuy(null, "W1", "C1", 1_000_000_000n)).eq(null);
  });
  it("a retry with the purchase kept needs only the launch costs in SOL", () => {
    const overhead = 35_000_000n;
    // the partner's fixture: 0.05 SOL in the wallet, 1 SOL first buy already bought
    expect(launchSolNeed(true, 1_000_000_000n, true, overhead)).eq(overhead);
    expect(launchSolNeed(true, 1_000_000_000n, true, overhead) <= 50_000_000n).eq(true);
    expect(launchSolNeed(true, 1_000_000_000n, false, overhead)).eq(1_035_000_000n);
    expect(launchSolNeed(false, 1_000_000_000n, false, overhead), "a quote-token first buy is paid in that token").eq(overhead);
  });
});

type Status = { err: unknown; confirmationStatus?: string } | null;
function chain(o: { status?: Status[]; height?: number; valid?: boolean; throws?: boolean }) {
  const statuses = [...(o.status ?? [null])];
  return {
    getSignatureStatuses: async () => { if (o.throws) throw new Error("rpc down"); return { value: [statuses.length > 1 ? statuses.shift()! : statuses[0]] }; },
    getBlockHeight: async () => o.height ?? 0,
    isBlockhashValid: async () => ({ value: o.valid ?? true }),
  } as any;
}
describe("paired launch: an unconfirmed step 1 is settled from the chain", () => {
  it("landed only when confirmed or finalized without error; none when it failed confirmed or expired unseen; otherwise held", async () => {
    const fail = { InstructionError: [2, { Custom: 6002 }] };
    const cases: [Parameters<typeof chain>[0], string][] = [
      [{ status: [{ err: null, confirmationStatus: "confirmed" }] }, "landed"],
      [{ status: [{ err: null, confirmationStatus: "finalized" }] }, "landed"],
      [{ status: [{ err: fail, confirmationStatus: "confirmed" }] }, "none"],
      [{ status: [{ err: fail, confirmationStatus: "finalized" }] }, "none"],
      // seen only at processed, success or failure: it can still change, so nothing is bought again
      [{ status: [{ err: null, confirmationStatus: "processed" }], height: 101 }, "pending"],
      [{ status: [{ err: fail, confirmationStatus: "processed" }], height: 101 }, "pending"],
      [{ status: [{ err: null }] }, "pending"], // no confirmation level given
      // not seen: held while its blockhash is valid (height == last valid), released once it can never land
      [{ status: [null], height: 100 }, "pending"],
      [{ status: [null], height: 101 }, "none"],
      [{ status: [null, { err: null, confirmationStatus: "confirmed" }], height: 101 }, "landed"], // seen on the last look
      [{ status: [null, { err: null, confirmationStatus: "processed" }], height: 101 }, "pending"],
      [{ throws: true }, "unknown"],
    ];
    for (const [c, kind] of cases) expect(await settleFirstBuy(chain(c), sent), JSON.stringify(c)).eq(kind);
    // a wallet-replaced blockhash (no last valid height): validity is asked for that blockhash
    expect(await settleFirstBuy(chain({ status: [null], valid: true }), { ...sent, lastValidBlockHeight: null })).eq("pending");
    expect(await settleFirstBuy(chain({ status: [null], valid: false }), { ...sent, lastValidBlockHeight: null })).eq("none");
  });
});
