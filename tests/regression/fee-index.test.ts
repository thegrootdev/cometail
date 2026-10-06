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

// ---- recheck 122: incomplete reads never finish a claim or a ladder ----
import { createHash } from "crypto";
import { PublicKey } from "@solana/web3.js";
import { utils } from "@coral-xyz/anchor";
import { Indexer } from "../../worker/src/indexer";

const DBC_ID = new PublicKey("dbcij3LWUppWqq96dh6gJWwBifmcGfLSB5D4DuSMaqN");
/** A transaction carrying one DBC creator-claim event (the event-authority self-CPI), as readTx returns it. */
function claimTx(pool: PublicKey, quote: bigint, slot: number) {
  const disc = createHash("sha256").update("event:EvtClaimCreatorTradingFee").digest().subarray(0, 8);
  const payload = Buffer.alloc(48); pool.toBuffer().copy(payload, 0); payload.writeBigUInt64LE(0n, 32); payload.writeBigUInt64LE(quote, 40);
  const data = utils.bytes.bs58.encode(Buffer.concat([Buffer.from("e445a52e51cb9a1d", "hex"), disc, payload]));
  const keys = [DBC_ID];
  return { slot, blockTime: null, meta: { err: null, loadedAddresses: { writable: [], readonly: [] }, innerInstructions: [{ index: 0, instructions: [{ programIdIndex: 0, accounts: [], data }] }] },
    transaction: { message: { getAccountKeys: () => ({ get: (i: number) => keys[i], length: keys.length }), compiledInstructions: [] } } };
}
async function claimWorld(sigs: { signature: string; slot: number }[], readable: Set<string>, claims?: Set<string>) {
  const pool = Keypair.generate().publicKey;
  const conn: any = { rpcEndpoint: "http://x",
    getSignaturesForAddress: async (_p: PublicKey, o: { limit: number; before?: string }) => { const i = o.before ? sigs.findIndex((s) => s.signature === o.before) + 1 : 0; return sigs.slice(i, i + o.limit).map((s) => ({ ...s, err: null })); },
    getTransaction: async (sig: string) => {
      if (!readable.has(sig)) return null;
      const tx = claimTx(pool, 50n, sigs.find((s) => s.signature === sig)!.slot);
      if (claims && !claims.has(sig)) tx.meta.innerInstructions = [];
      return tx;
    } };
  const { Chain } = await import("../../worker/src/chain");
  const store = openStore("sqlite::memory:"); await store.init();
  const fi = new FeeIndex(new Chain(conn), store, ":memory:", { fullEveryHours: 24, deltaEveryMinutes: 5, pageDelayMs: 0, claimLookupsPerPass: 10, namesPerPass: 0, ourConfigs: [] });
  await fi.open();
  fi.rememberConfig({ config: "CFG", quoteMint: NATIVE_MINT.toBase58(), feeClaimer: "L", creatorPct: 100, activationType: 1, partnerLocked: 20, creatorLocked: 80, threshold: 1n, reasons: [] });
  const key = pool.toBase58();
  fi.applyPools([P(key, 1000n, 1000n, 0n)], 100, Date.now(), 50);
  fi.applyPools([P(key, 1000n, 900n, 0n)], 110, Date.now(), 100);
  fi.closeClaimWindows(500);
  const claimRows = async () => (await store.listFeedSince(null, 1000)).filter((r) => r.type === "claim").map((r) => r.signature).sort();
  const status = () => fi.db.db.prepare("select status, note from fi_claims").get();
  return { fi, readable, claimRows, status };
}

describe("fee index: incomplete claim windows (recheck 122)", () => {
  it("one claim readable and one not: publishes the first, stays pending, then confirms with both and no duplicate", async () => {
    const w = await claimWorld([{ signature: "s112", slot: 112 }, { signature: "s111", slot: 111 }], new Set(["s111"]));
    await w.fi.resolveClaims();
    expect(String(w.status().status)).eq("pending");
    expect(await w.claimRows()).deep.eq(["s111"]);
    w.readable.add("s112");
    await w.fi.resolveClaims();
    expect(String(w.status().status)).eq("confirmed");
    expect(await w.claimRows()).deep.eq(["s111", "s112"]);
  });
  it("a window past the signature cap with a claim found is partial, not confirmed", async () => {
    const sigs = Array.from({ length: 320 }, (_, i) => ({ signature: `x${i}`, slot: 400 - i }));
    const w = await claimWorld(sigs, new Set(sigs.map((x) => x.signature)), new Set(["x5"]));
    await w.fi.resolveClaims();
    const s = w.status();
    expect(String(s.status)).eq("partial"); expect(String(s.note)).match(/more than 300 signatures/);
    expect(await w.claimRows()).deep.eq(["x5"]);
  });
});

