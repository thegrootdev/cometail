// Tail claims with no program of ours involved: the tail's creator (a plain wallet) claims its curve fees and
// splits them in the same transaction: half kept, a quarter to the burn reserve, a quarter into $COMETAIL's
// compounding DAMM v2 pool as liquidity in the wallet's own position, permanently locked. Checked here against
// the mainnet Meteora binaries: the exact split, the transaction size, the lock, the pool math the builder
// predicts, the graduation payout, and the tail's own graduated position through the burn program's owner claim.
import { BN, utils } from "@coral-xyz/anchor";
import { ComputeBudgetProgram, Keypair, PublicKey, Transaction, TransactionInstruction } from "@solana/web3.js";
import { FailedTransactionMetadata } from "litesvm";
import { NATIVE_MINT, getAssociatedTokenAddressSync } from "@solana/spl-token";
import { expect } from "chai";
import { BurnClient, compoundingPool, createLockedPositionIxs, quoteBuy, tailCashoutIxs, tailClaimIxs, tailMakeUpIxs, tailSplit } from "@cometail/client";
import { startSvm, fund, DAMM_V2_MIGRATION_CONFIG } from "../harness/svm";
import { send, expectFail } from "../harness/tx";
import { ensureAta, balance, wrapSol } from "../harness/tokens";
import * as dbc from "../harness/dbc";
import * as damm from "../harness/damm";
import { makeUpOf, parseCreatorTx, parsePositionTx, parseReserveTx, type Ix, type TxView } from "../../worker/src/tails";

const big = (v: any) => BigInt(v.toString());
const price = ComputeBudgetProgram.setComputeUnitPrice({ microLamports: 10_000 });
/** Sends like harness/tx.send and returns the indexer's view of the transaction (top-level and inner
 *  instructions, logs, the token balances of the watched accounts), as tails.ts reads it from getTransaction. */
