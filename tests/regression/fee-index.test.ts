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

// ---- the review's findings, reproduced against the actual module ----
import { FeeIndex, claimTolerance, type IndexPool } from "../../worker/src/feeindex";
import { tailsRollup } from "../../worker/src/api";

const HOUR = 3_600_000, DAY = 86_400_000;
const P = (pool: string, ttq: bigint, creatorFee: bigint, partnerFee: bigint, activation = 0n): IndexPool => ({ pool, config: "CFG", creator: "C", mint: `M${pool}`, progress: 0, ttq, creatorFee, partnerFee, quoteReserve: 0n, activation, finishTs: 0 });
async function index(conn: any = {}, pct = 100) {
  const store = openStore("sqlite::memory:"); await store.init();
  const fi = new FeeIndex({ connection: conn } as any, store, ":memory:", { fullEveryHours: 24, deltaEveryMinutes: 5, pageDelayMs: 0, claimLookupsPerPass: 10, namesPerPass: 0, ourConfigs: [] });
  await fi.open();
  fi.rememberConfig({ config: "CFG", quoteMint: NATIVE_MINT.toBase58(), feeClaimer: "L", creatorPct: pct, activationType: 1, partnerLocked: 20, creatorLocked: 80, threshold: 2n ** 64n - 1n, reasons: [] });
  return { fi, store };
}

describe("fee index: claims, windows, ranking (review 120)", () => {
  it("a claim landing after the scan started is inside the window; an unreadable transaction stays pending, then unconfirmed", async () => {
    const conn = { getSignaturesForAddress: async () => [{ signature: "s116", slot: 116, err: null }, { signature: "s111", slot: 111, err: null }, { signature: "s99", slot: 99, err: null }], getTransaction: async () => null, rpcEndpoint: "http://x" };
    const { fi } = await index(conn);
    const A = Keypair.generate().publicKey.toBase58();
    fi.applyPools([P(A, 1000n, 1000n, 0n)], 100, Date.now(), 50);
    fi.applyPools([P(A, 1000n, 0n, 0n)], 110, Date.now(), 100); // scan started at 110, the claim landed at 111
    fi.closeClaimWindows(115);
    const w = await fi.windowSignatures(A, 100, 115);
    expect(w.sigs.map((s) => s.slot)).deep.eq([111]);
    expect(w.complete).eq(true);
    await fi.resolveClaims();
    let row = fi.db.db.prepare("select status, attempts from fi_claims").get();
    expect(String(row.status)).eq("pending"); expect(Number(row.attempts)).eq(1);
    for (let i = 0; i < 6; i++) await fi.resolveClaims();
    row = fi.db.db.prepare("select status, note from fi_claims").get();
    expect(String(row.status)).eq("unconfirmed"); expect(String(row.note)).match(/never became available/);
  });
  it("a claim masked by new trading is still a candidate; rounding is not", async () => {
    const { fi } = await index({}, 75);
    fi.applyPools([P("A", 1_000_000n, 100_000n, 0n)], 100, Date.now(), 50);
    // the counter grew 400,000: the creator should have gained 300,000 and the partner 100,000
    fi.applyPools([P("A", 1_400_000n, 200_000n, 100_000n)], 110, Date.now(), 100); // a 200,000 creator claim hidden by the accrual
    fi.applyPools([P("B", 1_000_000n, 100_000n, 0n)], 100, Date.now(), 50);
    fi.applyPools([P("B", 1_400_000n, 399_999n, 99_999n)], 110, Date.now(), 100); // a lamport short each: rounding
    const rows = fi.db.db.prepare("select pool, role, shortfall from fi_claims order by pool, role").all().map((r: any) => `${r.pool}:${r.role}:${r.shortfall}`);
    expect(rows).deep.eq(["A:creator:200000"]);
    expect(claimTolerance(300_000n) > 1n).true;
    expect(claimTolerance(0n)).eq(0n); // no trading in between: a one-lamport fall is a claim
  });
  it("24 h is the last 24 hours, not the newest snapshot a day old (100 at h0, +100 at h0.5, full walk at h24, +1 at h47)", async () => {
    const { fi } = await index();
    const h0 = Math.floor(Date.now() / HOUR) * HOUR - 48 * HOUR;
    fi.applyPools([P("A", 100n, 100n, 0n)], 1, h0, 0);
    fi.applyPools([P("A", 200n, 200n, 0n)], 2, h0 + HOUR / 2, 0);
    fi.applyPools([P("A", 200n, 200n, 0n)], 3, h0 + 24 * HOUR, 0);
    fi.applyPools([P("A", 201n, 201n, 0n)], 4, h0 + 47 * HOUR, 0);
    fi.refreshDayIncome(h0 + 47 * HOUR);
    const r = fi.db.db.prepare("select day_income, day_hours from fi_pools where pool = 'A'").get();
    expect(String(r.day_income)).eq("1"); expect(Number(r.day_hours)).eq(24);
    // a coin first seen this hour has no window yet
    fi.applyPools([P("N", 50n, 50n, 0n)], 5, h0 + 47 * HOUR, 0);
    fi.refreshDayIncome(h0 + 47 * HOUR);
    const n = fi.db.db.prepare("select day_income, day_hours from fi_pools where pool = 'N'").get();
    expect(String(n.day_income)).eq("0"); expect(Number(n.day_hours)).eq(0);
  });
  it("the average-per-day order is global: page one holds the best average", async () => {
    const { fi } = await index();
    const now = Date.now();
    fi.applyPools([P("OLD", 100_000n, 0n, 0n, BigInt(Math.floor((now - 100 * DAY) / 1000))), P("NEW", 20_000n, 0n, 0n, BigInt(Math.floor((now - DAY) / 1000)))], 1, now, 0);
    const page = fi.coins({ sort: "avg", stage: "all", eligible: false, creator: null, search: null, limit: 1, offset: 0 }, now);
    expect(page.map((c: any) => c.pool)).deep.eq(["NEW"]);
    expect(Number(page[0].creatorAvgPerDayEstimateLamports)).within(19_990, 20_000);
    expect(fi.coins({ sort: "avg", stage: "all", eligible: false, creator: null, search: null, limit: 1, offset: 1 }, now).map((c: any) => c.pool)).deep.eq(["OLD"]);
  });
  it("a u64 threshold above 2^63 survives storage", async () => {
    const { fi } = await index();
    const r = fi.db.db.prepare("select threshold from fi_configs where config = 'CFG'").get();
    expect(String(r.threshold)).eq((2n ** 64n - 1n).toString());
  });
});