describe("ladder read: an unreadable order makes resting principal unknown (recheck 122)", () => {
  it("the indexer marks the ladder partial and the rollup reports filled as unknown", async () => {
    const pair = Keypair.generate().publicKey, stMint = Keypair.generate().publicKey, vaultPk = Keypair.generate().publicKey;
    const chain: any = { lbPair: async () => ({ binStep: 100, activeId: 0 }), orderRecords: async () => [{ account: { limitOrder: Keypair.generate().publicKey, placedTs: 1, grossSpent: 100n } }], limitOrder: async () => null, binArrays: async () => new Map() };
    const store = openStore("sqlite::memory:"); await store.init();
    const ix: any = new Indexer(chain, store);
    ix.stDecimalsCache.set(stMint.toBase58(), 6);
    const live = await ix.liveView(vaultPk, { dlmmPair: pair, stMint, stIsX: true });
    expect(live.ladder.status).eq("partial"); expect(live.ladder.missingOrders).eq(1); expect(live.ladder.records).eq(1);
    await store.upsertVault(vaultPk.toBase58(), { status: { live: {} }, stMint: stMint.toBase58(), accounting: { harvestedGross: "0", routedGross: "100", refundedPrincipal: "0", burnedSt: "0" }, routing: { outstandingOrders: 1 }, live });
    const t = (await tailsRollup(store, null, { limit: 10, offset: 0, source: null })).tails[0];
    expect(t.bids).deep.eq({ placedLamports: "100", refundedLamports: "0", restingLamports: null, filledLamports: null });
    // and an "ok" ladder whose order count disagrees with the vault is not trusted either
    await store.upsertVault(vaultPk.toBase58(), { status: { live: {} }, stMint: stMint.toBase58(), accounting: { routedGross: "100", refundedPrincipal: "0" }, routing: { outstandingOrders: 2 }, live: { ladder: { status: "ok", orders: [{}], records: 1, missingOrders: 0, unknownBins: 0, restingLamports: "0" } } });
    expect((await tailsRollup(store, null, { limit: 10, offset: 0, source: null })).tails[0].bids.filledLamports).eq(null);
    await store.close();
  });
});

// ---- the index never takes the indexer down (2026-10-06 crash loop) ----
import { feeIndexPath, openFeeIndexSoft } from "../../worker/src/feeindex";
import os from "os";
import fsx from "fs";
import pathx from "path";

describe("fee index: database setting and fail-soft open", () => {
  it("reads sqlite:/path like DATABASE_URL, or a plain path, and refuses other schemes", () => {
    expect(feeIndexPath("sqlite:/opt/cometail/repo/.local/feeindex.sqlite")).eq("/opt/cometail/repo/.local/feeindex.sqlite");
    expect(feeIndexPath(" /var/lib/x.sqlite ")).eq("/var/lib/x.sqlite");
    expect(() => feeIndexPath("postgres://host/db")).throw(/sqlite:\/path or a file path/);
  });
  it("an unopenable database returns null and reports it; a good one opens", async () => {
    const store = openStore("sqlite::memory:"); await store.init();
    const opts = { fullEveryHours: 24, deltaEveryMinutes: 5, pageDelayMs: 0, claimLookupsPerPass: 1, namesPerPass: 0, ourConfigs: [] };
    const reports: string[] = [];
    const bad = await openFeeIndexSoft({ connection: {} } as any, store, "sqlite:/nonexistent-dir-for-test/feeindex.sqlite", opts, (m) => reports.push(m));
    expect(bad).eq(null); expect(reports[0]).match(/fee index disabled/);
    const dir = fsx.mkdtempSync(pathx.join(os.tmpdir(), "fi-"));
    const good = await openFeeIndexSoft({ connection: {} } as any, store, `sqlite:${pathx.join(dir, "feeindex.sqlite")}`, opts, (m) => reports.push(m));
    expect(good).not.eq(null); expect(reports.length).eq(1);
    good!.close(); fsx.rmSync(dir, { recursive: true, force: true }); await store.close();
  });
});

// ---- owner fixes 2026-10-06: lifetime never reads as the same number by accident; names and logos ----
import { creatorLifetime, roundingAllowance } from "../../worker/src/feeindex";
import { creatorLifetime as webCreatorLifetime } from "../../web/src/lib/creator-fees";

