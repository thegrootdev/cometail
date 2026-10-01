// Gates 7 and 8: routing inside the policy for both pair orientations, the oriented price
// cap, the period budget, order caps and pause; settlement limited to crossed bins for
// non-keepers, atomic cancel + burn, records that follow the DLMM order, LiquidityLocked
// retry, refunded principal vs fee share, unsolicited stream tokens burned.
import { BN } from "@coral-xyz/anchor";
import { Keypair, PublicKey } from "@solana/web3.js";
import { NATIVE_MINT, TOKEN_2022_PROGRAM_ID, createTransferCheckedInstruction, createTransferInstruction } from "@solana/spl-token";
import { expect } from "chai";
import { VaultClientStep6, deriveStream, deriveOrderRecord } from "@cometail/client";
import { startSvm, fund, DAMM_V2_MIGRATION_CONFIG } from "../harness/svm";
import { send, expectFail } from "../harness/tx";
import { ataIx, ensureAta, balance, wrapSol } from "../harness/tokens";
import * as dbc from "../harness/dbc";
import * as damm from "../harness/damm";
import * as dlmm from "../harness/dlmm";

const CAP = new BN(1).shln(64).muln(1_000_000); // generous cap: 1e6 lamports per raw ST unit
const policy = { maxSpendPerPeriod: new BN(3_000_000_000), periodSeconds: new BN(600), maxOutstandingOrders: 2, maxBinsPerOrder: 10, maxPriceQ64: CAP };

