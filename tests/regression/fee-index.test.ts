// The Fee Index reads DBC accounts by byte offset (a 296-byte pool slice and a 360-byte config slice)
// to walk every launchpad's pools cheaply. These checks hold the offsets against the live program's
// own accounts, made on the SVM, with fees accrued by a real swap; and the feed's type filter
// against a real store: a filtered replay returns only the asked types and keeps paging.
import { BN } from "@coral-xyz/anchor";
import { Keypair } from "@solana/web3.js";
import { NATIVE_MINT } from "@solana/spl-token";
import { expect } from "chai";
import { startSvm, fund } from "../harness/svm";
import { send } from "../harness/tx";
import { ensureAta, wrapSol } from "../harness/tokens";
import * as dbc from "../harness/dbc";
import { decodePoolSlice, decodeConfigSlice, POOL_SLICE, CONFIG_SLICE, creatorShare, stageOf } from "../../worker/src/feeindex";
import { parseTypes, replay } from "../../worker/src/feed";
import { openStore } from "../../worker/src/store";

describe("fee index: byte offsets against the live DBC program", () => {
  it("decodes a pool and its config from their slices exactly as the program laid them out", async () => {
    const owner = Keypair.generate();
    const svm = startSvm({ upgradeAuthority: owner.publicKey });
    const otherPartner = fund(svm), creator = fund(svm), buyer = fund(svm);
    const config = await dbc.createConfig(svm, { payer: otherPartner, feeClaimer: otherPartner.publicKey, leftoverReceiver: otherPartner.publicKey, quoteMint: NATIVE_MINT, params: dbc.configParams("plain") });
    const mint = Keypair.generate();
    const p = await dbc.createPoolIx({ config, baseMint: mint.publicKey, quoteMint: NATIVE_MINT, creator: creator.publicKey, payer: creator.publicKey });
    send(svm, [p.ix], [creator, mint], { cu: 600_000 });
    const cfg = dbc.getConfig(svm, config);
    const quote = wrapSol(svm, buyer, cfg.migrationQuoteThreshold.muln(2));
    const base = ensureAta(svm, buyer, mint.publicKey, buyer.publicKey);
    await dbc.buy(svm, buyer, p.pool, quote, base, cfg.migrationQuoteThreshold.divn(3));
    const state = dbc.getPool(svm, p.pool);

    const rawPool = Buffer.from(svm.getAccount(p.pool)!.data);
    const got = decodePoolSlice(p.pool.toBase58(), rawPool.subarray(POOL_SLICE.offset, POOL_SLICE.offset + POOL_SLICE.length));
    expect(got.config).eq(config.toBase58());
    expect(got.creator).eq(creator.publicKey.toBase58());
    expect(got.mint).eq(mint.publicKey.toBase58());
    expect(got.progress).eq(Number(state.migrationProgress));
    expect(got.quoteReserve.toString()).eq(state.quoteReserve.toString());
    expect(got.ttq.toString()).eq(state.metrics.totalTradingQuoteFee.toString());
    expect(got.ttq > 0n).true;
    expect(got.creatorFee.toString()).eq(state.creatorQuoteFee.toString());
    expect(got.partnerFee.toString()).eq(state.partnerQuoteFee.toString());
    expect(got.activation.toString()).eq(state.activationPoint.toString());
    expect(stageOf(got.progress)).eq("bonding");

    const rawCfg = Buffer.from(svm.getAccount(config)!.data);
    const c = decodeConfigSlice(config.toBase58(), rawCfg.subarray(CONFIG_SLICE.offset, CONFIG_SLICE.offset + CONFIG_SLICE.length));
    expect(c.quoteMint).eq(NATIVE_MINT.toBase58());
    expect(c.feeClaimer).eq(otherPartner.publicKey.toBase58());
    expect(c.creatorPct).eq(Number(cfg.creatorTradingFeePercentage));
    expect(c.activationType).eq(Number(cfg.activationType));
    expect(c.threshold.toString()).eq(cfg.migrationQuoteThreshold.toString());
    expect(c.creatorLocked).eq(Number(cfg.creatorPermanentLockedLiquidityPercentage));
    expect(c.partnerLocked).eq(Number(cfg.partnerPermanentLockedLiquidityPercentage));
    // the plain preset satisfies the program's deposit rules for creator rights
    expect(c.reasons).deep.eq([]);
    // the creator's lifetime share is the counter times the config's creator percentage
    expect(creatorShare(got.ttq, c.creatorPct).toString()).eq(new BN(state.metrics.totalTradingQuoteFee.toString()).muln(c.creatorPct).divn(100).toString());
  });
});

describe("feed: the type filter", () => {
  it("parses types, expands fees, refuses unknown names", () => {
    expect(parseTypes(null)).eq(null);
    expect(parseTypes("")).eq(null);
    expect([...(parseTypes("fees") as Set<string>)].sort()).deep.eq(["bid", "claim", "fill", "harvest"]);
    expect([...(parseTypes("trade,claim") as Set<string>)].sort()).deep.eq(["claim", "trade"]);
    expect(parseTypes("trade,bogus")).eq("invalid");
  });
  it("a filtered replay returns only the asked types and pages over the rows it skipped", async () => {
    const store = openStore("sqlite::memory:");
    await store.init();
    const row = (i: number, type: string) => ({ slot: 100 + i, ordinal: 0, signature: `sig${i}`, type, vault: null, mint: null, data: { signature: `sig${i}`, pool: "P", role: "creator", quoteAmountLamports: "1", baseAmountRaw: "0" }, provenance: { source: "chain" }, at: Date.now() });
    await store.appendFeed([row(1, "trade"), row(2, "claim"), row(3, "trade"), row(4, "trade"), row(5, "harvest"), row(6, "trade")]);
    const fees = parseTypes("fees") as Set<string>;
    const p1 = await replay(store, "devnet", null, 2, fees);
    expect(p1.status).eq(200);
    expect(p1.body.events.map((e: any) => e.type)).deep.eq(["claim"]);
    expect(p1.body.nextCursor).not.null;
    const seen: string[] = [...p1.body.events.map((e: any) => e.type)];
    let next = p1.body.nextCursor;
    for (let i = 0; i < 5 && next; i++) {
      const [seq, slot, signature] = next.split(":");
      const p = await replay(store, "devnet", { seq: Number(seq), slot: Number(slot), signature }, 2, fees);
      seen.push(...p.body.events.map((e: any) => e.type)); next = p.body.nextCursor;
    }
    expect(seen).deep.eq(["claim", "harvest"]);
    await store.close();
  });
});
