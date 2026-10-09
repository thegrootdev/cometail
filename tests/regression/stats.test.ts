// The public proof figures (worker/src/stats.ts, /api/stats): launches are attributed by their owner (a vault-held
// launch by its depositor; without a vault only a wallet-held creator is an owner), volume is summed from the indexed
// trades only once every pool of the launch has a finished cursor and every trade has its quote leg, and a pool
// account that cannot be read leaves its fees unknown, never zero.
import { Keypair } from "@solana/web3.js";
import { expect } from "chai";
import fs from "fs";
import os from "os";
import path from "path";
import { openStore, type TokenRow, type TradeRow } from "../../worker/src/store";
import { statsViewer } from "../../worker/src/stats";

const WSOL = "So11111111111111111111111111111111111111112";
const key = () => Keypair.generate().publicKey.toBase58();
async function freshStore() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "stats-"));
  const store = openStore(`sqlite:${path.join(dir, "store.sqlite")}`); await store.init();
  return store;
}
function token(o: Partial<TokenRow>): TokenRow {
  return { mint: key(), decimals: 6, name: "x", symbol: "X", imageUrl: null, metadataUri: null, metadataStatus: "ok", creator: key(), custody: "wallet" as any, config: key(),
    tokenKind: "plain", dbcPool: key(), dammPool: null, quoteMint: WSOL, vault: null, stage: "bonding", priceQuote: null, priceSol: null, quoteDecimals: 9, priceSource: null,
    priceAtMs: 0, totalSupplyRaw: "1000000000000000", quoteRaisedLamports: "0", targetLamports: "0", progressBps: null, holders: null, holdersAtMs: null, liquidityLamports: null,
    liquidityBasis: null, links: null, volume24hLamports: "0", buys24h: 0, sells24h: 0, volumeComplete: true, createdAtMs: 0, updatedAt: 0, ...o };
}
let sig = 0;
function trade(pool: string, trader: string, quote: string | undefined, venue: "curve" | "damm" = "curve"): TradeRow {
  sig++;
  return { signature: `sig${sig}`, idx: 0, slot: sig, blockTime: sig, pool, vault: "", trader, traderKind: "authority", buy: sig % 2 === 0, amountIn: "1", amountOut: "1", venue, baseAmountRaw: "1", quoteAmountLamports: quote };
}
// a chain whose pool accounts are all missing: the fee counters cannot be read
const blindChain = { connection: { getMultipleAccountsInfoAndContext: async (keys: unknown[]) => ({ context: { slot: 7 }, value: keys.map(() => null) }) }, damm: { programId: Keypair.generate().publicKey }, dbc: {} } as any;

describe("public proof figures", () => {
  it("attributes launches by owner, a vault-held launch by its depositor", async () => {
    const store = await freshStore();
    const me = key(), vault = key();
    const ours = token({ creator: me, stage: "graduated" });
    const held = token({ creator: vault, vault, custody: "program" as any, tokenKind: "stream" });
    const theirs = token({});
    const orphan = token({ creator: key(), vault: key(), custody: "program" as any }); // its vault is not indexed: owner unknown
    orphan.creator = orphan.vault!;
    const pda = token({ custody: "program" as any }); // a program-held creator with no vault: not a proven outside owner
    const unknown = token({ custody: "unknown" as any });
    await store.upsertTokens([ours, held, theirs, orphan, pda, unknown]);
    await store.upsertVault(vault, { depositor: me, status: { launched: {} }, accounting: { harvestedGross: "5" } });
    await store.setMeta("tokens_scanned_at", "1000");
    const v: any = await statsViewer(blindChain, store, { cluster: "test", team: [me], feeIndex: null, burnView: null, tailView: null })();
    expect(v.launches).to.include({ total: 6, team: 2, outside: 1, unattributed: 3 });
    expect(v.launches.graduated).to.deep.eq({ total: 1, team: 1, outside: 0 });
    expect(v.vaults).to.include({ total: 1, launched: 1 });
    // no pool account could be read: every fee figure is unknown
    expect(v.fees).to.include({ curveTradingLamports: null, totalLamports: null, meteoraProtocolLamports: null });
    expect(v.burn).to.eq(null);
  });

  it("sums volume and traders only while the index is complete and every trade has its quote leg", async () => {
    const store = await freshStore();
    const a = token({}), b = token({ dammPool: key(), stage: "graduated" });
    await store.upsertTokens([a, b]);
    const w1 = key(), w2 = key();
    await store.insertTrades([trade(a.dbcPool, w1, "100"), trade(a.dbcPool, w2, "50"), trade(b.dbcPool, w1, "7"), trade(b.dammPool!, w2, "3", "damm")]);
    await store.setMeta("tokens_scanned_at", "1000");
    const opts = { cluster: "test", team: [], feeIndex: null, burnView: null, tailView: null };
    const ok = { head: "h", tail: null, target: null, newHead: null, status: "ok" as const };

    // just discovered: the indexer has not reached these pools, so there is no cursor yet: nothing is proven
    let v: any = await statsViewer(blindChain, store, opts)();
    expect(v.trading).to.include({ complete: false, pendingPools: 3, volumeLamports: null, traders: null });
    expect(v.launches.list.every((l: any) => l.volumeLamports === null)).to.eq(true);

    // the curves are caught up, the graduated pool not yet: only that launch stays unknown
    await store.setPoolCursor(a.dbcPool, ok); await store.setPoolCursor(b.dbcPool, ok);
    v = await statsViewer(blindChain, store, opts)();
    expect(v.trading).to.include({ complete: false, pendingPools: 1, volumeLamports: null });
    expect(v.launches.list.find((l: any) => l.mint === a.mint).volumeLamports).to.eq("150");
    expect(v.launches.list.find((l: any) => l.mint === b.mint).volumeLamports).to.eq(null);

    await store.setPoolCursor(b.dammPool!, ok);
    v = await statsViewer(blindChain, store, opts)();
    expect(v.trading).to.include({ complete: true, trades: 4, traders: 2, volumeLamports: "160" });
    expect(v.launches.list.find((l: any) => l.mint === b.mint).volumeByVenue).to.deep.eq({ curve: "7", damm: "3" });

    // a trade without its quote leg makes that launch's volume, and the total, unknown
    await store.insertTrades([trade(a.dbcPool, w1, undefined)]);
    v = await statsViewer(blindChain, store, opts)();
    expect(v.launches.list.find((l: any) => l.mint === a.mint).volumeLamports).to.eq(null);
    expect(v.trading.volumeLamports).to.eq(null);

    // a pool still catching up: no volume and no trader count at all
    await store.setPoolCursor(a.dbcPool, { ...ok, status: "pending" });
    v = await statsViewer(blindChain, store, opts)();
    expect(v.trading).to.include({ complete: false, pendingPools: 1, volumeLamports: null, traders: null });
  });
});