function sendView(svm: any, ixs: TransactionInstruction[], signers: Keypair[], watch: PublicKey[]): { bytes: number; cu: bigint; view: TxView } {
  const tx = new Transaction().add(ComputeBudgetProgram.setComputeUnitLimit({ units: 400_000 }), price, ...ixs);
  tx.feePayer = signers[0].publicKey; tx.recentBlockhash = svm.latestBlockhash(); tx.sign(...signers);
  const msg = tx.compileMessage();
  const keys = msg.accountKeys;
  const amount = (k: PublicKey) => { const a = svm.getAccount(k); return a && a.data.length >= 72 ? Buffer.from(a.data).readBigUInt64LE(64) : 0n; };
  const pre = new Map(watch.map((k) => [k.toBase58(), amount(k)]));
  const bytes = tx.serialize().length;
  const res = svm.sendTransaction(tx); svm.expireBlockhash();
  if (res instanceof FailedTransactionMetadata) throw new Error(`failed: ${res.err()}\n${res.meta().logs().join("\n")}`);
  const top: Ix[] = msg.instructions.map((ix) => ({ programId: keys[ix.programIdIndex], accounts: ix.accounts.map((i) => keys[i]), data: Buffer.from(utils.bytes.bs58.decode(ix.data)) }));
  const inner = new Map<number, Ix[]>();
  res.innerInstructions().forEach((group: any[], i: number) => { if (group.length) inner.set(i, group.map((x: any) => ({ programId: keys[x.instruction().programIdIndex()], accounts: [...x.instruction().accounts()].map((k: number) => keys[k]), data: Buffer.from(x.instruction().data()) }))); });
  const view: TxView = { signature: utils.bytes.bs58.encode(tx.signature!), slot: 1, blockTime: null, err: false, top, inner, logs: res.logs(),
    balance: (k) => (pre.has(k.toBase58()) ? { pre: pre.get(k.toBase58())!, post: amount(k) } : null), ownerAfter: () => null };
  return { bytes, cu: res.computeUnitsConsumed(), view };
}
async function world() {
  const owner = Keypair.generate();
  const svm = startSvm({ upgradeAuthority: owner.publicKey, burnAuthority: owner.publicKey });
  svm.airdrop(owner.publicKey, BigInt(1_000_000_000_000));
  const w: any = { svm, owner, keeper: fund(svm), buyer: fund(svm, 100_000), stranger: fund(svm) };
  w.client = new BurnClient();
  w.treasury = ensureAta(svm, owner, NATIVE_MINT, owner.publicKey);
  w.buyerQuote = wrapSol(svm, w.buyer, new BN(90_000).mul(new BN(1_000_000_000)));
  // $COMETAIL: a coin on today's plain economics, graduated into its 1% compounding pool; the burn program set up on it
  const plain = await dbc.createConfig(svm, { payer: owner, feeClaimer: owner.publicKey, leftoverReceiver: owner.publicKey, quoteMint: NATIVE_MINT, params: dbc.configParams("plain") });
  const cm = Keypair.generate(), cometCreator = fund(svm);
  const C = await dbc.createPoolIx({ config: plain, baseMint: cm.publicKey, quoteMint: NATIVE_MINT, creator: cometCreator.publicKey, payer: cometCreator.publicKey });
  send(svm, [C.ix], [cometCreator, cm], { cu: 600_000 });
  const Rc: BN = dbc.getConfig(svm, plain).migrationQuoteThreshold;
  await dbc.buy(svm, w.buyer, C.pool, w.buyerQuote, ensureAta(svm, w.buyer, cm.publicKey, w.buyer.publicKey), Rc.muln(6).divn(5));
  const cmig = await dbc.migrateToDammV2(svm, w.keeper, C.pool, DAMM_V2_MIGRATION_CONFIG.customizable);
  w.comet = { mint: cm.publicKey, pool: cmig.dammPool, creator: cometCreator, positions: [cmig.firstPosition, cmig.secondPosition] };
  send(svm, [await w.client.setup({ authority: owner.publicKey, cometailMint: cm.publicKey, pool: cmig.dammPool, treasury: w.treasury })], [owner]);
  w.state = w.client.decodeState(Buffer.from(svm.getAccount(w.client.a.burnState)!.data));
  // the fee-sale config (stream-50, mainnet parameters), fee claimer = the protocol owner
  w.config = await dbc.createConfig(svm, { payer: owner, feeClaimer: owner.publicKey, leftoverReceiver: owner.publicKey, quoteMint: NATIVE_MINT, params: dbc.configParams("stream-50") });
  // the tail: launched by the creator's own wallet, no vault, no deposit
  w.creator = fund(svm);
  const tm = Keypair.generate();
  const T = await dbc.createPoolIx({ config: w.config, baseMint: tm.publicKey, quoteMint: NATIVE_MINT, creator: w.creator.publicKey, payer: w.creator.publicKey, name: "tail of COMETAIL", symbol: "tCOMETAIL" });
  send(svm, [T.ix], [w.creator, tm], { cu: 500_000 });
  w.tail = { mint: tm.publicKey, pool: T.pool, baseVault: T.baseVault, quoteVault: T.quoteVault };
  w.tailBuyerAta = ensureAta(svm, w.buyer, tm.publicKey, w.buyer.publicKey);
  return w;
}
const xPool = (w: any) => compoundingPool(w.comet.pool, damm.getPool(w.svm, w.comet.pool));
const curve = (w: any) => ({ pool: w.tail.pool, baseMint: w.tail.mint, baseVault: w.tail.baseVault, quoteVault: w.tail.quoteVault });