/** A Metaplex metadata account body: key, update authority, mint, then name / symbol / uri as borsh strings. */
function metaplexData(name: string, symbol: string, uri: string): Buffer {
  const str = (s: string) => { const b = Buffer.from(s, "utf8"); const l = Buffer.alloc(4); l.writeUInt32LE(b.length); return Buffer.concat([l, b]); };
  return Buffer.concat([Buffer.from([4]), Buffer.alloc(64), str(name), str(symbol), str(uri)]);
}

describe("fee index: lifetime against claimable (TBI, 6qoh...dBLV)", () => {
  it("the chain's TBI numbers: the counter estimate is 100 lamports over claimable, so nothing was claimed and lifetime is claimable, exact", () => {
    // pool 9DMBff...: totalTradingQuoteFee 353031534845, creator 70%, creatorQuoteFee 247122074291 (a simulated claim paid exactly this)
    const estimate = creatorShare(353_031_534_845n, 70);
    expect(estimate).eq(247_122_074_391n);
    for (const f of [creatorLifetime, webCreatorLifetime]) {
      const r = f(estimate, 247_122_074_291n);
      expect(r.nothingClaimed).eq(true); expect(r.lifetime).eq(247_122_074_291n); expect(r.claimed).eq(0n);
    }
  });
  it("a real claim is not rounding, on a big coin and on a small one; lifetime never drops below claimable", () => {
    for (const f of [creatorLifetime, webCreatorLifetime]) {
      expect(f(10_000_000_000n, 9_000_000_000n)).deep.eq({ lifetime: 10_000_000_000n, claimed: 1_000_000_000n, nothingClaimed: false });
      expect(f(20_000n, 0n)).deep.eq({ lifetime: 20_000n, claimed: 20_000n, nothingClaimed: false }); // small coin, fully claimed
      expect(f(20_000n, 19_985n).nothingClaimed).eq(true); // 15 lamports on 20,000: within 0.1%
      expect(f(500n, 600n)).deep.eq({ lifetime: 600n, claimed: 0n, nothingClaimed: true });
    }
    expect(roundingAllowance(10n ** 12n)).eq(100_000n);
    expect(roundingAllowance(20_000n)).eq(20n);
  });
  it("coin rows use the shown lifetime: exact when nothing was claimed, an estimate with what was claimed otherwise", async () => {
    const { fi } = await index({}, 70);
    fi.applyPools([P("TBI", 353_031_534_845n, 247_122_074_291n, 0n), P("SMALL", 28_572n, 0n, 0n)], 1, Date.now(), 0);
    const tbi = fi.coin("MTBI")!;
    expect(tbi.creatorLifetimeEstimateLamports).eq("247122074291"); expect(tbi.claimableLamports).eq("247122074291");
    expect(tbi.nothingClaimed).eq(true); expect(tbi.creatorClaimedEstimateLamports).eq("0");
    const small = fi.coin("MSMALL")!;
    expect(small.creatorLifetimeEstimateLamports).eq("20000"); expect(small.creatorClaimedEstimateLamports).eq("20000"); expect(small.nothingClaimed).eq(false);
  });
  it("rows stored with the raw estimate (the first release) are corrected when the index opens", async () => {
    const dir = fsx.mkdtempSync(pathx.join(os.tmpdir(), "fi-life-"));
    const file = pathx.join(dir, "feeindex.sqlite");
    const store = openStore("sqlite::memory:"); await store.init();
    const opts = { fullEveryHours: 24, deltaEveryMinutes: 5, pageDelayMs: 0, claimLookupsPerPass: 1, namesPerPass: 0, ourConfigs: [] };
    const first = new FeeIndex({ connection: {} } as any, store, file, opts); await first.open();
    first.rememberConfig({ config: "CFG", quoteMint: NATIVE_MINT.toBase58(), feeClaimer: "L", creatorPct: 70, activationType: 1, partnerLocked: 20, creatorLocked: 80, threshold: 1n, reasons: [] });
    first.applyPools([P("TBI", 353_031_534_845n, 247_122_074_291n, 0n), P("SMALL", 28_572n, 0n, 0n)], 1, Date.now(), 0);
    first.db.db.prepare("update fi_pools set creator_life = 247122074391 where pool = 'TBI'").run();
    first.close();
    const again = new FeeIndex({ connection: {} } as any, store, file, opts); await again.open();
    expect(String(again.db.db.prepare("select creator_life from fi_pools where pool = 'TBI'").get().creator_life)).eq("247122074291");
    expect(String(again.db.db.prepare("select creator_life from fi_pools where pool = 'SMALL'").get().creator_life)).eq("20000");
    again.close(); await store.close(); fsx.rmSync(dir, { recursive: true, force: true });
  });
});

