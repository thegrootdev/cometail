// Gate 11 (and the Launched-only part of gate 4): harvests split exactly the new claim delta
// to pinned destinations: own curve 8/15 to the depositor, own position 1/2, external
// streams 1/5 to the treasury; prior income is untouched; one-time claims are separate and
// never apply to own streams; accounting equals balance deltas.
import { BN } from "@coral-xyz/anchor";
import { Keypair, PublicKey } from "@solana/web3.js";
import { NATIVE_MINT, TOKEN_2022_PROGRAM_ID, createTransferCheckedInstruction } from "@solana/spl-token";
import { expect } from "chai";
import { VaultClientStep5, deriveStream } from "@cometail/client";
import { startSvm, fund, DAMM_V2_MIGRATION_CONFIG } from "../harness/svm";
import { send, expectFail } from "../harness/tx";
import { ataIx, ensureAta, balance, wrapSol } from "../harness/tokens";
import * as dbc from "../harness/dbc";
import * as damm from "../harness/damm";

const policy = { maxSpendPerPeriod: new BN(5_000_000_000), periodSeconds: new BN(3600), maxOutstandingOrders: 4, maxBinsPerOrder: 20, maxPriceQ64: new BN(1).shln(64).muln(10) };

async function world() {
  const owner = Keypair.generate();
  const svm = startSvm({ upgradeAuthority: owner.publicKey });
  svm.airdrop(owner.publicKey, BigInt(100_000_000_000));
  const client = new VaultClientStep5();
  const keeper = fund(svm), creator = fund(svm), buyer = fund(svm), anyone = fund(svm);
  const treasury = ensureAta(svm, owner, NATIVE_MINT, owner.publicKey);
  const cfgs = [] as PublicKey[];
  for (const n of ["stream-25", "stream-50", "stream-75"] as const) cfgs.push(await dbc.createConfig(svm, { payer: owner, feeClaimer: owner.publicKey, leftoverReceiver: owner.publicKey, quoteMint: NATIVE_MINT, params: dbc.configParams(n) }));
  send(svm, [await client.initProtocol({ admin: owner.publicKey, keeper: keeper.publicKey, payer: owner.publicKey, streamConfigs: cfgs as any })], [owner]);
  const plain = await dbc.createConfig(svm, { payer: owner, feeClaimer: owner.publicKey, leftoverReceiver: owner.publicKey, quoteMint: NATIVE_MINT, params: dbc.configParams("plain") });
  return { svm, client, owner, keeper, creator, buyer, anyone, treasury, cfgs, plain };
}

/** External plain launch by `creator`, left open (PreBondingCurve) with fees accrued, or filled + migrated. */
async function external(w: any, fill: boolean) {
  const mint = Keypair.generate();
  const L = await dbc.createPoolIx({ config: w.plain, baseMint: mint.publicKey, quoteMint: NATIVE_MINT, creator: w.creator.publicKey, payer: w.creator.publicKey });
  send(w.svm, [L.ix], [w.creator, mint], { cu: 600_000 });
  const R: BN = dbc.getConfig(w.svm, w.plain).migrationQuoteThreshold;
  const buyerQuote = wrapSol(w.svm, w.buyer, R.muln(6));
  const buyerBase = ensureAta(w.svm, w.buyer, mint.publicKey, w.buyer.publicKey);
  await dbc.buy(w.svm, w.buyer, L.pool, buyerQuote, buyerBase, R.divn(3));
  if (!fill) return { mint: mint.publicKey, pool: L.pool, R, buyerQuote, buyerBase };
  await dbc.buy(w.svm, w.buyer, L.pool, buyerQuote, buyerBase, R.muln(6).divn(5));
  const mig = await dbc.migrateToDammV2(w.svm, w.buyer, L.pool, DAMM_V2_MIGRATION_CONFIG.customizable);
  return { mint: mint.publicKey, pool: L.pool, R, buyerQuote, buyerBase, dammPool: mig.dammPool, creatorPos: damm.findPositionOwnedBy(w.svm, [mig.firstPosition, mig.secondPosition], w.creator.publicKey)! };
}

