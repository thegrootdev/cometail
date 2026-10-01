// Launch through the program: the vault PDA becomes the stream token's pool creator from a
// protocol preset; the pool fills; migration lands the creator position in the vault; the
// own position registers (Live); cash-out pays the depositor exactly the preset's share.
// Gate 9: pair registration is write-once and rejects pairs that fail the checks.
import { BN } from "@coral-xyz/anchor";
import { Keypair } from "@solana/web3.js";
import { NATIVE_MINT, TOKEN_2022_PROGRAM_ID, TOKEN_PROGRAM_ID, createTransferCheckedInstruction } from "@solana/spl-token";
import { expect } from "chai";
import { VaultClientStep4, deriveStream } from "@cometail/client";
import { startSvm, fund, DAMM_V2_MIGRATION_CONFIG } from "../harness/svm";
import { send, expectFail } from "../harness/tx";
import { ataIx, ensureAta, balance, wrapSol, createMint, mintTo } from "../harness/tokens";
import * as dbc from "../harness/dbc";
import * as damm from "../harness/damm";
import * as dlmm from "../harness/dlmm";

const policy = { maxSpendPerPeriod: new BN(5_000_000_000), periodSeconds: new BN(3600), maxOutstandingOrders: 4, maxBinsPerOrder: 20, maxPriceQ64: new BN(1).shln(64).muln(10) };

/** Protocol with the three presets owned by `owner`, a creator's external plain-launch stream, a vault holding it. */
async function setup(preset: 0 | 1 | 2) {
  const owner = Keypair.generate();
  const svm = startSvm({ upgradeAuthority: owner.publicKey });
  svm.airdrop(owner.publicKey, BigInt(100_000_000_000));
  const client = new VaultClientStep4();
  const keeper = fund(svm), creator = fund(svm), buyer = fund(svm);
  ensureAta(svm, owner, NATIVE_MINT, owner.publicKey);
  const cfgs = [] as any[];
  for (const n of ["stream-25", "stream-50", "stream-75"] as const) cfgs.push(await dbc.createConfig(svm, { payer: owner, feeClaimer: owner.publicKey, leftoverReceiver: owner.publicKey, quoteMint: NATIVE_MINT, params: dbc.configParams(n) }));
  send(svm, [await client.initProtocol({ admin: owner.publicKey, keeper: keeper.publicKey, payer: owner.publicKey, streamConfigs: cfgs as any })], [owner]);
  // an external stream: a plain launch by the creator, filled and migrated
  const plain = await dbc.createConfig(svm, { payer: owner, feeClaimer: owner.publicKey, leftoverReceiver: owner.publicKey, quoteMint: NATIVE_MINT, params: dbc.configParams("plain") });
  const mint = Keypair.generate();
  const ext = await dbc.createPoolIx({ config: plain, baseMint: mint.publicKey, quoteMint: NATIVE_MINT, creator: creator.publicKey, payer: creator.publicKey });
  send(svm, [ext.ix], [creator, mint], { cu: 600_000 });
  const R: BN = dbc.getConfig(svm, plain).migrationQuoteThreshold;
  const buyerQuote = wrapSol(svm, buyer, R.muln(6));
  const buyerBase = ensureAta(svm, buyer, mint.publicKey, buyer.publicKey);
  await dbc.buy(svm, buyer, ext.pool, buyerQuote, buyerBase, R.muln(6).divn(5));
  const mig = await dbc.migrateToDammV2(svm, buyer, ext.pool, DAMM_V2_MIGRATION_CONFIG.customizable);
  const creatorPos = damm.findPositionOwnedBy(svm, [mig.firstPosition, mig.secondPosition], creator.publicKey)!;
  // vault with that position
  const stMint = Keypair.generate();
  const cv = await client.createVault({ depositor: creator.publicKey, stMint: stMint.publicKey, policy });
  send(svm, [cv.ix], [creator, cv.placeholder, stMint]);
  const nftMint = creatorPos.state.nftMint;
  const vaultNft = ataIx(creator.publicKey, nftMint, cv.vault, TOKEN_2022_PROGRAM_ID);
  send(svm, [vaultNft.ix, createTransferCheckedInstruction(creatorPos.nftAccount, nftMint, vaultNft.address, creator.publicKey, 1, 0, [], TOKEN_2022_PROGRAM_ID)], [creator]);
  send(svm, [await client.depositPosition({ vault: cv.vault, depositor: creator.publicKey, streamIndex: 0, dammPool: mig.dammPool, position: creatorPos.position, nftMint, nftAccount: vaultNft.address, baseMint: mint.publicKey })], [creator]);
  return { svm, client, owner, keeper, creator, buyer, cfgs, cv, stMint, buyerQuote, preset };
}