describe("fee index: names and logos for the rows an answer shows", () => {
  const mintA = Keypair.generate().publicKey.toBase58(), mintB = Keypair.generate().publicKey.toBase58(), mintC = Keypair.generate().publicKey.toBase58();
  async function withMetadata(json: (uri: string) => Promise<unknown>) {
    const reads: number[] = [];
    const conn = { getMultipleAccountsInfo: async (keys: any[]) => { reads.push(keys.length); return keys.map((_k, i) => ({ data: metaplexData(["Text Behind Image", "Plain", "Http"][i] ?? "X", ["TBI", "PLN", "HTP"][i] ?? "X", [`https://meta.example/a.json`, `https://meta.example/b.json`, `https://meta.example/c.json`][i]) })); } };
    const { fi } = await index(conn, 70);
    fi.fetchJson = json;
    fi.applyPools([{ ...P("PA", 1000n, 700n, 0n), mint: mintA }, { ...P("PB", 1000n, 700n, 0n), mint: mintB }, { ...P("PC", 1000n, 700n, 0n), mint: mintC }], 1, Date.now(), 0);
    return { fi, reads };
  }
  it("reads names, uris and https images on demand; a non-https image is not shown; the mint is only a fallback", async () => {
    const { fi, reads } = await withMetadata(async (uri) => (uri.endsWith("a.json") ? { image: "https://img.example/tbi.png" } : uri.endsWith("b.json") ? { name: "no image" } : { image: "http://img.example/x.png" }));
    expect(fi.coin(mintA)!.name).eq(null);
    await fi.ensureIdentity([mintA, mintB, mintC], 2_000);
    expect(reads).deep.eq([3]);
    const a = fi.coin(mintA)!, b = fi.coin(mintB)!, c = fi.coin(mintC)!;
    expect([a.name, a.symbol, a.imageUrl]).deep.eq(["Text Behind Image", "TBI", "https://img.example/tbi.png"]);
    expect([b.name, b.imageUrl]).deep.eq(["Plain", null]);
    expect(c.imageUrl).eq(null);
    expect(fi.lookup(mintA)!.imageUrl).eq("https://img.example/tbi.png");
    // known now: a second ask reads nothing
    await fi.ensureIdentity([mintA, mintB, mintC], 2_000);
    expect(reads).deep.eq([3]);
  });
  it("a slow host does not hold the answer past its budget, and its logo lands for the next one; an unreachable host is retried only after six hours", async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => { release = r; });
    let calls = 0;
    const { fi } = await withMetadata(async (uri) => { calls++; if (uri.endsWith("a.json")) { await gate; return { image: "https://img.example/late.png" }; } throw new Error("unreachable"); });
    const t0 = Date.now();
    await fi.ensureIdentity([mintA, mintB], 150);
    expect(Date.now() - t0).lt(1_000);
    expect(fi.coin(mintA)!.name).eq("Text Behind Image"); // names landed inside the budget
    expect(fi.coin(mintA)!.imageUrl).eq(null);
    release(); await new Promise((r) => setTimeout(r, 20));
    expect(fi.coin(mintA)!.imageUrl).eq("https://img.example/late.png");
    const before = calls;
    await fi.ensureIdentity([mintB], 500);
    expect(calls).eq(before); // B was unreachable a moment ago: not retried yet
    fi.db.db.prepare("update fi_names set image_checked_at = ? where mint = ?").run(Date.now() - 7 * 3_600_000, mintB);
    await fi.ensureIdentity([mintB], 500);
    expect(calls).eq(before + 1);
  });
  it("the background fill reads the most-earning coins first, and a changed uri clears the old logo", async () => {
    const { fi } = await withMetadata(async (uri) => ({ image: `https://img.example/${uri.slice(-6, -5)}.png` }));
    (fi as any).opts.namesPerPass = 10;
    await fi.fillNames();
    await fi.fillImages(10, 2_000);
    expect(fi.coin(mintA)!.imageUrl).eq("https://img.example/a.png");
    fi.db.db.prepare("update fi_names set uri = 'https://meta.example/old.json' where mint = ?").run(mintA);
    await (fi as any).readNames([mintA]);
    expect(fi.coin(mintA)!.imageUrl).eq(null); // the uri changed back: the stored image belonged to the other file
  });
  it("an index file from the first release gains the new columns on open", async () => {
    const dir = fsx.mkdtempSync(pathx.join(os.tmpdir(), "fi-old-"));
    const file = pathx.join(dir, "feeindex.sqlite");
    const { DatabaseSync } = await import("node:sqlite");
    const old = new DatabaseSync(file);
    old.exec("create table fi_names (mint text primary key, name text, symbol text, checked_at integer not null); insert into fi_names values ('m', 'Old', 'OLD', 1);");
    old.close();
    const store = openStore("sqlite::memory:"); await store.init();
    const fi = new FeeIndex({ connection: {} } as any, store, file, { fullEveryHours: 24, deltaEveryMinutes: 5, pageDelayMs: 0, claimLookupsPerPass: 1, namesPerPass: 0, ourConfigs: [] });
    await fi.open();
    const cols = fi.db.db.prepare("pragma table_info(fi_names)").all().map((r: any) => String(r.name));
    expect(cols).to.include.members(["uri", "image", "image_status", "image_checked_at"]);
    expect(String(fi.db.db.prepare("select name from fi_names where mint = 'm'").get().name)).eq("Old");
    fi.close(); await store.close(); fsx.rmSync(dir, { recursive: true, force: true });
  });
});

