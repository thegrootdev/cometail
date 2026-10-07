// Gate 20: the burn program. Setup is bound to the program's upgrade authority and pins a constant-fee
// compounding $COMETAIL/SOL pool. Launch configs naming the program's claimer PDA are byte-identical to
// today's presets except the fee claimer, and the launch path (create, trade, fill, migrate) behaves the
// same on them. Every claim (curve fees, creation fee, surplus, graduated position fees) lands in the
// inbox and is split 50/50 to the reserve and the treasury in the same instruction. A buyback spends
// min(reserve, cap), burns exactly what it bought, pays the caller nothing, waits ten minutes, refuses
// dust, refuses a changed pool, and a sandwich around it loses money. Nothing can take the reserve out.
import { BN, BorshCoder, EventParser } from "@coral-xyz/anchor";
import { Keypair, PublicKey, Transaction } from "@solana/web3.js";
import { NATIVE_MINT, createTransferInstruction } from "@solana/spl-token";
import { expect } from "chai";
import { BurnClient, BURN_IDL, BURN_PROGRAM_ID } from "@cometail/client";
import { startSvm, fund, DAMM_V2_MIGRATION_CONFIG } from "../harness/svm";
import { send, expectFail } from "../harness/tx";
import { ensureAta, balance, wrapSol } from "../harness/tokens";
import * as dbc from "../harness/dbc";
import * as damm from "../harness/damm";

const CLAIMER_OFFSET = 40; // PoolConfig.fee_claimer (after the 8-byte discriminator and quote_mint)
const supply = (svm: any, mint: PublicKey) => new BN(Buffer.from(svm.getAccount(mint)!.data).subarray(36, 44), "le");
const lamports = (svm: any, k: PublicKey) => BigInt(svm.getAccount(k)?.lamports ?? 0);
function warp(svm: any, seconds: number) { const c = svm.getClock(); c.unixTimestamp = c.unixTimestamp + BigInt(seconds); svm.setClock(c); }
const parser = new EventParser(BURN_PROGRAM_ID, new BorshCoder(BURN_IDL));
const events = (logs: string[]) => [...parser.parseLogs(logs)];

async function launch(w: any, config: PublicKey, creator: any, fill: boolean, overshoot = 1) {
  const mint = Keypair.generate();
  const L = await dbc.createPoolIx({ config, baseMint: mint.publicKey, quoteMint: NATIVE_MINT, creator: creator.publicKey, payer: creator.publicKey });
  send(w.svm, [L.ix], [creator, mint], { cu: 600_000 });
  const R: BN = dbc.getConfig(w.svm, config).migrationQuoteThreshold;
  const q = wrapSol(w.svm, w.buyer, R.muln(8));
  const b = ensureAta(w.svm, w.buyer, mint.publicKey, w.buyer.publicKey);
  await dbc.buy(w.svm, w.buyer, L.pool, q, b, R.divn(3));
  if (!fill) return { mint: mint.publicKey, pool: L.pool, R };
  // fill past the threshold so the partner has a surplus to withdraw
  await dbc.buy(w.svm, w.buyer, L.pool, q, b, R.muln(overshoot * 6).divn(5));
  const mig = await dbc.migrateToDammV2(w.svm, w.keeper, L.pool, DAMM_V2_MIGRATION_CONFIG.customizable);
  return { mint: mint.publicKey, pool: L.pool, R, dammPool: mig.dammPool, positions: [mig.firstPosition, mig.secondPosition] };
}

async function world() {
  const owner = Keypair.generate();
  const svm = startSvm({ upgradeAuthority: owner.publicKey, burnAuthority: owner.publicKey });
  svm.airdrop(owner.publicKey, BigInt(1_000_000_000_000));
  const w: any = { svm, owner, keeper: fund(svm), creator: fund(svm), buyer: fund(svm, 100_000), anyone: fund(svm), attacker: fund(svm, 100_000) };
  w.client = new BurnClient();
  w.treasury = ensureAta(svm, owner, NATIVE_MINT, owner.publicKey);
  w.legacy = await dbc.createConfig(svm, { payer: owner, feeClaimer: owner.publicKey, leftoverReceiver: owner.publicKey, quoteMint: NATIVE_MINT, params: dbc.configParams("plain") });
  // $COMETAIL: a coin launched on today's Standard preset and graduated (1% constant fee, compounding)
  w.cometail = await launch(w, w.legacy, w.creator, true);
  return w;
}
function state(w: any) { return w.client.decodeState(Buffer.from(w.svm.getAccount(w.client.a.burnState)!.data)); }
async function doSetup(w: any) {
  send(w.svm, [await w.client.setup({ authority: w.owner.publicKey, cometailMint: w.cometail.mint, pool: w.cometail.dammPool, treasury: w.treasury })], [w.owner]);
}
async function buybackIx(w: any) {
  const p = damm.getPool(w.svm, w.cometail.dammPool);
  return w.client.buyback({ state: state(w), tokenAVault: p.tokenAVault, tokenBVault: p.tokenBVault });
}
function fundReserve(w: any, lamportsIn: BN) {
  const src = wrapSol(w.svm, w.owner, lamportsIn);
  send(w.svm, [createTransferInstruction(src, w.client.a.reserve, w.owner.publicKey, BigInt(lamportsIn.toString()))], [w.owner]);
}

