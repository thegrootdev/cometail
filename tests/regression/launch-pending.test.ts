// The paired launch's first-buy purchase (web/src/lib/launch-pending.ts): kept for a retry only with the same wallet,
// config and SOL amount; a kept purchase leaves only the launch costs to pay in SOL.
import { expect } from "chai";
import { launchSolNeed, pendingFirstBuy } from "../../web/src/lib/launch-pending";

describe("paired launch: the first buy's $COMETAIL across a retry (F3)", () => {
  const bought = { owner: "W1", config: "C1", solRaw: "1000000000", cometail: 7n };
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