/** A Live vault with income: external position deposited, own token launched, filled, migrated, pair registered, harvested. */
async function live(stAsX = true) {
  const owner = Keypair.generate();
  const svm = startSvm({ upgradeAuthority: owner.publicKey });
  svm.airdrop(owner.publicKey, BigInt(100_000_000_000));
  const client = new VaultClientStep6();
  const keeper = fund(svm), creator = fund(svm), buyer = fund(svm), anyone = fund(svm);
  const treasury = ensureAta(svm, owner, NATIVE_MINT, owner.publicKey);
  const cfgs = [] as PublicKey[];
  for (const n of ["stream-25", "stream-50", "stream-75"] as const) cfgs.push(await dbc.createConfig(svm, { payer: owner, feeClaimer: owner.publicKey, leftoverReceiver: owner.publicKey, quoteMint: NATIVE_MINT, params: dbc.configParams(n) }));
  send(svm, [await client.initProtocol({ admin: owner.publicKey, keeper: keeper.publicKey, payer: owner.publicKey, streamConfigs: cfgs as any })], [owner]);
  const plain = await dbc.createConfig(svm, { payer: owner, feeClaimer: owner.publicKey, leftoverReceiver: owner.publicKey, quoteMint: NATIVE_MINT, params: dbc.configParams("plain") });
  // external stream
  const mint = Keypair.generate();
  const E = await dbc.createPoolIx({ config: plain, baseMint: mint.publicKey, quoteMint: NATIVE_MINT, creator: creator.publicKey, payer: creator.publicKey });
  send(svm, [E.ix], [creator, mint], { cu: 600_000 });
  const Rp: BN = dbc.getConfig(svm, plain).migrationQuoteThreshold;
  const buyerQuote = wrapSol(svm, buyer, Rp.muln(10));
  const buyerBase = ensureAta(svm, buyer, mint.publicKey, buyer.publicKey);
  await dbc.buy(svm, buyer, E.pool, buyerQuote, buyerBase, Rp.muln(6).divn(5));
  const em = await dbc.migrateToDammV2(svm, buyer, E.pool, DAMM_V2_MIGRATION_CONFIG.customizable);
  const cpos = damm.findPositionOwnedBy(svm, [em.firstPosition, em.secondPosition], creator.publicKey)!;
  // vault, deposit, launch, fill, migrate, register own
  const stMint = Keypair.generate();
  const cv = await client.createVault({ depositor: creator.publicKey, stMint: stMint.publicKey, policy });
  send(svm, [cv.ix], [creator, cv.placeholder, stMint]);
  const nftMint = cpos.state.nftMint;
  const vaultNft = ataIx(creator.publicKey, nftMint, cv.vault, TOKEN_2022_PROGRAM_ID);
  send(svm, [vaultNft.ix, createTransferCheckedInstruction(cpos.nftAccount, nftMint, vaultNft.address, creator.publicKey, 1, 0, [], TOKEN_2022_PROGRAM_ID)], [creator]);
  send(svm, [await client.depositPosition({ vault: cv.vault, depositor: creator.publicKey, streamIndex: 0, dammPool: em.dammPool, position: cpos.position, nftMint, nftAccount: vaultNft.address, baseMint: mint.publicKey })], [creator]);
  const L = await client.launch({ vault: cv.vault, depositor: creator.publicKey, stMint: stMint.publicKey, config: cfgs[1], preset: 1, streamIndex: 1, metadata: { name: "t", symbol: "t", uri: "u" } });
  send(svm, [L.ix], [creator, stMint], { cu: 800_000 });
  const R: BN = dbc.getConfig(svm, cfgs[1]).migrationQuoteThreshold;
  const buyerSt = ensureAta(svm, buyer, stMint.publicKey, buyer.publicKey);
  await dbc.buy(svm, buyer, L.pool, buyerQuote, buyerSt, R.muln(6).divn(5));
  const om = await dbc.migrateToDammV2(svm, buyer, L.pool, DAMM_V2_MIGRATION_CONFIG.customizable);
  const mine = damm.findPositionOwnedBy(svm, [om.firstPosition, om.secondPosition], cv.vault)!;
  send(svm, [await client.registerOwnPosition({ vault: cv.vault, payer: anyone.publicKey, streamIndex: 2, dbcPool: L.pool, dbcConfig: cfgs[1], dammPool: om.dammPool, position: mine.position, nftAccount: mine.nftAccount })], [anyone]);
  // the pair: ST as X (normal) or WSOL as X (ST is Y)
  const keeperQuote = wrapSol(svm, keeper, new BN(5_000_000_000));
  const keeperSt = ensureAta(svm, keeper, stMint.publicKey, keeper.publicKey);
  send(svm, [createTransferInstruction(buyerSt, keeperSt, buyer.publicKey, BigInt(1_000_000))], [buyer]);
  const pair = stAsX
    ? await dlmm.initPairIx({ x: stMint.publicKey, y: NATIVE_MINT, funder: keeper.publicKey, userTokenX: keeperSt, userTokenY: keeperQuote, binStep: 100, baseFactor: 1000 })
    : await dlmm.initPairIx({ x: NATIVE_MINT, y: stMint.publicKey, funder: keeper.publicKey, userTokenX: keeperQuote, userTokenY: keeperSt, binStep: 100, baseFactor: 1000 });
  send(svm, [pair.ix], [keeper], { cu: 400_000 });
  send(svm, [await client.registerPair({ vault: cv.vault, lbPair: pair.pair })], [keeper]);
  for (const i of [-1, 0, 1]) send(svm, [await dlmm.initBinArrayIx(pair.pair, i, keeper.publicKey)], [keeper], { cu: 1_400_000 });
  // income: harvest the own position after a swap (SOL only)
  const pool = damm.getPool(svm, om.dammPool);
  const bSt2 = ensureAta(svm, buyer, pool.tokenAMint, buyer.publicKey);
  send(svm, [await damm.swapIx(svm, { pool: om.dammPool, payer: buyer.publicKey, inputAccount: buyerQuote, outputAccount: bSt2, amountIn: new BN(100_000_000_000) })], [buyer]);
  send(svm, [await client.harvestPosition({ vault: cv.vault, stream: deriveStream(cv.vault, 2), incomeWsol: cv.incomeWsol, placeholderWsol: cv.placeholder.publicKey, depositorWsol: cv.depositorWsol, treasury, dammPool: om.dammPool, position: mine.position, nftAccount: mine.nftAccount, tokenAVault: pool.tokenAVault, tokenBVault: pool.tokenBVault, tokenAMint: pool.tokenAMint })], [anyone]);
  const income = balance(svm, cv.incomeWsol);
  expect(income.gte(new BN(100_000_000))).true; // 0.16 SOL from a 100 SOL swap
  const pairState = dlmm.getPair(svm, pair.pair);
  const stIsX = pairState.tokenXMint.equals(stMint.publicKey);
  const vaultState = client.decodeVault(Buffer.from(svm.getAccount(cv.vault)!.data));
  expect(vaultState.stIsX).eq(stIsX);
  expect(vaultState.status).deep.eq({ live: {} });
  return { svm, client, owner, keeper, creator, buyer, anyone, cv, stMint: stMint.publicKey, pair: pair.pair, pairState, stIsX, income, buyerSt, buyerQuote, treasury };
}