import { token2022Metadata } from "../../worker/src/feeindex";
import { TOKEN_2022_PROGRAM_ID, TOKEN_PROGRAM_ID } from "@solana/spl-token";
describe("fee index: Token-2022 coins keep their metadata in the mint", () => {
  // mainnet mint H7wJ1w... (Token-2022 with metadata pointer + token metadata), read 2026-10-06
  const QUOTA = Buffer.from("AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAVMxVjMl8AwAGAQAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAARIAQAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAO+B3YrfK5ABf8vclmtklTrBD0JNFIZQz0pCcK/RuP6XEwCfAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA74Hdit8rkAF/y9yWa2SVOsEPQk0UhlDPSkJwr9G4/pcFAAAAUXVvdGEFAAAAUVVPVEFFAAAAaHR0cHM6Ly9nYXRld2F5LmlyeXMueHl6L0NDdlFRWmtrOFpuUXh3WFhGSmFnZ3VVVks5R1UyQkZKeVF6TE03Z1A0NEh4AAAAAA==", "base64");
  const mint = new PublicKey("H7wJ1wbbdu4ZCom6yegVaJxWBvdjLQ3NaNZbJsb8vAni");
  it("reads name, symbol and uri from the extension; a classic mint has none", () => {
    expect(token2022Metadata(mint, { owner: TOKEN_2022_PROGRAM_ID, data: QUOTA, lamports: 1, executable: false })).deep.eq({ name: "Quota", symbol: "QUOTA", uri: "https://gateway.irys.xyz/CCvQQZkk8ZnQxwXXFJagguUVK9GU2BFJyQzLM7gP44Hx" });
    expect(token2022Metadata(mint, { owner: TOKEN_PROGRAM_ID, data: Buffer.alloc(82), lamports: 1, executable: false })).eq(null);
  });
  it("a coin with no Metaplex account is named from its mint, and rows from before are read once more", async () => {
    const calls: string[] = [];
    const conn = { getMultipleAccountsInfo: async (keys: any[]) => { calls.push(keys.map((k: any) => k.toBase58()).join(",")); return keys.map((k: any) => (k.equals(mint) ? { owner: TOKEN_2022_PROGRAM_ID, data: QUOTA, lamports: 1, executable: false } : null)); } };
    const { fi } = await index(conn, 70);
    fi.fetchJson = async () => ({ image: "https://img.example/quota.png" });
    fi.applyPools([{ ...P("PQ", 1000n, 700n, 0n), mint: mint.toBase58() }], 1, Date.now(), 0);
    fi.db.db.prepare("insert into fi_names (mint, name, symbol, checked_at) values (?, null, null, 0)").run(mint.toBase58()); // an old row
    await fi.ensureIdentity([mint.toBase58()], 2_000);
    expect(calls.length).eq(2); // the Metaplex PDA (none), then the mint
    const q = fi.coin(mint.toBase58())!;
    expect([q.name, q.symbol, q.imageUrl]).deep.eq(["Quota", "QUOTA", "https://img.example/quota.png"]);
  });
});