describe("launch, migration, own position, cash-out, pair registration", () => {
  for (const preset of [0, 2] as const) {
    it(`preset ${preset}: launch -> fill -> migrate -> Live -> cash-out of exactly the preset share`, async () => {
      const h = await setup(preset);
      const { svm, client, creator, buyer, cv, stMint } = h;
      // wrong config for the preset is rejected; the right one launches
      const wrong = await client.launch({ vault: cv.vault, depositor: creator.publicKey, stMint: stMint.publicKey, config: h.cfgs[preset === 0 ? 1 : 0], preset, streamIndex: 1, metadata: { name: "tail", symbol: "tTKN", uri: "https://cometail.fun/t.json" } });
      expectFail(svm, [wrong.ix], [creator, stMint], "AccountMismatch");
      const L = await client.launch({ vault: cv.vault, depositor: creator.publicKey, stMint: stMint.publicKey, config: h.cfgs[preset], preset, streamIndex: 1, metadata: { name: "tail", symbol: "tTKN", uri: "https://cometail.fun/t.json" } });
      send(svm, [L.ix], [creator, stMint], { cu: 800_000, label: "launch" });
      const v = client.decodeVault(Buffer.from(svm.getAccount(cv.vault)!.data));
      expect(v.status).deep.eq({ launched: {} });
      expect(v.dbcPool.equals(L.pool)).true;
      expect(dbc.getPool(svm, L.pool).creator.equals(cv.vault)).true;
      expect(svm.getAccount(L.stAta)).not.null;
      const own = client.decodeStream(Buffer.from(svm.getAccount(deriveStream(cv.vault, 1))!.data));
      expect(own.isOwn).true;
      // launch is final: deposits and withdrawals are closed
      const deposited = client.decodeStream(Buffer.from(svm.getAccount(deriveStream(cv.vault, 0))!.data));
      expectFail(svm, [await client.withdrawStream({ vault: cv.vault, depositor: creator.publicKey, stream: deriveStream(cv.vault, 0), kind: "position", indexKey: deposited.position })], [creator], "WrongStatus");
      // cash-out before the curve completes is not available
      const ps = dbc.getPool(svm, L.pool);
      const cashoutIx = await client.cashout({ vault: cv.vault, dbcPool: L.pool, dbcConfig: h.cfgs[preset], quoteVault: ps.quoteVault, depositorWsol: cv.depositorWsol });
      expectFail(svm, [cashoutIx], [buyer], "WrongStatus");
      // buyers fill the curve from the app's DBC path
      const R: BN = dbc.getConfig(svm, h.cfgs[preset]).migrationQuoteThreshold;
      const buyerSt = ensureAta(svm, buyer, stMint.publicKey, buyer.publicKey);
      await dbc.buy(svm, buyer, L.pool, h.buyerQuote, buyerSt, R.muln(6).divn(5));
      // anyone migrates through Meteora's live config; the keeper would
      const mig = await dbc.migrateToDammV2(svm, buyer, L.pool, DAMM_V2_MIGRATION_CONFIG.customizable);
      expect(mig.dammPool.equals(v.dammPool)).true; // the derived pool recorded at launch
      const mine = damm.findPositionOwnedBy(svm, [mig.firstPosition, mig.secondPosition], cv.vault)!;
      const theirs = damm.findPositionOwnedBy(svm, [mig.firstPosition, mig.secondPosition], h.owner.publicKey)!;
      // the protocol-side position is not the creator side: rejected
      expectFail(svm, [await client.registerOwnPosition({ vault: cv.vault, payer: buyer.publicKey, streamIndex: 2, dbcPool: L.pool, dbcConfig: h.cfgs[preset], dammPool: mig.dammPool, position: theirs.position, nftAccount: theirs.nftAccount })], [buyer], "AccountMismatch");
      send(svm, [await client.registerOwnPosition({ vault: cv.vault, payer: buyer.publicKey, streamIndex: 2, dbcPool: L.pool, dbcConfig: h.cfgs[preset], dammPool: mig.dammPool, position: mine.position, nftAccount: mine.nftAccount })], [buyer], { label: "register_own_position" });
      const live = client.decodeVault(Buffer.from(svm.getAccount(cv.vault)!.data));
      expect(live.status).deep.eq({ live: {} });
      expect(live.ownPosition.equals(mine.position)).true;
      // cash-out: exactly R - ceil(R * (100 - p) / 100) to the depositor's pinned WSOL ATA; a second call has nothing left
      const p = [25, 50, 75][preset];
      const d0 = balance(svm, cv.depositorWsol);
      send(svm, [cashoutIx], [buyer], { label: "cashout" });
      const expected = R.sub(R.muln(100 - p).addn(99).divn(100));
      expect(balance(svm, cv.depositorWsol).sub(d0).toString()).eq(expected.toString());
      expect(client.decodeVault(Buffer.from(svm.getAccount(cv.vault)!.data)).accounting.cashedOut.toString()).eq(expected.toString());
      expectFail(svm, [cashoutIx], [buyer], "WrongStatus");
    });
  }

  it("register_pair: write-once; rejects a liquidity-mining pair, a pair of other mints, and accepts a proper limit-order pair with the bin bound derived from the cap", async () => {
    const h = await setup(1);
    const { svm, client, creator, keeper, cv, stMint } = h;
    const L = await client.launch({ vault: cv.vault, depositor: creator.publicKey, stMint: stMint.publicKey, config: h.cfgs[1], preset: 1, streamIndex: 1, metadata: { name: "tail", symbol: "tTKN", uri: "https://cometail.fun/t.json" } });
    send(svm, [L.ix], [creator, stMint], { cu: 800_000 });
    // the keeper needs a little ST to be the pair funder: buy dust on the curve
    const keeperQuote = wrapSol(svm, keeper, new BN(2_000_000_000));
    const keeperSt = ensureAta(svm, keeper, stMint.publicKey, keeper.publicKey);
    await dbc.buy(svm, keeper, L.pool, keeperQuote, keeperSt, new BN(100_000_000));
    // a liquidity-mining pair for the same mints occupies the customizable address: rejected
    const lm = await dlmm.initPairIx({ x: stMint.publicKey, y: NATIVE_MINT, funder: keeper.publicKey, userTokenX: keeperSt, userTokenY: keeperQuote, binStep: 100, baseFactor: 1000, functionType: dlmm.ConcreteFunctionType.LiquidityMining });
    send(svm, [lm.ix], [keeper], { cu: 400_000 });
    expectFail(svm, [await client.registerPair({ vault: cv.vault, lbPair: lm.pair })], [keeper], "Ineligible");
    // a proper pair for other mints is not this vault's pair
    const other = createMint(svm, keeper, 6);
    const keeperOther = mintTo(svm, keeper, other, keeper.publicKey, new BN(1_000_000));
    const op = await dlmm.initPairIx({ x: other, y: NATIVE_MINT, funder: keeper.publicKey, userTokenX: keeperOther, userTokenY: keeperQuote, binStep: 100, baseFactor: 1000 });
    send(svm, [op.ix], [keeper], { cu: 400_000 });
    expectFail(svm, [await client.registerPair({ vault: cv.vault, lbPair: op.pair })], [keeper], "AccountMismatch");
    // nothing registered yet
    expect(client.decodeVault(Buffer.from(svm.getAccount(cv.vault)!.data)).dlmmPair.equals(require("@solana/web3.js").PublicKey.default)).true;
    void TOKEN_PROGRAM_ID;
  });

  it("register_pair: a proper limit-order pair registers once with the orientation and the cap-derived bin bound; a second registration is a duplicate", async () => {
    const h = await setup(1);
    const { svm, client, creator, keeper, cv, stMint } = h;
    const L = await client.launch({ vault: cv.vault, depositor: creator.publicKey, stMint: stMint.publicKey, config: h.cfgs[1], preset: 1, streamIndex: 1, metadata: { name: "tail", symbol: "tTKN", uri: "https://cometail.fun/t.json" } });
    send(svm, [L.ix], [creator, stMint], { cu: 800_000 });
    const keeperQuote = wrapSol(svm, keeper, new BN(2_000_000_000));
    const keeperSt = ensureAta(svm, keeper, stMint.publicKey, keeper.publicKey);
    await dbc.buy(svm, keeper, L.pool, keeperQuote, keeperSt, new BN(100_000_000));
    const pair = await dlmm.initPairIx({ x: stMint.publicKey, y: NATIVE_MINT, funder: keeper.publicKey, userTokenX: keeperSt, userTokenY: keeperQuote, binStep: 100, baseFactor: 1000 });
    send(svm, [pair.ix], [keeper], { cu: 400_000 });
    send(svm, [await client.registerPair({ vault: cv.vault, lbPair: pair.pair })], [keeper], { label: "register_pair" });
    const v = client.decodeVault(Buffer.from(svm.getAccount(cv.vault)!.data));
    expect(v.dlmmPair.equals(pair.pair)).true;
    expect(v.stIsX).eq(dlmm.getPair(svm, pair.pair).tokenXMint.equals(stMint.publicKey));
    // cap = 10 lamports per raw ST unit (10 * 2^64 in Q64): with ST as X the bound is the last bin with price <= 10,
    // i.e. floor(ln(10)/ln(1.01)) = 231; with ST as Y it is the first bin with price >= 1/10, i.e. -231
    expect(v.binBound).eq(v.stIsX ? 231 : -231);
    expectFail(svm, [await client.registerPair({ vault: cv.vault, lbPair: pair.pair })], [keeper], "Duplicate");
  });
});
