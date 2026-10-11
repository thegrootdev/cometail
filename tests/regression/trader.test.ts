// Who a trade is credited to (worker/src/indexer.ts decodeTrades): the swap's own signer when that is a wallet; when a
// program signs the swap for itself (its address is off the curve, so it cannot be a wallet: a bot or router program),
// the fee payer, the wallet that signed the transaction, marked as such. Rows stored before that rule are repaired
// from their transactions. Fixtures: three mainnet transactions on $BABY's curve (8yAL…59yr), raw JSON encoding.
import { expect } from "chai";
import fs from "fs";
import path from "path";
import { PublicKey } from "@solana/web3.js";
import { openStore, type TradeRow } from "../../worker/src/store";

const FIX = path.join(__dirname, "..", "fixtures", "transactions");
const POOL = new PublicKey("8yALCTQLqAFe9fo8yNWDVEwSoXzCiDv1kMTHuwq659yr");
const ROUTED = "jtSS1dRBn2AJAU47ymGq8CjYXoscbqGW2Ujfs6W2iTm1LTjbER7BZLpxBRdK46wSM1Rmcm9wRHNuHpAVXrvXQav"; // a bot program's buy
const LAUNCH = "bM2P5orWoxJPyzQUcg9xy36ETtcjunLM6TRvYdz7n2JoJweEH499v2wGYKyrhdxQ4CT1Ths4Fo4G1kjeDFB5mnd"; // the creator's launch and first buy
const ROUTE = "5Z2QMnhrGWYHLwZb4wYQDff8D9JokY1iGdLpnaNgo6sJgjqAvnaeY2j92UkpUpyeZgwC7YN9TrvzLRXdHMgRgpVb"; // an aggregator route, two signers
const BOT_PROGRAM_ACCOUNT = "9PQNbkKHFCwcZVB8h48SRPEmKZgKUz28dyCMJfMedSJ7", BOT_WALLET = "7dRfmLkQKpDyuTGbBfyqj724VbVRUEhjUhWquzbTYSGS";
const CREATOR = "DRoJFenArgWxhxo5MxS4jNvK2T74fZGQssF6LY7PeaaZ";

// a connection whose transactions come from the fixtures through the raw-RPC path (the node reports version 1)
function fixtureConnection() {
  const real = globalThis.fetch;
  globalThis.fetch = (async (_u: unknown, init: { body: string }) => {
    const sig = JSON.parse(init.body).params[0];
    const file = path.join(FIX, `${sig}.json`);
    const result = fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, "utf8")) : null;
    return { ok: true, status: 200, json: async () => ({ jsonrpc: "2.0", id: 1, result }) };
  }) as any;
  const conn = { rpcEndpoint: "http://fixtures.invalid", getTransaction: async () => { throw new Error("Transaction version (1) is not supported by the requesting client"); } } as any;
  return { conn, restore: () => { globalThis.fetch = real; } };
}

describe("trades credited to the wallet that signed", () => {
  let fx: ReturnType<typeof fixtureConnection>;
  beforeEach(() => { fx = fixtureConnection(); });
  afterEach(() => fx.restore());
  const decode = async (sig: string) => {
    const { Chain } = await import("../../worker/src/chain");
    const { decodeTrades, readTx } = await import("../../worker/src/indexer");
    const chain = new Chain(fx.conn);
    const tx = (await readTx(fx.conn, sig))!;
    return decodeTrades(chain, tx, POOL, { signature: sig, slot: tx.slot, blockTime: tx.blockTime ?? null, vault: "", venue: "curve", baseDecimals: 6, quoteMint: "z4Zr7wNGDYbmqsgW9hYHxSgtUFWxKsbwjRThzrdUkit", quoteDecimals: 6 });
  };

  it("a swap a program signs for itself is the fee payer's, marked as such, with its amounts unchanged", async () => {
    expect(PublicKey.isOnCurve(new PublicKey(BOT_PROGRAM_ACCOUNT).toBytes())).eq(false);
    const rows = await decode(ROUTED);
    expect(rows.length).eq(1);
    expect(rows[0].trader).eq(BOT_WALLET);
    expect(rows[0].traderKind).eq("feePayer");
    expect(rows[0].buy).eq(true);
    expect(rows[0].quoteAmountLamports).eq("9391075388807");
    expect(rows[0].baseAmountRaw).eq("92540307929690");
  });
  it("a wallet's own swap stays the wallet's, as the swap's signer", async () => {
    const launch = await decode(LAUNCH);
    expect(launch.map((r) => [r.trader, r.traderKind, r.baseAmountRaw])).deep.eq([[CREATOR, "authority", "115880960693977"]]);
    const route = await decode(ROUTE);
    expect(route.length).eq(1);
    expect(route[0].traderKind).eq("authority");
    expect(PublicKey.isOnCurve(new PublicKey(route[0].trader).toBytes())).eq(true);
  });
  it("stored rows of a program-signed swap are repaired from their transaction, once; wallets' rows are untouched", async () => {
    const { Chain } = await import("../../worker/src/chain");
    const { Indexer } = await import("../../worker/src/indexer");
    const store = openStore("sqlite::memory:"); await store.init();
    const row = (signature: string, trader: string, idx = 1): TradeRow => ({ signature, idx, slot: 1, blockTime: 1, pool: POOL.toBase58(), vault: "", trader, traderKind: "authority", buy: true, amountIn: "1", amountOut: "1", venue: "curve", baseAmountRaw: "1", quoteAmountLamports: "1", executionPriceSol: null });
    await store.insertTrades([row(ROUTED, BOT_PROGRAM_ACCOUNT), row(LAUNCH, CREATOR)]);
    const indexer: any = new Indexer(new Chain(fx.conn), store);
    expect(await indexer.repairRoutedTraders()).eq(true);
    const all = await store.listTradesByPools([POOL.toBase58()], 10);
    const by = (s: string) => all.find((t) => t.signature === s)!;
    expect([by(ROUTED).trader, by(ROUTED).traderKind]).deep.eq([BOT_WALLET, "feePayer"]);
    expect([by(LAUNCH).trader, by(LAUNCH).traderKind]).deep.eq([CREATOR, "authority"]);
    expect(await store.listAuthorityTraders()).deep.eq([CREATOR]);
    expect(await indexer.repairRoutedTraders(), "nothing left: a second run changes nothing").eq(true);
    // the repair reads at most perPass transactions per pass and finishes on a later one
    await store.insertTrades([row(ROUTED, BOT_PROGRAM_ACCOUNT, 7), row(LAUNCH, BOT_PROGRAM_ACCOUNT, 8)]);
    expect(await indexer.repairRoutedTraders(1), "two transactions to read, one per pass").eq(false);
    expect(await indexer.repairRoutedTraders(1), "the second, and nothing left").eq(true);
    expect(await store.listAuthorityTraders()).deep.eq([CREATOR]);
    // a transaction the node does not return is left as it was (logged), and never retried pass after pass
    await store.insertTrades([row("missing", BOT_PROGRAM_ACCOUNT)]);
    expect(await indexer.repairRoutedTraders()).eq(true);
    expect((await store.listTradesByPools([POOL.toBase58()], 10)).find((t) => t.signature === "missing")!.trader).eq(BOT_PROGRAM_ACCOUNT);
    await store.close();
  });
});