import { ipfsPath, metadataCandidates, liveImage, IPFS_GATEWAYS } from "../../worker/src/metadata";
describe("metadata on IPFS: the public ipfs.io family stopped serving (429, sunset 2026-09-21)", () => {
  const TBI = "bafkreie56an7ieog6yaipw3qg2mt2gy3bzxh4hbpprj2lannmu7ibsp5by", V0 = "QmULAPMSpG2X2uZmwGdAasvnwWKCGLRVMECEtSfA9TvHMm";
  it("finds the IPFS path in gateway paths, ipfs:// and subdomain gateways, and nothing else", () => {
    expect(ipfsPath(`https://ipfs.io/ipfs/${TBI}`)).eq(TBI);
    expect(ipfsPath(`https://opengameprotocol.mypinata.cloud/ipfs/${V0}/meta.json`)).eq(`${V0}/meta.json`);
    expect(ipfsPath(`ipfs://${TBI}`)).eq(TBI);
    expect(ipfsPath(`https://${TBI}.ipfs.dweb.link/`)).eq(TBI);
    expect(ipfsPath("https://gateway.irys.xyz/CCvQQZkk8ZnQxwXXFJagguUVK9GU2BFJyQzLM7gP44Hx")).eq(null);
    expect(ipfsPath("https://example.com/ipfs/not-a-cid")).eq(null);
  });
  it("reads TBI's metadata (on ipfs.io) through the live gateways only; keeps a dedicated gateway first; leaves other hosts alone", () => {
    expect(metadataCandidates(`https://ipfs.io/ipfs/${TBI}`)).deep.eq(IPFS_GATEWAYS.map((g) => g + TBI));
    expect(metadataCandidates(`https://x.mypinata.cloud/ipfs/${V0}`)).deep.eq([`https://x.mypinata.cloud/ipfs/${V0}`, ...IPFS_GATEWAYS.map((g) => g + V0)]);
    expect(metadataCandidates("https://gateway.irys.xyz/abc")).deep.eq(["https://gateway.irys.xyz/abc"]);
  });
  it("a logo on IPFS is stored under the first gateway that serves it as an image; an https logo elsewhere as it is; http never", async () => {
    const asked: string[] = [];
    const second = async (u: string) => { asked.push(u); return u.startsWith(IPFS_GATEWAYS[1]); };
    expect(await liveImage(`https://ipfs.io/ipfs/${V0}`, second)).eq(IPFS_GATEWAYS[1] + V0);
    expect(asked).deep.eq([IPFS_GATEWAYS[0] + V0, IPFS_GATEWAYS[1] + V0]);
    expect(await liveImage(`https://ipfs.io/ipfs/${V0}`, async () => false)).eq(null);
    expect(await liveImage("https://static-create.jup.ag/images/x.png", async () => { throw new Error("not probed"); })).eq("https://static-create.jup.ag/images/x.png");
    expect(await liveImage("http://img.example/x.png", async () => true)).eq(null);
    // a coin's own dedicated gateway still serves: kept as it is, not probed
    expect(await liveImage(`https://lizard.mypinata.cloud/ipfs/${V0}/logo`, async () => { throw new Error("not probed"); })).eq(`https://lizard.mypinata.cloud/ipfs/${V0}/logo`);
    expect(await liveImage(`ipfs://${V0}`, async (u) => u.startsWith(IPFS_GATEWAYS[0]))).eq(IPFS_GATEWAYS[0] + V0);
  });
  it("an IPFS logo no gateway serves is retried later; a plain-http logo is simply missing", async () => {
    const conn = { getMultipleAccountsInfo: async (keys: any[]) => keys.map(() => ({ data: metaplexData("Racer", "RACER", `https://ipfs.io/ipfs/${V0}`) })) };
    const { fi } = await index(conn, 70);
    const m1 = Keypair.generate().publicKey.toBase58(), m2 = Keypair.generate().publicKey.toBase58();
    fi.applyPools([{ ...P("R1", 1000n, 700n, 0n), mint: m1 }, { ...P("R2", 1000n, 700n, 0n), mint: m2 }], 1, Date.now(), 0);
    let n = 0;
    fi.fetchJson = async () => (n++ === 0 ? { image: `ipfs://${V0}` } : { image: "http://img.example/x.png" });
    fi.resolveImage = async () => null;
    await fi.ensureIdentity([m1], 2_000); await fi.ensureIdentity([m2], 2_000);
    const st = (m: string) => String(fi.db.db.prepare("select image_status from fi_names where mint = ?").get(m).image_status);
    expect([st(m1), st(m2)]).deep.eq(["unreachable", "missing"]);
  });
});
