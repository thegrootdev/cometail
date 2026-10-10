// Gate 23: coins paired with $COMETAIL. A DBC config whose quote is $COMETAIL (configs/paired.json, the
// stock-usdc economics with the market caps in $COMETAIL); the site's own builders (web/src/lib/paired.ts,
// protocol-fees.ts) run here against the live Meteora binaries through a LiteSVM-backed connection:
//   - a buy pays SOL: one transaction buys exactly the $COMETAIL the curve takes on $COMETAIL's pool, for at most
//     the SOL typed, then buys the coin; nothing is left in $COMETAIL; a moved $COMETAIL price fails both legs;
//   - a sell returns SOL (the slippage margin stays as $COMETAIL) or keeps $COMETAIL;
//   - the curve fills and migrates into a coin/$COMETAIL DAMM v2 pool (token B $COMETAIL, all LP locked), where the
//     same builders trade;
//   - creator fees are paid in $COMETAIL; a protocol claim burns exactly half of what it pays from the claimer's
//     $COMETAIL account in the same transaction (curve fees exactly; a graduated position's fees as measured), and
//     the other half stays there.
import { BN } from "@coral-xyz/anchor";
import { Keypair, PublicKey, SystemProgram } from "@solana/web3.js";
import { NATIVE_MINT, createAssociatedTokenAccountIdempotentInstruction, createSyncNativeInstruction, getAssociatedTokenAddressSync } from "@solana/spl-token";
import { DEAD_LIQUIDITY } from "@meteora-ag/cp-amm-sdk";
import { expect } from "chai";
import { startSvm, fund, DAMM_V2_MIGRATION_CONFIG } from "../harness/svm";
import { send, expectFail, measurements } from "../harness/tx";
import { Transaction } from "@solana/web3.js";
import { ensureAta, balance, wrapSol } from "../harness/tokens";
import { svmConnection } from "../harness/conn";
import * as dbc from "../harness/dbc";
import * as damm from "../harness/damm";

const supply = (svm: any, mint: PublicKey) => BigInt(new BN(Buffer.from(svm.getAccount(mint)!.data).subarray(36, 44), "le").toString());
const lamports = (svm: any, k: PublicKey) => BigInt(svm.getAccount(k)?.lamports ?? 0);
const tokens = (svm: any, mint: PublicKey, owner: PublicKey) => BigInt(balance(svm, getAssociatedTokenAddressSync(mint, owner)).toString());

let w: any;
let paired: typeof import("../../web/src/lib/paired");
let fees: typeof import("../../web/src/lib/protocol-fees");
let dbcLib: typeof import("../../web/src/lib/dbc");

async function graduate(svm: any, config: PublicKey, creator: Keypair, buyer: Keypair, quote: PublicKey) {
  const mint = Keypair.generate();
  const L = await dbc.createPoolIx({ config, baseMint: mint.publicKey, quoteMint: quote, creator: creator.publicKey, payer: creator.publicKey });
  send(svm, [L.ix], [creator, mint], { cu: 600_000 });
  const R: BN = dbc.getConfig(svm, config).migrationQuoteThreshold;
  const q = wrapSol(svm, buyer, R.muln(3));
  const b = ensureAta(svm, buyer, mint.publicKey, buyer.publicKey);
  await dbc.buy(svm, buyer, L.pool, q, b, R.muln(2));
  const mig = await dbc.migrateToDammV2(svm, creator, L.pool, DAMM_V2_MIGRATION_CONFIG.customizable);
  return { mint: mint.publicKey, pool: L.pool, dammPool: mig.dammPool };
}