describe("tails rollup (review 120)", () => {
  it("pages, sums every harvest of the last 24 hours, joins foreign sources by mint, and says unavailable instead of zero", async () => {
    const store = openStore("sqlite::memory:"); await store.init();
    const now = Date.now(), sec = Math.floor(now / 1000);
    const vault = (filled: boolean, outstanding: number) => ({ status: { launched: {} }, stMint: "ST", accounting: { harvestedGross: "999", routedGross: "100", refundedPrincipal: filled ? "40" : "100", burnedSt: "7" }, routing: { outstandingOrders: outstanding }, live: { ladder: null } });
    await store.upsertVault("V1", vault(true, 0)); await store.upsertVault("V2", vault(false, 1)); await store.upsertVault("V3", vault(true, 0));
    await store.upsertStream("S1", "V1", { kind: { dbcCreatorRights: {} }, isOwn: false, pool: "FOREIGNPOOL", sourceMint: "FOREIGNMINT" });
    await store.upsertStream("S1own", "V1", { kind: { dbcCreatorRights: {} }, isOwn: true, pool: "TAILPOOL", depositTs: sec - 86_400 });
    await store.upsertStream("S2", "V2", { kind: { dammV2Position: {} }, isOwn: false, pool: "OTHERPOOL", sourceMint: "OTHERMINT" });
    const events = Array.from({ length: 101 }, (_, i) => ({ signature: `h${i}`, idx: 0, slot: 1000 + i, blockTime: sec - 3600, name: "harvested", vault: "V1", data: { gross: "10" } }));
    events.push({ signature: "old", idx: 0, slot: 900, blockTime: sec - 3 * 86_400, name: "harvested", vault: "V1", data: { gross: "5000" } });
    await store.insertEvents(events as any, "h100");
    const all = await tailsRollup(store, null, { limit: 2, offset: 0, source: null }, now);
    expect(all.total).eq(3); expect(all.tails.length).eq(2);
    const page2 = await tailsRollup(store, null, { limit: 2, offset: 2, source: null }, now);
    expect(page2.tails.length).eq(1);
    const v1 = (await tailsRollup(store, null, { limit: 10, offset: 0, source: "FOREIGNMINT" }, now));
    expect(v1.tails.map((t) => t.vault)).deep.eq(["V1"]);
    expect(v1.tails[0].feesIn.last24hLamports).eq("1010"); // all 101 recent harvests, not the newest 100, and not the old one
    expect(v1.tails[0].bids).deep.eq({ placedLamports: "100", refundedLamports: "40", restingLamports: "0", filledLamports: "60" });
    expect(v1.tails[0].unwindOpensAtSec).eq(sec - 86_400 + 30 * 86_400);
    expect(v1.tails[0].raise).eq(null);
    const v2 = (await tailsRollup(store, null, { limit: 10, offset: 0, source: "OTHERMINT" }, now)).tails[0];
    expect(v2.bids.restingLamports).eq(null); expect(v2.bids.filledLamports).eq(null); // an open order with an unread ladder is unknown, not zero
    await store.close();
  });
});
