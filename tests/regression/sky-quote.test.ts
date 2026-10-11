// All tokens values a coin paired with $COMETAIL as its token page does (web/src/lib/quotes.ts rowQuote): the row's
// $COMETAIL rate from /api/sky gives dollars and SOL; every other quote keeps Money's own SOL/USD rate.
import { expect } from "chai";
import "./mainnet-quote-env"; // evaluated first: quotes.ts reads the cluster and $COMETAIL's mint when it loads
import { rowQuote } from "../../web/src/lib/quotes";

const COMETAIL = "z4Zr7wNGDYbmqsgW9hYHxSgtUFWxKsbwjRThzrdUkit", WSOL = "So11111111111111111111111111111111111111112";
describe("All tokens: a paired coin's fees in dollars", () => {
  const q = { rowQuote };
  it("a $COMETAIL row carries its own rate: dollars and SOL per $COMETAIL", () => {
    const now = Date.now();
    const r = q.rowQuote(COMETAIL, { value: 0.0000111, source: "cometail-pool x sol-reference", status: "fresh", sol: 1.01e-7, solSource: "cometail-pool" }, now);
    expect(r.quote.paired).eq(true);
    expect(r.quote.sol).eq(1.01e-7);
    expect(r.quoteRate).deep.include({ value: 0.0000111, status: "fresh" });
  });
  it("without a rate (an older API, or no fresh price) the row says the dollar value is unknown, as before", () => {
    expect(q.rowQuote(COMETAIL, undefined, null).quoteRate?.status).eq("missing");
    expect(q.rowQuote(COMETAIL, { value: null, source: null, status: "missing", sol: null }, Date.now()).quoteRate?.status).eq("missing");
    expect(q.rowQuote(COMETAIL, { value: 0.0000111, source: "x", status: "fresh", sol: 1e-7 }, Date.now() - 3_600_000).quoteRate?.status, "an old reading").eq("stale");
  });
  it("a SOL row keeps Money's own rate", () => {
    const r = q.rowQuote(WSOL, { value: 109, source: "sol-reference", status: "fresh", sol: 1 }, Date.now());
    expect(r.quote.symbol).eq("SOL");
    expect(r.quoteRate).eq(undefined);
  });
});