before(async () => {
  const owner = Keypair.generate();
  const svm = startSvm({ withVaultProgram: false });
  svm.airdrop(owner.publicKey, BigInt(1_000_000_000_000));
  w = { svm, owner, creator: fund(svm), buyer: fund(svm, 100_000), other: fund(svm, 100_000), treasury: fund(svm), keeper: fund(svm) };
  // $COMETAIL: a coin graduated from today's Standard preset into a 1% compounding $COMETAIL/SOL pool
  const legacy = await dbc.createConfig(svm, { payer: owner, feeClaimer: owner.publicKey, leftoverReceiver: owner.publicKey, quoteMint: NATIVE_MINT, params: dbc.configParams("plain") });
  w.cometail = await graduate(svm, legacy, w.creator, w.other, NATIVE_MINT);
  w.paired = await dbc.createConfig(svm, { payer: owner, feeClaimer: w.treasury.publicKey, leftoverReceiver: w.treasury.publicKey, quoteMint: w.cometail.mint, params: dbc.configParams("paired") });
  process.env.NEXT_PUBLIC_OFFICIAL_MINT = w.cometail.mint.toBase58();
  process.env.NEXT_PUBLIC_COMETAIL_POOL = w.cometail.dammPool.toBase58();
  process.env.NEXT_PUBLIC_PAIRED_CONFIG = w.paired.toBase58();
  paired = await import("../../web/src/lib/paired");
  fees = await import("../../web/src/lib/protocol-fees");
  dbcLib = await import("../../web/src/lib/dbc");
  w.conn = svmConnection(svm);
  const mint = Keypair.generate();
  const L = await dbc.createPoolIx({ config: w.paired, baseMint: mint.publicKey, quoteMint: w.cometail.mint, creator: w.creator.publicKey, payer: w.creator.publicKey, name: "Paired", symbol: "PAIR" });
  send(svm, [L.ix], [w.creator, mint], { cu: 600_000, label: "paired: create pool" });
  w.coin = { mint: mint.publicKey, pool: L.pool };
});
const curve = async () => ({ kind: "curve" as const, view: (await dbcLib.loadPool(w.conn, w.coin.pool))! });