function harvestArgs(w: any, cv: any, stream: PublicKey) {
  return { vault: cv.vault, stream, incomeWsol: cv.incomeWsol, placeholderWsol: cv.placeholder.publicKey, depositorWsol: cv.depositorWsol, treasury: w.treasury };
}

describe("gate 11: splits on real claims, new delta only, pinned destinations", () => {
  it("external DBC rights (open curve): trading fees 1/5 to the treasury; Open vaults cannot harvest; one-time claims after the external migration; own streams rejected by harvest_one_time", async () => {
    const w = await world();
    const { svm, client, creator, buyer, anyone, treasury } = w;
    const ext = await external(w, false);
    const stMint = Keypair.generate();
    const cv = await client.createVault({ depositor: creator.publicKey, stMint: stMint.publicKey, policy });
    send(svm, [cv.ix], [creator, cv.placeholder, stMint]);
    send(svm, [await dbc.transferPoolCreatorIx(svm, ext.pool, creator.publicKey, cv.vault), await client.depositDbcRights({ vault: cv.vault, depositor: creator.publicKey, streamIndex: 0, dbcPool: ext.pool, dbcConfig: w.plain, baseMint: ext.mint })], [creator]);
    const ps = dbc.getPool(svm, ext.pool);
    const hArgs = { ...harvestArgs(w, cv, deriveStream(cv.vault, 0)), dbcPool: ext.pool, baseVault: ps.baseVault, quoteVault: ps.quoteVault, baseMint: ext.mint };
    // Open: no harvest (so a withdrawal always returns the stream with its fees)
    expectFail(svm, [await client.harvestDbc(hArgs)], [anyone], "WrongStatus");
    // launch the vault's own token so harvests open up
    const L = await client.launch({ vault: cv.vault, depositor: creator.publicKey, stMint: stMint.publicKey, config: w.cfgs[1], preset: 1, streamIndex: 1, metadata: { name: "t", symbol: "t", uri: "u" } });
    send(svm, [L.ix], [creator, stMint], { cu: 800_000 });
    const accrued = dbc.getPool(svm, ext.pool).creatorQuoteFee;
    expect(accrued.gtn(0)).true;
    const t0 = balance(svm, treasury), i0 = balance(svm, cv.incomeWsol), d0 = balance(svm, cv.depositorWsol);
    send(svm, [await client.harvestDbc(hArgs)], [anyone], { label: "harvest_dbc.external" });
    const toProtocol = accrued.divn(5);
    expect(balance(svm, treasury).sub(t0).toString()).eq(toProtocol.toString());
    expect(balance(svm, cv.incomeWsol).sub(i0).toString()).eq(accrued.sub(toProtocol).toString());
    expect(balance(svm, cv.depositorWsol).sub(d0).isZero()).true;
    let v = client.decodeVault(Buffer.from(svm.getAccount(cv.vault)!.data));
    expect(v.accounting.harvestedGross.toString()).eq(accrued.toString());
    expect(v.accounting.toProtocol.toString()).eq(toProtocol.toString());
    expect(v.accounting.income.toString()).eq(accrued.sub(toProtocol).toString());
    // more trading, second harvest: only the new delta is split; the earlier income is untouched
    await dbc.buy(svm, buyer, ext.pool, ext.buyerQuote, ext.buyerBase, ext.R.divn(4));
    const accrued2 = dbc.getPool(svm, ext.pool).creatorQuoteFee;
    const t1 = balance(svm, treasury), i1 = balance(svm, cv.incomeWsol);
    send(svm, [await client.harvestDbc(hArgs)], [anyone]);
    expect(balance(svm, treasury).sub(t1).toString()).eq(accrued2.divn(5).toString());
    expect(balance(svm, cv.incomeWsol).sub(i1).toString()).eq(accrued2.sub(accrued2.divn(5)).toString());
    // the external curve completes and migrates: its migration fee is zero (plain), surplus zero, so one-time has nothing
    await dbc.buy(svm, buyer, ext.pool, ext.buyerQuote, ext.buyerBase, ext.R.muln(2));
    await dbc.migrateToDammV2(svm, buyer, ext.pool, DAMM_V2_MIGRATION_CONFIG.customizable);
    const ot = await client.harvestOneTime({ ...harvestArgs(w, cv, deriveStream(cv.vault, 0)), dbcPool: ext.pool, dbcConfig: w.plain, quoteVault: ps.quoteVault });
    const otRes = send(svm, [ot], [anyone], { label: "harvest_one_time.plain" }); // claims succeed with zero amounts
    const events = otRes.logs.filter((l) => l.startsWith("Program data: ")).map((l) => (client as any).program.coder.events.decode(l.slice("Program data: ".length))).filter(Boolean).map((e: any) => e.name);
    expect(events).include("oneTimeHarvested"); // the coder reports event names in camelCase
    expect(events).not.include("harvested");
    expect(client.decodeStream(Buffer.from(svm.getAccount(deriveStream(cv.vault, 0))!.data)).oneTimeClaims).eq(3);
    expectFail(svm, [ot], [anyone], "WrongStatus"); // nothing left to claim
    // the vault's own pool is never a one-time stream
    const own = deriveStream(cv.vault, 1);
    const ownPs = dbc.getPool(svm, L.pool);
    expectFail(svm, [await client.harvestOneTime({ ...harvestArgs(w, cv, own), dbcPool: L.pool, dbcConfig: w.cfgs[1], quoteVault: ownPs.quoteVault })], [anyone], "AccountMismatch");
    void v;
  });

  it("own curve fees: 8/15 to the depositor, 7/15 kept; own position after migration: 1/2 and 1/2; external position: 1/5 to the treasury", async () => {
    const w = await world();
    const { svm, client, creator, buyer, anyone, treasury } = w;
    const ext = await external(w, true);
    const stMint = Keypair.generate();
    const cv = await client.createVault({ depositor: creator.publicKey, stMint: stMint.publicKey, policy });
    send(svm, [cv.ix], [creator, cv.placeholder, stMint]);
    const nftMint = ext.creatorPos.state.nftMint;
    const vaultNft = ataIx(creator.publicKey, nftMint, cv.vault, TOKEN_2022_PROGRAM_ID);
    send(svm, [vaultNft.ix, createTransferCheckedInstruction(ext.creatorPos.nftAccount, nftMint, vaultNft.address, creator.publicKey, 1, 0, [], TOKEN_2022_PROGRAM_ID)], [creator]);
    send(svm, [await client.depositPosition({ vault: cv.vault, depositor: creator.publicKey, streamIndex: 0, dammPool: ext.dammPool, position: ext.creatorPos.position, nftMint, nftAccount: vaultNft.address, baseMint: ext.mint })], [creator]);
    const L = await client.launch({ vault: cv.vault, depositor: creator.publicKey, stMint: stMint.publicKey, config: w.cfgs[1], preset: 1, streamIndex: 1, metadata: { name: "t", symbol: "t", uri: "u" } });
    send(svm, [L.ix], [creator, stMint], { cu: 800_000 });
    // buyers trade the own curve
    const R: BN = dbc.getConfig(svm, w.cfgs[1]).migrationQuoteThreshold;
    const bq = wrapSol(svm, buyer, R.muln(6));
    const bSt = ensureAta(svm, buyer, stMint.publicKey, buyer.publicKey);
    await dbc.buy(svm, buyer, L.pool, bq, bSt, R.divn(2));
    const ownCurve = dbc.getPool(svm, L.pool).creatorQuoteFee;
    const ownPs = dbc.getPool(svm, L.pool);
    const d0 = balance(svm, cv.depositorWsol), i0 = balance(svm, cv.incomeWsol), t0 = balance(svm, treasury);
    send(svm, [await client.harvestDbc({ ...harvestArgs(w, cv, deriveStream(cv.vault, 1)), dbcPool: L.pool, baseVault: ownPs.baseVault, quoteVault: ownPs.quoteVault, baseMint: stMint.publicKey })], [anyone], { label: "harvest_dbc.own" });
    const dep = ownCurve.muln(8).divn(15);
    expect(balance(svm, cv.depositorWsol).sub(d0).toString()).eq(dep.toString());
    expect(balance(svm, cv.incomeWsol).sub(i0).toString()).eq(ownCurve.sub(dep).toString());
    expect(balance(svm, treasury).sub(t0).isZero()).true;
    // external position fees: 1/5 to the treasury
    const pool = damm.getPool(svm, ext.dammPool);
    const bBase = ensureAta(svm, buyer, pool.tokenAMint, buyer.publicKey);
    send(svm, [await damm.swapIx(svm, { pool: ext.dammPool, payer: buyer.publicKey, inputAccount: ext.buyerQuote, outputAccount: bBase, amountIn: new BN(5_000_000_000) })], [buyer]);
    const i1 = balance(svm, cv.incomeWsol), t1 = balance(svm, treasury), d1 = balance(svm, cv.depositorWsol);
    send(svm, [await client.harvestPosition({ ...harvestArgs(w, cv, deriveStream(cv.vault, 0)), dammPool: ext.dammPool, position: ext.creatorPos.position, nftAccount: vaultNft.address, tokenAVault: pool.tokenAVault, tokenBVault: pool.tokenBVault, tokenAMint: pool.tokenAMint })], [anyone], { label: "harvest_position.external" });
    const gotExt = balance(svm, cv.incomeWsol).sub(i1).add(balance(svm, treasury).sub(t1));
    expect(gotExt.gte(new BN(15_999_990)) && gotExt.lte(new BN(16_000_010))).true; // 80% of the claimable half of 1% of 5 SOL
    expect(balance(svm, treasury).sub(t1).toString()).eq(gotExt.divn(5).toString());
    expect(balance(svm, cv.depositorWsol).sub(d1).isZero()).true;
    // own position after the own migration: half to the depositor
    await dbc.buy(svm, buyer, L.pool, bq, bSt, R);
    const mig = await dbc.migrateToDammV2(svm, buyer, L.pool, DAMM_V2_MIGRATION_CONFIG.customizable);
    const mine = damm.findPositionOwnedBy(svm, [mig.firstPosition, mig.secondPosition], cv.vault)!;
    send(svm, [await client.registerOwnPosition({ vault: cv.vault, payer: anyone.publicKey, streamIndex: 2, dbcPool: L.pool, dbcConfig: w.cfgs[1], dammPool: mig.dammPool, position: mine.position, nftAccount: mine.nftAccount })], [anyone]);
    const ownPool = damm.getPool(svm, mig.dammPool);
    const bSt2 = ensureAta(svm, buyer, ownPool.tokenAMint, buyer.publicKey);
    send(svm, [await damm.swapIx(svm, { pool: mig.dammPool, payer: buyer.publicKey, inputAccount: bq, outputAccount: bSt2, amountIn: new BN(5_000_000_000) })], [buyer]);
    const i2 = balance(svm, cv.incomeWsol), d2 = balance(svm, cv.depositorWsol), t2 = balance(svm, treasury);
    send(svm, [await client.harvestPosition({ ...harvestArgs(w, cv, deriveStream(cv.vault, 2)), dammPool: mig.dammPool, position: mine.position, nftAccount: mine.nftAccount, tokenAVault: ownPool.tokenAVault, tokenBVault: ownPool.tokenBVault, tokenAMint: ownPool.tokenAMint })], [anyone], { label: "harvest_position.own" });
    const gotOwn = balance(svm, cv.incomeWsol).sub(i2).add(balance(svm, cv.depositorWsol).sub(d2));
    expect(gotOwn.gte(new BN(15_999_990)) && gotOwn.lte(new BN(16_000_010))).true;
    expect(balance(svm, cv.depositorWsol).sub(d2).toString()).eq(gotOwn.divn(2).toString());
    expect(balance(svm, treasury).sub(t2).isZero()).true;
    // accounting equals the balance deltas across all three harvests
    const v = client.decodeVault(Buffer.from(svm.getAccount(cv.vault)!.data));
    expect(v.accounting.harvestedGross.toString()).eq(ownCurve.add(gotExt).add(gotOwn).toString());
    expect(v.accounting.toDepositor.toString()).eq(dep.add(gotOwn.divn(2)).toString());
    expect(v.accounting.toProtocol.toString()).eq(gotExt.divn(5).toString());
    expect(balance(svm, cv.placeholder.publicKey).isZero()).true;
  });
});