describe("gate 20: burn program", () => {
  it("setup: only the upgrade authority, once, and only on a constant >=1% compounding $COMETAIL/SOL pool", async () => {
    const w = await world();
    const p = damm.getPool(w.svm, w.cometail.dammPool);
    expect(p.collectFeeMode).eq(2);
    const fee = Buffer.from(p.poolFees.baseFee.baseFeeInfo.data);
    expect(fee.readBigUInt64LE(0)).eq(10_000_000n);
    expect(fee.subarray(8).every((x: number) => x === 0)).eq(true);
    // a stranger cannot claim the singleton
    expectFail(w.svm, [await w.client.setup({ authority: w.anyone.publicKey, cometailMint: w.cometail.mint, pool: w.cometail.dammPool, treasury: w.treasury })], [w.anyone], "NotUpgradeAuthority");
    // a pool whose fee is below 1% is refused (a copy of the pool with a 0.5% cliff)
    const fake = Keypair.generate().publicKey;
    const raw = Buffer.from(w.svm.getAccount(w.cometail.dammPool)!.data);
    const feeAt = raw.indexOf(fee);
    const bad = Buffer.from(raw); bad.writeBigUInt64LE(5_000_000n, feeAt);
    w.svm.setAccount(fake, { ...w.svm.getAccount(w.cometail.dammPool)!, data: new Uint8Array(bad) });
    expectFail(w.svm, [await w.client.setup({ authority: w.owner.publicKey, cometailMint: w.cometail.mint, pool: fake, treasury: w.treasury })], [w.owner], "PoolNotEligible");
    await doSetup(w);
    const s = state(w);
    expect(s.pool.equals(w.cometail.dammPool)).eq(true);
    expect(s.treasury.equals(w.treasury)).eq(true);
    expect(s.feeNumerator.toString()).eq("10000000");
    w.svm.expireBlockhash();
    expectFail(w.svm, [await w.client.setup({ authority: w.owner.publicKey, cometailMint: w.cometail.mint, pool: w.cometail.dammPool, treasury: w.treasury })], [w.owner], "already in use");
  });

  it("new launch configs: identical to today's preset except the fee claimer; the launch path behaves the same; every claim splits 50/50", async () => {
    const w = await world();
    await doSetup(w);
    const fresh = await dbc.createConfig(w.svm, { payer: w.owner, feeClaimer: w.client.a.claimer, leftoverReceiver: w.owner.publicKey, quoteMint: NATIVE_MINT, params: dbc.configParams("plain") });
    const a = Buffer.from(w.svm.getAccount(w.legacy)!.data), b = Buffer.from(w.svm.getAccount(fresh)!.data);
    expect(a.length).eq(b.length);
    const diff = [...a.keys()].filter((i) => a[i] !== b[i]);
    expect(diff.every((i) => i >= CLAIMER_OFFSET && i < CLAIMER_OFFSET + 32)).eq(true);
    expect(new PublicKey(b.subarray(CLAIMER_OFFSET, CLAIMER_OFFSET + 32)).equals(w.client.a.claimer)).eq(true);

    // the same open launch on both configs, the same buys: the curve states match field for field
    const oldL = await launch(w, w.legacy, w.creator, false), newL = await launch(w, fresh, w.creator, false);
    const po = dbc.getPool(w.svm, oldL.pool), pn = dbc.getPool(w.svm, newL.pool);
    for (const k of ["quoteReserve", "baseReserve", "partnerQuoteFee", "creatorQuoteFee", "protocolQuoteFee", "sqrtPrice"]) expect(pn[k].toString(), k).eq(po[k].toString());

    // curve fees: claimed by anyone through the program, split exactly
    const owed = new BN(pn.partnerQuoteFee.toString());
    expect(owed.gtn(0)).eq(true);
    const r0 = balance(w.svm, w.client.a.reserve), t0 = balance(w.svm, w.treasury);
    const res = send(w.svm, [await w.client.claimCurveFees({ state: state(w), config: fresh, pool: newL.pool, baseVault: pn.baseVault, quoteVault: pn.quoteVault, baseMint: newL.mint })], [w.anyone]);
    const half = owed.divn(2);
    expect(balance(w.svm, w.client.a.reserve).sub(r0).toString()).eq(half.toString());
    expect(balance(w.svm, w.treasury).sub(t0).toString()).eq(owed.sub(half).toString());
    expect(balance(w.svm, w.client.a.inbox).toString()).eq("0");
    const ev = events(res.logs).find((e) => e.name === "FeesSplit")!;
    expect(ev.data.amount.toString()).eq(owed.toString()); expect(ev.data.source).eq(0);
    // nothing left to claim: a second claim moves nothing
    w.svm.expireBlockhash();
    send(w.svm, [await w.client.claimCurveFees({ state: state(w), config: fresh, pool: newL.pool, baseVault: pn.baseVault, quoteVault: pn.quoteVault, baseMint: newL.mint })], [w.anyone]);
    expect(balance(w.svm, w.client.a.reserve).sub(r0).toString()).eq(half.toString());

    // the partner's share of the creation fee
    const r1 = balance(w.svm, w.client.a.reserve), t1 = balance(w.svm, w.treasury);
    const cres = send(w.svm, [await w.client.claimCreationFee({ state: state(w), config: fresh, pool: newL.pool })], [w.anyone]);
    const cev = events(cres.logs).find((e) => e.name === "FeesSplit")!;
    expect(cev.data.source).eq(1);
    expect(cev.data.amount.gtn(0)).eq(true);
    expect(balance(w.svm, w.client.a.reserve).sub(r1).toString()).eq(cev.data.to_reserve.toString());
    expect(balance(w.svm, w.treasury).sub(t1).toString()).eq(cev.data.to_treasury.toString());
    expect(cev.data.to_reserve.toString()).eq(cev.data.amount.divn(2).toString());

    // fill and migrate on the new config (the claimer is a PDA and never signs a migration)
    const L = await launch(w, fresh, w.creator, true, 2);
    const mine = damm.findPositionOwnedBy(w.svm, L.positions!, w.client.a.claimer);
    expect(mine, "partner position held by the claimer").not.eq(null);
    const legacyL = await launch(w, w.legacy, w.creator, true, 2);
    expect(damm.findPositionOwnedBy(w.svm, legacyL.positions!, w.owner.publicKey)).not.eq(null);
    expect(dbc.getPool(w.svm, L.pool).migrationProgress).eq(dbc.getPool(w.svm, legacyL.pool).migrationProgress);

    // surplus: on these presets the curve's last buy stops at the threshold (partial fill), so the
    // partner's share is usually zero; the claim still runs, is marked withdrawn, and anything it pays splits
    const fp = dbc.getPool(w.svm, L.pool);
    const before = balance(w.svm, w.client.a.reserve);
    const sres = send(w.svm, [await w.client.claimSurplus({ state: state(w), config: fresh, pool: L.pool, quoteVault: fp.quoteVault })], [w.anyone]);
    expect(Number(dbc.getPool(w.svm, L.pool).isPartnerWithdrawSurplus)).eq(1);
    const sev = events(sres.logs).find((e) => e.name === "FeesSplit");
    const surplusPaid = sev ? sev.data.amount : new BN(0);
    if (sev) { expect(sev.data.source).eq(2); expect(balance(w.svm, w.client.a.reserve).sub(before).toString()).eq(sev.data.to_reserve.toString()); }
    else expect(balance(w.svm, w.client.a.reserve).sub(before).toString()).eq("0");
    // eslint-disable-next-line no-console
    console.log("      curve ended", fp.quoteReserve.sub(L.R).toString(), "lamports over its threshold; partner surplus paid", surplusPaid.toString());
    // graduated-pool trading, then the partner position's fees
    const dp = damm.getPool(w.svm, L.dammPool!);
    const q = wrapSol(w.svm, w.buyer, new BN(5_000_000_000));
    const coin = ensureAta(w.svm, w.buyer, L.mint, w.buyer.publicKey);
    send(w.svm, [await damm.swapIx(w.svm, { pool: L.dammPool!, payer: w.buyer.publicKey, inputAccount: q, outputAccount: coin, amountIn: new BN(2_000_000_000) })], [w.buyer]);
    const pres = send(w.svm, [await w.client.claimPositionFees({ state: state(w), pool: L.dammPool!, position: mine!.position, positionNftAccount: mine!.nftAccount, tokenAVault: dp.tokenAVault, tokenBVault: dp.tokenBVault, tokenAMint: L.mint })], [w.anyone]);
    const pev = events(pres.logs).find((e) => e.name === "FeesSplit")!;
    expect(pev.data.source).eq(3); expect(pev.data.amount.gtn(0)).eq(true);
    expect(pev.data.to_reserve.add(pev.data.to_treasury).toString()).eq(pev.data.amount.toString());
    expect(balance(w.svm, w.client.a.placeholder).toString()).eq("0");
    const s = state(w);
    expect(s.splitTotal.toString()).eq(owed.add(cev.data.amount).add(surplusPaid).add(pev.data.amount).toString());
    expect(new BN(s.splitToReserve.toString()).add(new BN(s.splitToTreasury.toString())).toString()).eq(s.splitTotal.toString());
    // a position the claimer does not hold is refused before any CPI
    const theirs = damm.findPositionOwnedBy(w.svm, L.positions!, w.creator.publicKey)!;
    expectFail(w.svm, [await w.client.claimPositionFees({ state: state(w), pool: L.dammPool!, position: theirs.position, positionNftAccount: theirs.nftAccount, tokenAVault: dp.tokenAVault, tokenBVault: dp.tokenBVault, tokenAMint: L.mint })], [w.anyone], "NotOurConfig");
  });

  it("buyback: min(reserve, cap), burns exactly what it bought, pays the caller nothing; cooldown; minimum; changed pool refused", async () => {
    const w = await world();
    await doSetup(w);
    fundReserve(w, new BN(3_000_000_000));
    const p0 = damm.getPool(w.svm, w.cometail.dammPool);
    const cap = new BN(p0.tokenBAmount.toString()).muln(10_000_000).div(new BN(1_000_000_000)).divn(5);
    const reserve0 = balance(w.svm, w.client.a.reserve), supply0 = supply(w.svm, w.cometail.mint);
    const callerLamports = lamports(w.svm, w.anyone.publicKey);
    const res = send(w.svm, [await buybackIx(w)], [w.anyone]);
    const ev = events(res.logs).find((e) => e.name === "BuybackBurned")!;
    expect(ev.data.spent.toString()).eq(BN.min(reserve0, cap).toString());
    expect(reserve0.sub(balance(w.svm, w.client.a.reserve)).toString()).eq(ev.data.spent.toString());
    expect(supply0.sub(supply(w.svm, w.cometail.mint)).toString()).eq(ev.data.burned.toString());
    expect(ev.data.burned.toString()).eq(ev.data.received.toString());
    expect(ev.data.received.gte(ev.data.min_out)).eq(true);
    expect(balance(w.svm, w.client.a.bought).toString()).eq("0");
    // the caller paid the network fee and received nothing
    expect(callerLamports - lamports(w.svm, w.anyone.publicKey)).eq(5000n);
    const s = state(w);
    expect(s.spentTotal.toString()).eq(ev.data.spent.toString());
    expect(s.burnedTotal.toString()).eq(ev.data.burned.toString());
    // cooldown: not again within ten minutes, again after
    w.svm.expireBlockhash();
    expectFail(w.svm, [await buybackIx(w)], [w.anyone], "Cooldown");
    warp(w.svm, 599); w.svm.expireBlockhash();
    expectFail(w.svm, [await buybackIx(w)], [w.anyone], "Cooldown");
    warp(w.svm, 1); w.svm.expireBlockhash();
    send(w.svm, [await buybackIx(w)], [w.anyone]);
    // a changed pool fee or compounding share stops buybacks
    warp(w.svm, 600); w.svm.expireBlockhash();
    const acct = w.svm.getAccount(w.cometail.dammPool)!;
    const raw = Buffer.from(acct.data);
    const feeAt = raw.indexOf(Buffer.from(p0.poolFees.baseFee.baseFeeInfo.data));
    const changed = Buffer.from(raw); changed.writeBigUInt64LE(20_000_000n, feeAt);
    w.svm.setAccount(w.cometail.dammPool, { ...acct, data: new Uint8Array(changed) });
    expectFail(w.svm, [await buybackIx(w)], [w.anyone], "PoolChanged");
    w.svm.setAccount(w.cometail.dammPool, acct);
    // drain to below the minimum: refused, and the cooldown does not move
    while (balance(w.svm, w.client.a.reserve).gten(1_000_000)) { w.svm.expireBlockhash(); send(w.svm, [await buybackIx(w)], [w.anyone]); warp(w.svm, 600); }
    const last = state(w).lastBuyTs.toNumber();
    w.svm.expireBlockhash();
    if (balance(w.svm, w.client.a.reserve).gtn(0) || true) expectFail(w.svm, [await buybackIx(w)], [w.anyone], "BelowMinimum");
    expect(state(w).lastBuyTs.toNumber()).eq(last);
  });

  it("a sandwich around one buyback loses money at every size tried", async () => {
    const w = await world();
    await doSetup(w);
    fundReserve(w, new BN(50_000_000_000));
    const p0 = damm.getPool(w.svm, w.cometail.dammPool);
    const B = new BN(p0.tokenBAmount.toString());
    const capLamports = B.muln(10_000_000).div(new BN(1_000_000_000)).divn(5);
    const coin = ensureAta(w.svm, w.attacker, w.cometail.mint, w.attacker.publicKey);
    const sol = wrapSol(w.svm, w.attacker, new BN(20_000_000_000_000));
    const results: string[] = [];
    for (const x of [capLamports.divn(10), capLamports, capLamports.muln(10), B.divn(10), B.divn(2), B.muln(2)]) {
      warp(w.svm, 600); w.svm.expireBlockhash();
      const s0 = balance(w.svm, sol), c0 = balance(w.svm, coin);
      send(w.svm, [await damm.swapIx(w.svm, { pool: w.cometail.dammPool, payer: w.attacker.publicKey, inputAccount: sol, outputAccount: coin, amountIn: x })], [w.attacker]);
      send(w.svm, [await buybackIx(w)], [w.anyone]);
      const got = balance(w.svm, coin).sub(c0);
      send(w.svm, [await damm.swapIx(w.svm, { pool: w.cometail.dammPool, payer: w.attacker.publicKey, inputAccount: coin, outputAccount: sol, amountIn: got })], [w.attacker]);
      const pnl = balance(w.svm, sol).sub(s0);
      results.push(`${x.toString()}:${pnl.toString()}`);
      expect(pnl.ltn(0), `front-run of ${x.toString()} lamports`).eq(true);
    }
    // eslint-disable-next-line no-console
    console.log("      sandwich P&L (lamports in : attacker result)", results.join(" "));
  });

  it("nothing takes the reserve out: no withdraw instruction, the owner cannot move it, buyback outputs are pinned", async () => {
    const w = await world();
    await doSetup(w);
    fundReserve(w, new BN(1_000_000_000));
    const names = (BURN_IDL as any).instructions.map((i: any) => i.name).sort();
    expect(names).deep.eq(["buyback", "claim_creation_fee", "claim_curve_fees", "claim_position_fees", "claim_surplus", "setup", "sweep_inbox"]);
    for (const ix of (BURN_IDL as any).instructions) expect(ix.args.length, ix.name).eq(0);
    const sink = ensureAta(w.svm, w.attacker, NATIVE_MINT, w.attacker.publicKey);
    expectFail(w.svm, [createTransferInstruction(w.client.a.reserve, sink, w.owner.publicKey, 1n)], [w.owner], "owner does not match");
    // a buyback pointed at another output or another pool is refused
    const ix = await buybackIx(w);
    const attackerCoin = ensureAta(w.svm, w.attacker, w.cometail.mint, w.attacker.publicKey);
    const k = ix.keys.findIndex((x) => x.pubkey.equals(w.client.a.bought));
    const swapped = { ...ix, keys: ix.keys.map((x, i) => (i === k ? { ...x, pubkey: attackerCoin } : x)) };
    expectFail(w.svm, [swapped as any], [w.anyone], "AccountMismatch");
    // the inbox only ever splits to the pinned reserve and treasury
    const inboxIx = await w.client.sweepInbox({ state: state(w) });
    const t = inboxIx.keys.findIndex((x) => x.pubkey.equals(w.treasury));
    const redirected = { ...inboxIx, keys: inboxIx.keys.map((x, i) => (i === t ? { ...x, pubkey: sink } : x)) };
    expectFail(w.svm, [redirected as any], [w.anyone], "AccountMismatch");
  });
});