describe("gate 22: tail claims by a plain wallet", () => {
  it("one transaction: claim, a quarter to the burn reserve, a quarter locked as $COMETAIL liquidity, half kept; then graduation", async () => {
    const w = await world();
    const { svm, creator } = w;
    // one-time setup: the creator's position in $COMETAIL's pool and its token accounts
    const nft = Keypair.generate();
    const setup = createLockedPositionIxs({ owner: creator.publicKey, pool: w.comet.pool, nftMint: nft.publicKey, tokenAMint: w.comet.mint, tailMint: w.tail.mint });
    send(svm, setup.ixs, [creator, nft], { label: "tail: create locked position" });
    expect(damm.getPosition(svm, setup.position).pool.equals(w.comet.pool)).true;
    const locked = { position: setup.position, nftAccount: setup.nftAccount };
    const wsol = getAssociatedTokenAddressSync(NATIVE_MINT, creator.publicKey);
    const xAta = getAssociatedTokenAddressSync(w.comet.mint, creator.publicKey);

    let lockedTotal = 0n;
    for (const round of [1, 2]) {
      await dbc.buy(svm, w.buyer, w.tail.pool, w.buyerQuote, w.tailBuyerAta, new BN(round === 1 ? 5_000_000_000 : 8_000_000_000));
      const claimable = big(dbc.getPool(svm, w.tail.pool).creatorQuoteFee);
      expect(claimable > 0n).true;
      const x = xPool(w);
      const built = tailClaimIxs({ creator: creator.publicKey, curve: curve(w), claimable, reserve: w.state.reserve, x, locked });
      // a stranger cannot sign it for the creator, and the creator signs it alone
      expectFail(svm, built.ixs, [w.stranger], "");
      const before = { wsol: balance(svm, wsol), reserve: balance(svm, w.state.reserve), x: balance(svm, xAta), poolB: x.tokenBAmount, poolA: x.tokenAAmount };
      const sent = sendView(svm, built.ixs, [creator], [w.state.reserve]);
      expect(sent.bytes, "fits one legacy transaction").lte(1232);
      const s = built.split;
      expect(s.swapIn + s.liquiditySol).eq(s.toLiquidity);
      expect(s.kept + s.toBurn + s.toLiquidity).eq(claimable);
      // exactly a quarter reached the burn reserve
      expect(big(balance(svm, w.state.reserve)) - big(before.reserve)).eq(s.toBurn);
      // the liquidity: what the pool took from the wallet, and the lock on exactly the added liquidity
      const after = damm.getPool(svm, w.comet.pool);
      const pos = damm.getPosition(svm, setup.position);
      lockedTotal += built.liquidityDelta;
      expect(big(pos.permanentLockedLiquidity)).eq(lockedTotal);
      expect(big(pos.unlockedLiquidity)).eq(0n);
      const xGot = big(balance(svm, xAta)) - big(before.x); // $COMETAIL left in the wallet (bought minus deposited)
      const q = quoteBuy(x, s.swapIn);
      const depositedA = q.out - xGot;
      const depositedB = big(after.tokenBAmount) - q.tokenBAfter;
      expect(big(after.tokenAAmount)).eq(q.tokenAAfter + depositedA); // the builder's swap math is cp-amm's, to the unit
      const wsolDelta = big(balance(svm, wsol)) - big(before.wsol);
      expect(wsolDelta).eq(claimable - s.toBurn - s.swapIn - depositedB);
      // the balanced swap and the 0.2% margin leave under 0.4% of the liquidity quarter in the wallet
      expect(Number(s.liquiditySol - depositedB) / Number(s.liquiditySol)).lt(0.004);
      expect(Number(xGot) / Number(q.out)).lt(0.004);
      // the indexer reads the same numbers back, each leg bound to its own instruction after the claim
      const target = { curve: w.tail.pool.toBase58(), targetPool: w.comet.pool.toBase58(), reserve: w.state.reserve.toBase58() };
      const { claims, payouts } = parseCreatorTx(sent.view, target);
      expect(payouts).deep.eq([]);
      expect(claims.length).eq(1);
      const c = claims[0];
      expect(c.status).eq("split");
      expect(c.creator).eq(creator.publicKey.toBase58());
      expect(c.claimedLamports).eq(claimable.toString());
      expect(c.toBurn!.lamports).eq(s.toBurn.toString());
      expect(c.buy).deep.eq({ inLamports: s.swapIn.toString(), outRaw: q.out.toString() });
      expect(c.add).deep.eq({ position: setup.position.toBase58(), addedRaw: depositedA.toString(), addedLamports: depositedB.toString(), liquidity: built.liquidityDelta.toString() });
      expect(c.lockedLiquidity).eq(built.liquidityDelta.toString());
      // the reserve ledger: one top-level inflow of exactly the quarter, balance linked
      const r = parseReserveTx(sent.view, w.state.reserve)!;
      expect(r.ok).eq(true);
      expect(r.legs).deep.eq([{ seq: 0, dir: "in", lamports: s.toBurn.toString(), topLevel: true }]);
      expect(BigInt(r.post) - BigInt(r.pre)).eq(s.toBurn);
      // another curve's claim is not this tail's
      expect(parseCreatorTx(sent.view, { ...target, curve: Keypair.generate().publicKey.toBase58() }).claims).deep.eq([]);
      console.log(JSON.stringify({ round, claimable: claimable.toString(), kept: s.kept.toString(), toBurn: s.toBurn.toString(), swapIn: s.swapIn.toString(), depositedSol: depositedB.toString(), depositedComet: depositedA.toString(), leftoverSol: (s.liquiditySol - depositedB).toString(), leftoverComet: xGot.toString(), liquidityDelta: built.liquidityDelta.toString(), bytes: sent.bytes, cu: sent.cu.toString() }));
    }
    // the locked liquidity cannot come out: DAMM v2 refuses to remove permanently locked liquidity
    const pos = damm.getPosition(svm, setup.position);
    expect(big(pos.unlockedLiquidity)).eq(0n);

    // graduation: the creator's own DBC withdrawals pay the preset's 50% of the raise
    const R: BN = dbc.getConfig(svm, w.config).migrationQuoteThreshold;
    await dbc.buy(svm, w.buyer, w.tail.pool, w.buyerQuote, w.tailBuyerAta, R.muln(6).divn(5));
    const mig = await dbc.migrateToDammV2(svm, w.keeper, w.tail.pool, DAMM_V2_MIGRATION_CONFIG.customizable);
    const p = dbc.getPool(svm, w.tail.pool);
    const c0 = balance(svm, wsol);
    const paid = sendView(svm, tailCashoutIxs({ creator: creator.publicKey, config: w.config, curve: curve(w), migrationFeePending: true, surplusPending: Number(p.isCreatorWithdrawSurplus) === 0 }), [creator], []);
    expect(balance(svm, wsol).sub(c0).toString()).eq(R.sub(R.muln(50).addn(99).divn(100)).toString());
    // the creator walk records the payout (migration fee, and the surplus when there is one), not as a claim
    const pp = parseCreatorTx(paid.view, { curve: w.tail.pool.toBase58(), targetPool: w.comet.pool.toBase58(), reserve: w.state.reserve.toBase58() });
    expect(pp.claims).deep.eq([]);
    expect(pp.payouts.reduce((a, x) => a + BigInt(x.lamports), 0n)).eq(big(balance(svm, wsol).sub(c0)));

    // after graduation: the tail's creator position fees go through the burn program's owner claim, half to the reserve
    const tailPos = damm.findPositionOwnedBy(svm, [mig.firstPosition, mig.secondPosition], creator.publicKey)!;
    const tp = damm.getPool(svm, mig.dammPool);
    const tailQuote = wrapSol(svm, w.buyer, new BN(20_000_000_000));
    const tailBase = w.tailBuyerAta;
    send(svm, [await damm.swapIx(svm, { pool: mig.dammPool, payer: w.buyer.publicKey, inputAccount: tailQuote, outputAccount: tailBase, amountIn: new BN(10_000_000_000) })], [w.buyer], { cu: 400_000 });
    const r0 = big(balance(svm, w.state.reserve)), o0 = big(balance(svm, wsol));
    const gv = sendView(svm, [await w.client.ownerClaimPositionFees({ state: w.state, owner: creator.publicKey, ownerWsol: wsol, pool: mig.dammPool, position: tailPos.position, positionNftAccount: tailPos.nftAccount, tokenAVault: tp.tokenAVault, tokenBVault: tp.tokenBVault, tokenAMint: w.tail.mint })], [creator], [w.state.reserve]);
    const toReserve = big(balance(svm, w.state.reserve)) - r0, toOwner = big(balance(svm, wsol)) - o0;
    // the position walk records it as a pool claim split through the program, and the reserve sees an inner inflow of that half
    const pc = parsePositionTx(gv.view, new Set([tailPos.position.toBase58()]), mig.dammPool.toBase58());
    expect(pc).deep.eq([{ kind: "pool", position: tailPos.position.toBase58(), owner: creator.publicKey.toBase58(), claimedLamports: (toReserve + toOwner).toString(), status: "split", toBurn: { lamports: toReserve.toString() } }]);
    const gr = parseReserveTx(gv.view, w.state.reserve)!;
    expect(gr.ok).eq(true);
    expect(gr.legs.filter((l) => l.dir === "in").map((l) => [l.lamports, l.topLevel])).deep.eq([[toReserve.toString(), false]]);
    expect(toReserve > 0n).true;
    expect(Number(toOwner - toReserve)).lte(1); // half each; the odd lamport goes to the other side
    expect(Number(toReserve - toOwner)).lte(1);
  });

  it("$COMETAIL's own creator wallet: claims add to its migration position, counted apart from what was locked there", async () => {
    const w = await world();
    const { svm } = w;
    // the tail launched by the wallet that holds $COMETAIL's creator position, which never ran the one-time setup:
    // no WSOL, tail or $COMETAIL token account yet
    const owner: Keypair = w.comet.creator;
    const tm = Keypair.generate();
    const T = await dbc.createPoolIx({ config: w.config, baseMint: tm.publicKey, quoteMint: NATIVE_MINT, creator: owner.publicKey, payer: owner.publicKey, name: "tail of COMETAIL", symbol: "tCOMETAIL" });
    send(svm, [T.ix], [owner, tm], { cu: 500_000 });
    const tail = { pool: T.pool, baseMint: tm.publicKey, baseVault: T.baseVault, quoteVault: T.quoteVault };
    const wsol = getAssociatedTokenAddressSync(NATIVE_MINT, owner.publicKey);
    for (const m of [NATIVE_MINT, tm.publicKey, w.comet.mint]) expect(svm.getAccount(getAssociatedTokenAddressSync(m, owner.publicKey))).null;
    const mine = damm.findPositionOwnedBy(svm, w.comet.positions, owner.publicKey)!;
    const locked0 = big(mine.state.permanentLockedLiquidity);
    expect(locked0 > 0n).true; // $COMETAIL's own graduation locked it
    const target = { curve: T.pool.toBase58(), targetPool: w.comet.pool.toBase58(), reserve: w.state.reserve.toBase58() };
    let added = 0n;
    for (const round of [1, 2]) {
      await dbc.buy(svm, w.buyer, T.pool, w.buyerQuote, ensureAta(svm, w.buyer, tm.publicKey, w.buyer.publicKey), new BN(round * 4_000_000_000));
      const claimable = big(dbc.getPool(svm, T.pool).creatorQuoteFee);
      const r0 = big(balance(svm, w.state.reserve));
      const built = tailClaimIxs({ creator: owner.publicKey, curve: tail, claimable, reserve: w.state.reserve, x: xPool(w), locked: { position: mine.position, nftAccount: mine.nftAccount } });
      const sent = sendView(svm, built.ixs, [owner], [w.state.reserve]);
      expect(sent.bytes, "fits one legacy transaction").lte(1232);
      expect(big(balance(svm, w.state.reserve)) - r0).eq(built.split.toBurn);
      added += built.liquidityDelta;
      // the position's lock grows by exactly what the claims added; the indexer counts only that
      expect(big(damm.getPosition(svm, mine.position).permanentLockedLiquidity)).eq(locked0 + added);
      const { claims } = parseCreatorTx(sent.view, target);
      expect(claims.map((c) => [c.status, c.add?.position, c.lockedLiquidity])).deep.eq([["split", mine.position.toBase58(), built.liquidityDelta.toString()]]);
      console.log(JSON.stringify({ shared: round, claimable: claimable.toString(), bytes: sent.bytes, cu: sent.cu.toString() }));
    }
    expect(big(balance(svm, wsol)) > 0n).true; // the kept half, in the WSOL account the claim created
  });

  it("a claim not split when it was made, made up once from the wallet: a quarter to the reserve, a quarter locked in the same position", async () => {
    const w = await world();
    const { svm } = w;
    const owner: Keypair = w.comet.creator;
    const tm = Keypair.generate();
    const T = await dbc.createPoolIx({ config: w.config, baseMint: tm.publicKey, quoteMint: NATIVE_MINT, creator: owner.publicKey, payer: owner.publicKey, name: "tail of COMETAIL", symbol: "tCOMETAIL" });
    send(svm, [T.ix], [owner, tm], { cu: 500_000 });
    await dbc.buy(svm, w.buyer, T.pool, w.buyerQuote, ensureAta(svm, w.buyer, tm.publicKey, w.buyer.publicKey), new BN(6_000_000_000));
    const target = { curve: T.pool.toBase58(), targetPool: w.comet.pool.toBase58(), reserve: w.state.reserve.toBase58() };
    // the claim made elsewhere: DBC's claim alone, everything to the wallet
    const claimable = big(dbc.getPool(svm, T.pool).creatorQuoteFee);
    const wsol = ensureAta(svm, owner, NATIVE_MINT, owner.publicKey);
    const raw = sendView(svm, [await dbc.claimCreatorTradingFeeIx(svm, T.pool, owner.publicKey, ensureAta(svm, owner, tm.publicKey, owner.publicKey), wsol, new BN(0), new BN(claimable.toString()))], [owner], []);
    const claim = parseCreatorTx(raw.view, target).claims[0];
    expect([claim.status, claim.claimedLamports]).deep.eq(["unsplit", claimable.toString()]);
    // the make-up, from the wallet's SOL, into $COMETAIL's own migration position
    const mine = damm.findPositionOwnedBy(svm, w.comet.positions, owner.publicKey)!;
    const locked0 = big(damm.getPosition(svm, mine.position).permanentLockedLiquidity);
    const r0 = big(balance(svm, w.state.reserve));
    const built = tailMakeUpIxs({ creator: owner.publicKey, claimSignature: raw.view.signature, claimedLamports: claimable, reserve: w.state.reserve, x: xPool(w), locked: { position: mine.position, nftAccount: mine.nftAccount } });
    expectFail(svm, built.ixs, [w.stranger], "");
    const sent = sendView(svm, built.ixs, [owner], [w.state.reserve]);
    expect(sent.bytes, "fits one legacy transaction").lte(1232);
    expect(sent.view.logs.some((l) => l.startsWith("Program MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr success"))).true;
    const q = tailSplit(claimable).toBurn;
    expect(big(balance(svm, w.state.reserve)) - r0).eq(q);
    expect(big(damm.getPosition(svm, mine.position).permanentLockedLiquidity)).eq(locked0 + built.liquidityDelta);
    const p = parseCreatorTx(sent.view, target);
    expect(p.claims).deep.eq([]);
    expect(p.makeUps.map((x) => [x.claim, x.creator, x.status, x.toBurn?.lamports, x.add?.position, x.lockedLiquidity])).deep.eq([[raw.view.signature, owner.publicKey.toBase58(), "split", q.toString(), mine.position.toBase58(), built.liquidityDelta.toString()]]);
    // the view's rule accepts it for that claim (made after it, by its creator, exactly the quarters)
    const rowOf = (v: TxView, slot: number, data: any) => ({ signature: v.signature, idx: 0, slot, blockTime: null, name: "m", data });
    const got = makeUpOf({ signature: raw.view.signature, slot: 1, claimedLamports: claimable.toString() }, [rowOf(sent.view, 2, p.makeUps[0])], [owner.publicKey.toBase58()]);
    expect(got?.signature).eq(sent.view.signature);
    const r = parseReserveTx(sent.view, w.state.reserve)!;
    expect([r.ok, r.legs.map((l) => [l.dir, l.lamports, l.topLevel])]).deep.eq([true, [["in", q.toString(), true]]]);
    console.log(JSON.stringify({ makeUp: claimable.toString(), toBurn: q.toString(), swapIn: built.split.swapIn.toString(), bytes: sent.bytes, cu: sent.cu.toString() }));
  });

  it("refuses a pool the math does not describe, and claims too small to split", async () => {
    const w = await world();
    const raw = damm.getPool(w.svm, w.comet.pool);
    expect(() => compoundingPool(w.comet.pool, { ...raw, collectFeeMode: 0 })).throw(/compounding/);
    expect(() => compoundingPool(w.comet.pool, { ...raw, poolFees: { ...raw.poolFees, dynamicFee: { ...raw.poolFees.dynamicFee, initialized: 1 } } })).throw(/dynamic/);
    const data = [...raw.poolFees.baseFee.baseFeeInfo.data]; data[9] = 1;
    expect(() => compoundingPool(w.comet.pool, { ...raw, poolFees: { ...raw.poolFees, baseFee: { baseFeeInfo: { data } } } })).throw(/constant/);
    expect(() => tailClaimIxs({ creator: w.creator.publicKey, curve: curve(w), claimable: 7n, reserve: w.state.reserve, x: xPool(w), locked: { position: PublicKey.default, nftAccount: PublicKey.default } })).throw(/too small/);
  });
});