after(() => { for (const m of measurements.filter((x) => x.label.startsWith("paired"))) console.log(`      ${m.label}: ${m.bytes} bytes, ${m.computeUnits} CU`); });
describe("gate 23: coins paired with $COMETAIL", () => {
  it("the config: quote $COMETAIL, fees in the quote, 75% creator, compounding 1% pool on graduation, all LP locked", () => {
    const c = dbc.getConfig(w.svm, w.paired);
    expect(c.quoteMint.toBase58()).eq(w.cometail.mint.toBase58());
    expect(c.feeClaimer.toBase58()).eq(w.treasury.publicKey.toBase58());
    expect(Number(c.collectFeeMode)).eq(0);
    expect(Number(c.creatorTradingFeePercentage)).eq(75);
    expect(Number(c.migrationOption)).eq(1);
    expect(Number(c.migrationFeeOption)).eq(6);
    expect(Number(c.partnerPermanentLockedLiquidityPercentage) + Number(c.creatorPermanentLockedLiquidityPercentage)).eq(100);
    // the raise in $COMETAIL (6 decimals): about 131M at 75M -> 450M market cap
    const R = BigInt(c.migrationQuoteThreshold.toString());
    expect(R > 120_000_000_000_000n && R < 140_000_000_000_000n, R.toString()).eq(true);
  });

  it("a launch with a first buy paid in SOL: $COMETAIL bought and the pool created with that buy, measured for one transaction", async () => {
    const mint = Keypair.generate();
    const swap = await paired.cometailForSol(w.conn, w.creator.publicKey, new BN(500_000_000));
    const launch = await dbcLib.launchTx(w.conn, { payer: w.creator.publicKey, baseMint: mint.publicKey, name: "Paired launch", symbol: "PLNCH", uri: "https://cometail.fun/api/metadata?id=0123456789abcdef", firstBuyRaw: swap.cometail, config: w.paired, quoteMint: w.cometail.mint, quoteDecimals: 6 });
    const all = [...swap.instructions, ...launch.instructions];
    const tx = new Transaction().add(...all); tx.feePayer = w.creator.publicKey; tx.recentBlockhash = w.svm.latestBlockhash();
    const bytes = 1 + 64 * 2 + tx.serializeMessage().length;
    w.launchBytes = bytes;
    if (bytes <= 1232) {
      send(w.svm, all, [w.creator, mint], { cu: 800_000, label: "paired: launch with a SOL first buy" });
      expect(tokens(w.svm, w.cometail.mint, w.creator.publicKey)).eq(0n);
    } else {
      // too large for one transaction: the $COMETAIL is bought first, then the launch spends exactly that
      send(w.svm, swap.instructions, [w.creator], { cu: 300_000, label: "paired: launch step 1, SOL -> $COMETAIL" });
      send(w.svm, launch.instructions, [w.creator, mint], { cu: 800_000, label: "paired: launch step 2, create + first buy" });
      expect(tokens(w.svm, w.cometail.mint, w.creator.publicKey)).eq(0n);
    }
    console.log(`      launch with a SOL first buy: ${bytes} bytes in one transaction${bytes > 1232 ? " (over 1232: two transactions)" : ""}`);
  });

  it("a buy pays SOL: one transaction, exactly the $COMETAIL the curve takes, at most the SOL typed, nothing left in $COMETAIL", async () => {
    const before = lamports(w.svm, w.buyer.publicKey);
    const solIn = new BN(2_000_000_000);
    const plan = await paired.pairedBuy(w.conn, w.buyer.publicKey, await curve(), solIn);
    const r = send(w.svm, plan.instructions, [w.buyer], { cu: 400_000, label: "paired: buy (SOL -> $COMETAIL -> coin)" });
    expect(r.bytes).lte(1232);
    expect(tokens(w.svm, w.cometail.mint, w.buyer.publicKey)).eq(0n);
    expect(tokens(w.svm, w.coin.mint, w.buyer.publicKey) >= BigInt(plan.coinMinOut!.toString())).eq(true);
    const spent = before - lamports(w.svm, w.buyer.publicKey);
    // at most the SOL typed, plus the fee and the rent of the two new token accounts (the WSOL account is closed)
    expect(spent <= 2_000_000_000n + 2n * 2_039_280n + 10_000n, spent.toString()).eq(true);
    // the curve's $COMETAIL vault took exactly what was bought (reserve plus the 1% fee)
    expect(BigInt(balance(w.svm, dbc.getPool(w.svm, w.coin.pool).quoteVault).toString())).eq(BigInt(plan.cometail.toString()));
  });

  it("a moved $COMETAIL price fails the whole transaction: neither leg happens", async () => {
    const plan = await paired.pairedBuy(w.conn, w.buyer.publicKey, await curve(), new BN(1_000_000_000));
    // someone buys $COMETAIL first, moving its price by more than the 1% margin
    const sol = wrapSol(w.svm, w.other, new BN(10_000_000_000));
    const c = ensureAta(w.svm, w.other, w.cometail.mint, w.other.publicKey);
    send(w.svm, [await damm.swapIx(w.svm, { pool: w.cometail.dammPool, payer: w.other.publicKey, inputAccount: sol, outputAccount: c, amountIn: new BN(10_000_000_000) })], [w.other]);
    const coinBefore = tokens(w.svm, w.coin.mint, w.buyer.publicKey), reserveBefore = dbc.getPool(w.svm, w.coin.pool).quoteReserve.toString();
    expectFail(w.svm, plan.instructions, [w.buyer], "", { cu: 400_000 });
    expect(tokens(w.svm, w.coin.mint, w.buyer.publicKey)).eq(coinBefore);
    expect(dbc.getPool(w.svm, w.coin.pool).quoteReserve.toString()).eq(reserveBefore);
    expect(tokens(w.svm, w.cometail.mint, w.buyer.publicKey)).eq(0n);
  });

  it("a sell returns SOL in one transaction (the slippage margin stays as $COMETAIL), or keeps $COMETAIL", async () => {
    const held = tokens(w.svm, w.coin.mint, w.buyer.publicKey);
    const solBefore = lamports(w.svm, w.buyer.publicKey);
    const plan = await paired.pairedSell(w.conn, w.buyer.publicKey, await curve(), new BN((held / 4n).toString()), true);
    // each bound is 1% below its quote (DAMM v2's getQuote2 takes basis points; a percentage there would be 0.01%)
    const near = (min: any, out: any) => { const m = BigInt(min.toString()), o = BigInt(out.toString()); return m * 10_000n >= o * 9_890n && m * 10_000n <= o * 9_910n; };
    expect(near(plan.cometailMinOut, plan.cometailOut), "curve leg").eq(true);
    expect(near(plan.solMinOut, plan.solOut), "SOL leg").eq(true);
    const r = send(w.svm, plan.instructions, [w.buyer], { cu: 400_000, label: "paired: sell (coin -> $COMETAIL -> SOL)" });
    expect(r.bytes).lte(1232);
    expect(lamports(w.svm, w.buyer.publicKey) - solBefore + 10_000n >= BigInt(plan.solMinOut!.toString())).eq(true);
    const kept = tokens(w.svm, w.cometail.mint, w.buyer.publicKey);
    expect(kept).eq(BigInt(plan.cometailOut!.sub(plan.cometail).toString()));
    expect(kept <= BigInt(plan.cometailKept.toString())).eq(true);
    const keep = await paired.pairedSell(w.conn, w.buyer.publicKey, await curve(), new BN((held / 4n).toString()), false);
    send(w.svm, keep.instructions, [w.buyer], { cu: 400_000, label: "paired: sell (coin -> $COMETAIL)" });
    expect(tokens(w.svm, w.cometail.mint, w.buyer.publicKey) - kept).eq(BigInt(keep.cometailOut!.toString()));
  });

  it("creator fees are paid in $COMETAIL; a curve fee claim burns exactly half of what it pays, the other half stays with the claimer", async () => {
    const creatorFee = BigInt(dbc.getPool(w.svm, w.coin.pool).creatorQuoteFee.toString());
    expect(creatorFee > 0n).eq(true);
    const tx = await dbcLib.claimCreatorFeesTx(w.conn, w.coin.pool, w.creator.publicKey);
    send(w.svm, tx.instructions, [w.creator]);
    expect(tokens(w.svm, w.cometail.mint, w.creator.publicKey)).eq(creatorFee);

    const p = dbc.getPool(w.svm, w.coin.pool);
    const partner = BigInt(p.partnerQuoteFee.toString());
    expect(partner > 0n).eq(true);
    const claim: any = { id: "fee", kind: "dbc-partner-fee", configLabel: "paired", config: w.paired, pool: w.coin.pool, baseMint: w.coin.mint, claimer: w.treasury.publicKey, quoteMint: w.cometail.mint, quoteDecimals: 6, amountQuote: partner, amountBase: 0n, destination: getAssociatedTokenAddressSync(w.cometail.mint, w.treasury.publicKey), destinationExists: false };
    const supplyBefore = supply(w.svm, w.cometail.mint);
    const built = await fees.buildPairedClaim(w.conn, claim, { status: "absent" });
    send(w.svm, built.instructions, [w.treasury, ...built.signers], { label: "paired: protocol claim + burn half" });
    expect(built.pairedBurn).to.deep.include({ claimed: partner, burned: partner / 2n, kept: partner - partner / 2n, exact: true });
    expect(supplyBefore - supply(w.svm, w.cometail.mint)).eq(partner / 2n);
    expect(tokens(w.svm, w.cometail.mint, w.treasury.publicKey)).eq(partner - partner / 2n);
    expect(w.svm.getAccount(built.signers[0].publicKey)?.lamports ?? 0, "the fresh account is closed").eq(0);
    w.staleCurveClaim = { claim, built };
  });

  it("a stale paired claim (replayed, or built from an old scan) fails whole: it never burns the treasury's own $COMETAIL", async () => {
    const { claim, built } = w.staleCurveClaim;
    // a little new fee so the pool still has something to pay, but less than the stale amount
    const small = await paired.pairedBuy(w.conn, w.buyer.publicKey, await curve(), new BN(10_000_000));
    send(w.svm, small.instructions, [w.buyer], { cu: 400_000 });
    const snap = () => ({ supply: supply(w.svm, w.cometail.mint), treasury: tokens(w.svm, w.cometail.mint, w.treasury.publicKey) });
    const before = snap();
    // the very transaction again with a fresh blockhash (its fresh account was closed, so it can be created again)
    expectFail(w.svm, built.instructions, [w.treasury, ...built.signers], "", { cu: 400_000 });
    // a new build from the old scan (the claim object still carries the old amount)
    const again = await fees.buildPairedClaim(w.conn, claim, { status: "absent" });
    expectFail(w.svm, again.instructions, [w.treasury, ...again.signers], "", { cu: 400_000 });
    expect(snap()).to.deep.eq(before);
    // a fresh scan claims what is there now, and burns exactly half of that
    const owed = BigInt(dbc.getPool(w.svm, w.coin.pool).partnerQuoteFee.toString());
    const fresh = await fees.buildPairedClaim(w.conn, { ...claim, amountQuote: owed }, { status: "absent" });
    send(w.svm, fresh.instructions, [w.treasury, ...fresh.signers], { cu: 400_000 });
    expect(before.supply - supply(w.svm, w.cometail.mint)).eq(owed / 2n);
    expect(tokens(w.svm, w.cometail.mint, w.treasury.publicKey) - before.treasury).eq(owed - owed / 2n);
  });

  it("the curve fills from SOL buys and migrates into a coin/$COMETAIL DAMM v2 pool with all liquidity locked; the builders trade there", async () => {
    // big SOL buys until the curve completes (each a single paired transaction)
    const remaining = () => BigInt(dbc.getConfig(w.svm, w.paired).migrationQuoteThreshold.toString()) - BigInt(dbc.getPool(w.svm, w.coin.pool).quoteReserve.toString());
    let completing: any = null;
    for (let i = 0; i < 40 && Number(dbc.getPool(w.svm, w.coin.pool).migrationProgress) === 0; i++) {
      const plan = await paired.pairedBuy(w.conn, w.other.publicKey, await curve(), new BN(5_000_000_000));
      if (plan.nearCompletion && !completing) {
        // a buy close to completion is flagged; and when another buy lands first, the curve takes less of it and the
        // rest stays in the buyer's wallet as $COMETAIL, as the site says
        // the competitor already holds $COMETAIL (bought before this plan was built) and buys half of what the curve
        // still takes straight from the curve, so $COMETAIL's own price is unchanged when the flagged buy lands
        const half = new BN((remaining() / 2n).toString());
        // (the paired buys closed the buyer's WSOL account; LiteSVM keeps an empty system account there, so it is made here)
        const sol = getAssociatedTokenAddressSync(NATIVE_MINT, w.buyer.publicKey);
        send(w.svm, [createAssociatedTokenAccountIdempotentInstruction(w.buyer.publicKey, sol, w.buyer.publicKey, NATIVE_MINT), SystemProgram.transfer({ fromPubkey: w.buyer.publicKey, toPubkey: sol, lamports: 20_000_000_000 }), createSyncNativeInstruction(sol)], [w.buyer]);
        const cAcc = ensureAta(w.svm, w.buyer, w.cometail.mint, w.buyer.publicKey);
        send(w.svm, [await damm.swapIx(w.svm, { pool: w.cometail.dammPool, payer: w.buyer.publicKey, inputAccount: sol, outputAccount: cAcc, amountIn: new BN(20_000_000_000) })], [w.buyer]);
        const fresh = await paired.pairedBuy(w.conn, w.other.publicKey, await curve(), new BN(50_000_000_000));
        expect(fresh.nearCompletion).eq(true);
        completing = fresh;
        // another buy takes half of what the curve still needs first: the flagged buy would get far fewer coins than its
        // 1% minimum, so it fails whole (nothing spent, no $COMETAIL left behind)
        const c0 = tokens(w.svm, w.cometail.mint, w.other.publicKey), s0 = lamports(w.svm, w.other.publicKey);
        await dbc.buy(w.svm, w.buyer, w.coin.pool, cAcc, ensureAta(w.svm, w.buyer, w.coin.mint, w.buyer.publicKey), half);
        expectFail(w.svm, fresh.instructions, [w.other], "ExceededSlippage", { cu: 400_000 });
        expect(tokens(w.svm, w.cometail.mint, w.other.publicKey)).eq(c0);
        expect(s0 - lamports(w.svm, w.other.publicKey) <= 10_000n, "only the fee").eq(true);
        // a competing buy small enough to stay inside the 1% bound: the flagged buy lands, the curve takes a little less,
        // and what it did not take stays in the wallet as $COMETAIL: under 1% of what was bought
        const again = await paired.pairedBuy(w.conn, w.other.publicKey, await curve(), new BN(50_000_000_000));
        expect(again.nearCompletion).eq(true);
        const tiny = new BN((remaining() / 400n).toString());
        await dbc.buy(w.svm, w.buyer, w.coin.pool, cAcc, ensureAta(w.svm, w.buyer, w.coin.mint, w.buyer.publicKey), tiny);
        const c1 = tokens(w.svm, w.cometail.mint, w.other.publicKey);
        send(w.svm, again.instructions, [w.other], { cu: 400_000 });
        const left = tokens(w.svm, w.cometail.mint, w.other.publicKey) - c1;
        expect(Number(dbc.getPool(w.svm, w.coin.pool).migrationProgress)).gt(0);
        expect(left > 0n && left * 100n < BigInt(again.cometail.toString()), `left ${left} of ${again.cometail}`).eq(true);
        // and it is only what the competitor took (with the fee on it): uncontested, the completing buy leaves nothing
        const t = BigInt(tiny.toString());
        expect(left <= (t * 100n) / 99n + 2n && left >= (t * 98n) / 100n, `left ${left} vs competitor ${t}`).eq(true);
        continue;
      }
      const c0 = tokens(w.svm, w.cometail.mint, w.other.publicKey);
      send(w.svm, plan.instructions, [w.other], { cu: 400_000 });
      // the buy that completes the curve on its own buys only what the curve takes: nothing is left in $COMETAIL
      expect(tokens(w.svm, w.cometail.mint, w.other.publicKey) - c0, `fill ${i}: $COMETAIL left`).eq(0n);
    }
    expect(completing, "a buy near completion was flagged").not.eq(null);
    expect(Number(dbc.getPool(w.svm, w.coin.pool).migrationProgress)).gt(0);
    void remaining;
    const mig = await dbc.migrateToDammV2(w.svm, w.keeper, w.coin.pool, DAMM_V2_MIGRATION_CONFIG.customizable);
    const pool = damm.getPool(w.svm, mig.dammPool);
    expect(pool.tokenAMint.toBase58()).eq(w.coin.mint.toBase58());
    expect(pool.tokenBMint.toBase58()).eq(w.cometail.mint.toBase58());
    expect(Number(pool.collectFeeMode)).eq(2);
    // every position's liquidity is permanently locked; the rest is DAMM v2's own dead liquidity
    expect(BigInt(pool.liquidity.toString()) - BigInt(pool.permanentLockLiquidity.toString()) <= BigInt(DEAD_LIQUIDITY.toString()) + 1n).eq(true);
    w.coin.dammPool = mig.dammPool; w.coin.positions = [mig.firstPosition, mig.secondPosition];
    const market = { kind: "damm" as const, pool: mig.dammPool, baseMint: w.coin.mint, baseDecimals: 6 };
    const coinBefore = tokens(w.svm, w.coin.mint, w.buyer.publicKey);
    const buy = await paired.pairedBuy(w.conn, w.buyer.publicKey, market, new BN(1_000_000_000));
    expect(BigInt(buy.coinMinOut!.toString()) * 10_000n <= BigInt(buy.coinOut!.toString()) * 9_910n, "graduated leg bound is 1%").eq(true);
    const cometailBefore = tokens(w.svm, w.cometail.mint, w.buyer.publicKey);
    expect(send(w.svm, buy.instructions, [w.buyer], { cu: 400_000, label: "paired: buy on the graduated pool" }).bytes).lte(1232);
    expect(tokens(w.svm, w.cometail.mint, w.buyer.publicKey)).eq(cometailBefore);
    expect(tokens(w.svm, w.coin.mint, w.buyer.publicKey) - coinBefore >= BigInt(buy.coinMinOut!.toString())).eq(true);
    const sell = await paired.pairedSell(w.conn, w.buyer.publicKey, market, new BN(((tokens(w.svm, w.coin.mint, w.buyer.publicKey) - coinBefore) / 2n).toString()), true);
    expect(send(w.svm, sell.instructions, [w.buyer], { cu: 400_000, label: "paired: sell on the graduated pool" }).bytes).lte(1232);
  });

  it("a graduated position's fees: the claim pays $COMETAIL only, half of it as measured is burned, the rest stays", async () => {
    const mine = damm.findPositionOwnedBy(w.svm, w.coin.positions, w.treasury.publicKey);
    expect(mine, "the partner's locked position").not.eq(null);
    const claim: any = { id: "pos", kind: "damm-position-fee", configLabel: "position", pool: w.coin.dammPool, baseMint: w.coin.mint, position: mine!.position, positionNftAccount: mine!.nftAccount, claimer: w.treasury.publicKey, quoteMint: w.cometail.mint, quoteDecimals: 6, amountQuote: 1n, amountBase: 0n, destination: getAssociatedTokenAddressSync(w.cometail.mint, w.treasury.publicKey), destinationExists: true };
    const supplyBefore = supply(w.svm, w.cometail.mint), heldBefore = tokens(w.svm, w.cometail.mint, w.treasury.publicKey), coinBefore = tokens(w.svm, w.coin.mint, w.treasury.publicKey);
    const built = await fees.buildPairedClaim(w.conn, claim, { status: "absent" });
    expect(built.pairedBurn.exact).eq(false);
    expect(built.pairedBurn.claimed > 0n).eq(true);
    send(w.svm, built.instructions, [w.treasury, ...built.signers], { label: "paired: position claim + burn half" });
    // the same claim again: no new fees, so it pays nothing and fails whole (no burn of what the treasury holds)
    const snap = [supply(w.svm, w.cometail.mint), tokens(w.svm, w.cometail.mint, w.treasury.publicKey)];
    expectFail(w.svm, built.instructions, [w.treasury, ...built.signers], "", { cu: 400_000 });
    expect([supply(w.svm, w.cometail.mint), tokens(w.svm, w.cometail.mint, w.treasury.publicKey)]).to.deep.eq(snap);
    const paid = tokens(w.svm, w.cometail.mint, w.treasury.publicKey) - heldBefore + built.pairedBurn.burned;
    expect(paid).eq(built.pairedBurn.claimed);
    expect(supplyBefore - supply(w.svm, w.cometail.mint)).eq(built.pairedBurn.claimed / 2n);
    expect(tokens(w.svm, w.coin.mint, w.treasury.publicKey)).eq(coinBefore);
  });
});