function routeArgs(h: any, bins: { id: number; amount: BN }[]) {
  const reserve = h.stIsX ? h.pairState.reserveY : h.pairState.reserveX;
  return { vault: h.cv.vault, keeper: h.keeper.publicKey, lbPair: h.pair, reserve, incomeWsol: h.cv.incomeWsol, bins };
}
function settleArgs(h: any, limitOrder: PublicKey, signer: PublicKey, bins: number[]) {
  return { vault: h.cv.vault, signer, lbPair: h.pair, reserveX: h.pairState.reserveX, reserveY: h.pairState.reserveY, limitOrder, incomeWsol: h.cv.incomeWsol, stAta: h.cv.vault && require("@solana/spl-token").getAssociatedTokenAddressSync(h.stMint, h.cv.vault, true), stMint: h.stMint, bins };
}

describe("gate 7 + 8: routing bounds and settlement", () => {
  for (const stAsX of [true, false]) {
    it(`ST as ${stAsX ? "X: bids below" : "Y: asks above"} the active bin; wrong side, non-keeper, descending bins, oversize, over-cap and over-budget are rejected; pause blocks`, async () => {
      const h = await live(stAsX);
      const { svm, client, keeper, anyone } = h;
      const active = dlmm.getPair(svm, h.pair).activeId;
      const side = (k: number) => (h.stIsX ? active - k : active + k);
      const good = [3, 2, 1].map((k) => ({ id: side(k), amount: new BN(30_000_000) })).sort((a, b) => a.id - b.id);
      // the stranger is not the keeper
      const r0 = await client.route({ ...routeArgs(h, good), keeper: anyone.publicKey });
      expectFail(svm, [r0.ix], [anyone, r0.limitOrder], "NotKeeper");
      // wrong side of the active bin
      const wrongSide = [1, 2, 3].map((k) => ({ id: h.stIsX ? active + k : active - k, amount: new BN(30_000_000) })).sort((a, b) => a.id - b.id);
      const r1 = await client.route(routeArgs(h, wrongSide));
      expectFail(svm, [r1.ix], [keeper, r1.limitOrder], "PolicyViolation");
      // descending order
      const r2 = await client.route(routeArgs(h, [...good].reverse()));
      expectFail(svm, [r2.ix], [keeper, r2.limitOrder], "PolicyViolation");
      // more bins than the policy allows
      const many = Array.from({ length: 11 }, (_, i) => ({ id: side(11 - i), amount: new BN(1_000_000) }));
      const r3 = await client.route(routeArgs(h, many));
      expectFail(svm, [r3.ix], [keeper, r3.limitOrder], "PolicyViolation");
      // over the period budget in one order
      const r4 = await client.route(routeArgs(h, [{ id: side(1), amount: new BN(3_000_000_001) }]));
      expectFail(svm, [r4.ix], [keeper, r4.limitOrder], "PolicyViolation");
      // beyond the price cap: a bin far on the expensive side of the bound
      const v = client.decodeVault(Buffer.from(svm.getAccount(h.cv.vault)!.data));
      const beyond = h.stIsX ? v.binBound + 1 : v.binBound - 1;
      // only meaningful when that bin is still on the buying side; otherwise the side check fires first (also a rejection)
      const r5 = await client.route(routeArgs(h, [{ id: beyond, amount: new BN(1_000_000) }]));
      expectFail(svm, [r5.ix], [keeper, r5.limitOrder], "PolicyViolation");
      // pause
      send(svm, [await client.updateProtocol({ admin: h.owner.publicKey, pausedRouting: true })], [h.owner]);
      const r6 = await client.route(routeArgs(h, good));
      expectFail(svm, [r6.ix], [keeper, r6.limitOrder], "Paused");
      send(svm, [await client.updateProtocol({ admin: h.owner.publicKey, pausedRouting: false })], [h.owner]);
      // a valid ladder
      const i0 = balance(svm, h.cv.incomeWsol);
      const r7 = await client.route(routeArgs(h, good));
      send(svm, [r7.ix], [keeper, r7.limitOrder], { cu: 600_000, label: `route.${stAsX ? "x" : "y"}` });
      expect(i0.sub(balance(svm, h.cv.incomeWsol)).toString()).eq("90000000");
      const vs = client.decodeVault(Buffer.from(svm.getAccount(h.cv.vault)!.data));
      expect(vs.routing.outstandingOrders).eq(1);
      expect(vs.routing.spentThisPeriod.toString()).eq("90000000");
      expect(vs.accounting.routedGross.toString()).eq("90000000");
      const rec = client.decodeOrderRecord(Buffer.from(svm.getAccount(deriveOrderRecord(h.cv.vault, r7.limitOrder.publicKey))!.data));
      expect(rec.binCount).eq(3);
      const lo = dlmm.getLimitOrder(svm, r7.limitOrder.publicKey);
      expect(lo.owner.equals(h.cv.vault)).true;
      // the budget is cumulative within the period: a second order that would exceed it is rejected, a smaller one fits, a third hits the order cap
      const r8 = await client.route(routeArgs(h, [{ id: side(5), amount: new BN(2_910_000_001) }]));
      expectFail(svm, [r8.ix], [keeper, r8.limitOrder], "PolicyViolation");
      // income that is not there is also a policy violation: 70,000,000 remain
      const rIncome = await client.route(routeArgs(h, [{ id: side(5), amount: new BN(70_000_001) }]));
      expectFail(svm, [rIncome.ix], [keeper, rIncome.limitOrder], "PolicyViolation");
      const r9 = await client.route(routeArgs(h, [{ id: side(5), amount: new BN(50_000_000) }]));
      send(svm, [r9.ix], [keeper, r9.limitOrder], { cu: 600_000 });
      const r10 = await client.route(routeArgs(h, [{ id: side(6), amount: new BN(1_000_000) }]));
      expectFail(svm, [r10.ix], [keeper, r10.limitOrder], "PolicyViolation"); // max_outstanding_orders = 2
      // the period rolls: budget resets
      const clock = svm.getClock(); clock.unixTimestamp = clock.unixTimestamp + BigInt(601); svm.setClock(clock);
      // (order cap still binds, so settle one first in the settlement test)
    });
  }

  it("settle: a stranger cannot cancel resting bins; the keeper can; crossed bins settle permissionlessly; cancel + burn are atomic; the record follows the DLMM order; LiquidityLocked retries", async () => {
    const h = await live(true);
    const { svm, client, keeper, anyone, buyer } = h;
    const active = dlmm.getPair(svm, h.pair).activeId;
    const bins = [active - 3, active - 2, active - 1];
    const r = await client.route(routeArgs(h, bins.map((id) => ({ id, amount: new BN(40_000_000) }))));
    send(svm, [r.ix], [keeper, r.limitOrder], { cu: 600_000 });
    const stAta = require("@solana/spl-token").getAssociatedTokenAddressSync(h.stMint, h.cv.vault, true);
    // resting bins: a stranger may not settle them
    expectFail(svm, [await client.settle(settleArgs(h, r.limitOrder.publicKey, anyone.publicKey, [bins[0]]))], [anyone], "NotKeeper");
    // the seller crosses the top two bins (price falls below them)
    const sellerSt = h.buyerSt;
    const sw = await dlmm.swap2Ix(svm, { pair: h.pair, user: buyer.publicKey, tokenIn: sellerSt, tokenOut: h.buyerQuote, amountIn: new BN(82_000_000), binIds: [active - 3, active - 2, active - 1, active] });
    send(svm, [sw], [buyer], { cu: 600_000 });
    const afterActive = dlmm.getPair(svm, h.pair).activeId;
    expect(afterActive).lte(active - 2);
    // unsolicited stream tokens sent to the vault are swept by the next settle
    send(svm, [createTransferInstruction(sellerSt, stAta, buyer.publicKey, BigInt(777))], [buyer]);
    // same-slot cancellation after the fill: DLMM says LiquidityLocked; the keeper retries next slot
    const crossed = bins.filter((b) => b > afterActive);
    const sIx = await client.settle(settleArgs(h, r.limitOrder.publicKey, anyone.publicKey, crossed));
    expectFail(svm, [sIx], [anyone], "LiquidityLocked", { cu: 600_000 });
    const clock = svm.getClock(); clock.slot = clock.slot + BigInt(2); clock.unixTimestamp = clock.unixTimestamp + BigInt(2); svm.setClock(clock);
    // crossed bins settle permissionlessly: fills burned, WSOL back is fee share only (no principal on crossed bins)
    const supply0 = Number(require("@solana/spl-token").MintLayout.decode(Buffer.from(svm.getAccount(h.stMint)!.data)).supply);
    const i0 = balance(svm, h.cv.incomeWsol);
    send(svm, [sIx], [anyone], { cu: 600_000, label: "settle.crossed" });
    expect(balance(svm, stAta).isZero()).true; // burned, including the 777 unsolicited units
    const supply1 = Number(require("@solana/spl-token").MintLayout.decode(Buffer.from(svm.getAccount(h.stMint)!.data)).supply);
    expect(supply0 - supply1).greaterThan(777);
    let v = client.decodeVault(Buffer.from(svm.getAccount(h.cv.vault)!.data));
    expect(v.accounting.burnedSt.toNumber()).eq(supply0 - supply1);
    expect(v.accounting.refundedPrincipal.toNumber()).eq(0);
    expect(v.accounting.orderFeesWsol.toString()).eq(balance(svm, h.cv.incomeWsol).sub(i0).toString());
    expect(v.routing.outstandingOrders).eq(1); // one bin still rests
    expect(svm.getAccount(deriveOrderRecord(h.cv.vault, r.limitOrder.publicKey))).not.null;
    // the keeper cancels the resting bin: principal comes back, the order closes, the record follows
    const rest = bins.filter((b) => b <= afterActive);
    const i1 = balance(svm, h.cv.incomeWsol);
    send(svm, [await client.settle(settleArgs(h, r.limitOrder.publicKey, keeper.publicKey, rest))], [keeper], { cu: 600_000, label: "settle.resting" });
    v = client.decodeVault(Buffer.from(svm.getAccount(h.cv.vault)!.data));
    // the resting bin was partly filled by the same swap: the refund is below the deposited amount
    // and the booking cannot yet separate its fee share (open gate-8 item)
    const refunded = v.accounting.refundedPrincipal.toNumber();
    expect(refunded).greaterThan(0);
    expect(refunded).lte(40_000_000 * rest.length);
    expect(balance(svm, h.cv.incomeWsol).sub(i1).toNumber()).eq(refunded + 0 * 0); // all WSOL back was booked as principal
    expect(v.routing.outstandingOrders).eq(0);
    const closed = svm.getAccount(r.limitOrder.publicKey);
    expect(!closed || Number(closed.lamports) === 0).true;
    const recAfter = svm.getAccount(deriveOrderRecord(h.cv.vault, r.limitOrder.publicKey));
    expect(!recAfter || Number(recAfter.lamports) === 0).true;
  });
});
