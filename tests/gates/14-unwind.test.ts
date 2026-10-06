// Gate 14: a launched vault whose curve never reaches its threshold is not a trap. After the
// unwind window the depositor closes the vault for good in one instruction: the stream token's
// creator rights return to the depositor, the income the vault collected is paid out, the own
// stream closes; the deposited streams leave through withdraw_stream. A later graduation of
// the curve hands its creator position to the depositor, never to the vault, and nothing on the
// vault runs again. The curve keeps trading, buys and sells alike. Before the window, after the
// threshold, or by anyone but the depositor, the unwind is rejected. Also: an Open vault cannot
// drop migrated rights whose creator position is not registered on the stream yet.
import { BN } from "@coral-xyz/anchor";
import { Keypair, PublicKey } from "@solana/web3.js";
import { NATIVE_MINT, TOKEN_2022_PROGRAM_ID, createTransferCheckedInstruction, createTransferInstruction } from "@solana/spl-token";
import { expect } from "chai";
import { VaultClientStep6, deriveStream, deriveStreamIndex, dammPositionNftAccount } from "@cometail/client";
import { startSvm, fund, DAMM_V2_MIGRATION_CONFIG } from "../harness/svm";
import { send, expectFail } from "../harness/tx";
import { ataIx, ensureAta, balance, wrapSol } from "../harness/tokens";
import * as dbc from "../harness/dbc";
import * as damm from "../harness/damm";

const policy = { maxSpendPerPeriod: new BN(5_000_000_000), periodSeconds: new BN(3600), maxOutstandingOrders: 4, maxBinsPerOrder: 20, maxPriceQ64: new BN(1).shln(64).muln(10) };
const WINDOW = 30 * 24 * 60 * 60;

function warp(svm: any, seconds: number) {
  const clock = svm.getClock();
  clock.unixTimestamp = clock.unixTimestamp + BigInt(seconds);
  svm.setClock(clock);
}

/** Protocol with the presets, a creator's external plain launch on ANOTHER launchpad's config (its own
 *  partner as fee claimer and leftover receiver), a vault created by the creator. */
async function world() {
  const owner = Keypair.generate();
  const svm = startSvm({ upgradeAuthority: owner.publicKey });
  svm.airdrop(owner.publicKey, BigInt(100_000_000_000));
  const client = new VaultClientStep6();
  const keeper = fund(svm), creator = fund(svm), buyer = fund(svm), stranger = fund(svm), anyone = fund(svm), otherPartner = fund(svm);
  const treasury = ensureAta(svm, owner, NATIVE_MINT, owner.publicKey);
  const cfgs = [] as any[];
  for (const n of ["stream-25", "stream-50", "stream-75"] as const) cfgs.push(await dbc.createConfig(svm, { payer: owner, feeClaimer: owner.publicKey, leftoverReceiver: owner.publicKey, quoteMint: NATIVE_MINT, params: dbc.configParams(n) }));
  send(svm, [await client.initProtocol({ admin: owner.publicKey, keeper: keeper.publicKey, payer: owner.publicKey, streamConfigs: cfgs as any })], [owner]);
  const plain = await dbc.createConfig(svm, { payer: otherPartner, feeClaimer: otherPartner.publicKey, leftoverReceiver: otherPartner.publicKey, quoteMint: NATIVE_MINT, params: dbc.configParams("plain") });
  expect(dbc.getConfig(svm, plain).feeClaimer.equals(otherPartner.publicKey)).true;
  const mint = Keypair.generate();
  const ext = await dbc.createPoolIx({ config: plain, baseMint: mint.publicKey, quoteMint: NATIVE_MINT, creator: creator.publicKey, payer: creator.publicKey });
  send(svm, [ext.ix], [creator, mint], { cu: 600_000 });
  const R: BN = dbc.getConfig(svm, plain).migrationQuoteThreshold;
  const buyerQuote = wrapSol(svm, buyer, R.muln(12));
  const buyerBase = ensureAta(svm, buyer, mint.publicKey, buyer.publicKey);
  const stMint = Keypair.generate();
  const cv = await client.createVault({ depositor: creator.publicKey, stMint: stMint.publicKey, policy });
  send(svm, [cv.ix], [creator, cv.placeholder, stMint]);
  return { svm, client, owner, keeper, creator, buyer, stranger, anyone, otherPartner, treasury, cfgs, plain, ext, mint, R, buyerQuote, buyerBase, stMint, cv };
}

/** The external pool filled and migrated, its creator position deposited, the vault launched on preset 0. */
async function launched() {
  const w = await world();
  const { svm, client, creator, buyer, cfgs, ext, mint, R, buyerQuote, buyerBase, stMint, cv } = w;
  await dbc.buy(svm, buyer, ext.pool, buyerQuote, buyerBase, R.muln(6).divn(5));
  const mig = await dbc.migrateToDammV2(svm, buyer, ext.pool, DAMM_V2_MIGRATION_CONFIG.customizable);
  const creatorPos = damm.findPositionOwnedBy(svm, [mig.firstPosition, mig.secondPosition], creator.publicKey)!;
  const nftMint = creatorPos.state.nftMint;
  const vaultNft = ataIx(creator.publicKey, nftMint, cv.vault, TOKEN_2022_PROGRAM_ID);
  send(svm, [vaultNft.ix, createTransferCheckedInstruction(creatorPos.nftAccount, nftMint, vaultNft.address, creator.publicKey, 1, 0, [], TOKEN_2022_PROGRAM_ID)], [creator]);
  send(svm, [await client.depositPosition({ vault: cv.vault, depositor: creator.publicKey, streamIndex: 0, dammPool: mig.dammPool, position: creatorPos.position, nftMint, nftAccount: vaultNft.address, baseMint: mint.publicKey })], [creator]);
  const L = await client.launch({ vault: cv.vault, depositor: creator.publicKey, stMint: stMint.publicKey, config: cfgs[0], preset: 0, streamIndex: 1, metadata: { name: "tail", symbol: "tTKN", uri: "https://cometail.fun/t.json" } });
  send(svm, [L.ix], [creator, stMint], { cu: 500_000, label: "launch" });
  const ownStream = deriveStream(cv.vault, 1);
  const unwindIx = (signer = creator.publicKey) => client.unwind({ vault: cv.vault, depositor: signer, ownStream, dbcPool: L.pool, dbcConfig: cfgs[0], incomeWsol: cv.incomeWsol, depositorWsol: cv.depositorWsol });
  return { ...w, L, ownStream, nftMint, vaultNft: vaultNft.address, creatorPos, mig, unwindIx };
}

describe("unwind: a launched vault whose curve never graduates goes back to the depositor", () => {
  it("rejects before the window and by a stranger; at exactly the window the depositor unwinds: rights back, income paid, own stream closed; streams withdraw; a late graduation hands its position to the depositor, register_own_position and cashout stay closed; the curve trades on", async () => {
    const h = await launched();
    const { svm, client, creator, buyer, stranger, anyone, cv, L, cfgs, stMint } = h;
    // early buys on the stream token's curve, below the threshold: real creator fees for the vault
    const buyerSt = ensureAta(svm, buyer, stMint.publicKey, buyer.publicKey);
    const R: BN = dbc.getConfig(svm, cfgs[0]).migrationQuoteThreshold;
    await dbc.buy(svm, buyer, L.pool, h.buyerQuote, buyerSt, R.divn(10));
    const ownPs = dbc.getPool(svm, L.pool);
    send(svm, [await client.harvestDbc({ vault: cv.vault, stream: h.ownStream, incomeWsol: cv.incomeWsol, placeholderWsol: cv.placeholder.publicKey, depositorWsol: cv.depositorWsol, treasury: h.treasury, dbcPool: L.pool, baseVault: ownPs.baseVault, quoteVault: ownPs.quoteVault, baseMint: stMint.publicKey })], [anyone], { label: "harvest_dbc.own" });
    const harvestedIncome = balance(svm, cv.incomeWsol);
    expect(harvestedIncome.gtn(0)).true;
    // and a donation on top: the unwind returns whatever the income account holds
    const donation = new BN(123_456_789);
    send(svm, [createTransferInstruction(h.buyerQuote, cv.incomeWsol, buyer.publicKey, BigInt(donation.toString()))], [buyer]);
    const incomeHeld = balance(svm, cv.incomeWsol);
    // before the window: too early, even one second short
    expectFail(svm, [await h.unwindIx()], [creator], "TooEarly");
    warp(svm, WINDOW - 1);
    expectFail(svm, [await h.unwindIx()], [creator], "TooEarly");
    warp(svm, 1);
    // exactly at the window: a stranger cannot, the depositor can
    expectFail(svm, [await h.unwindIx(stranger.publicKey)], [stranger], "NotDepositor");
    const d0 = balance(svm, cv.depositorWsol);
    const acc0 = client.decodeVault(Buffer.from(svm.getAccount(cv.vault)!.data)).accounting;
    send(svm, [await h.unwindIx()], [creator], { label: "unwind" });
    expect(balance(svm, cv.depositorWsol).sub(d0).toString()).eq(incomeHeld.toString());
    expect(balance(svm, cv.incomeWsol).toString()).eq("0");
    const v = client.decodeVault(Buffer.from(svm.getAccount(cv.vault)!.data));
    expect(v.status).deep.eq({ unwound: {} });
    expect(v.activeStreams).eq(1);
    // the accounting stays cumulative: nothing in it moved
    expect(v.accounting.toDepositor.toString()).eq(acc0.toDepositor.toString());
    expect(v.accounting.income.toString()).eq(acc0.income.toString());
    // the creator rights are the depositor's again and the own stream and its index are closed
    expect(dbc.getPool(svm, L.pool).creator.equals(creator.publicKey)).true;
    const closed = (k: PublicKey) => { const a = svm.getAccount(k); return a === null || Number(a.lamports) === 0; };
    expect(closed(h.ownStream)).true;
    expect(closed(deriveStreamIndex(L.pool))).true;
    // twice is not possible: the own stream is gone
    expectFail(svm, [await h.unwindIx()], [creator], "AccountNotInitialized");
    // the deposited position goes back
    const deposited = client.decodeStream(Buffer.from(svm.getAccount(deriveStream(cv.vault, 0))!.data));
    const back = ataIx(creator.publicKey, h.nftMint, creator.publicKey, TOKEN_2022_PROGRAM_ID);
    send(svm, [back.ix, await client.withdrawStream({ vault: cv.vault, depositor: creator.publicKey, stream: deriveStream(cv.vault, 0), kind: "position", indexKey: deposited.position, nftAccount: h.vaultNft, nftMint: h.nftMint, depositorNftAccount: back.address })], [creator]);
    expect(balance(svm, back.address).toString()).eq("1");
    expect(client.decodeVault(Buffer.from(svm.getAccount(cv.vault)!.data)).activeStreams).eq(0);
    // the other launchpad's partner fee on the source coin was never the vault's to take: it is still
    // there for that partner, on a config the vault never touched
    const source = dbc.getPool(svm, h.ext.pool);
    expect(dbc.getConfig(svm, h.plain).feeClaimer.equals(h.otherPartner.publicKey)).true;
    expect(source.partnerQuoteFee.gtn(0)).true;
    // the curve keeps trading: a holder sells back, then buyers complete it and it migrates
    const sellIx = await dbc.swap2Ix(svm, { pool: L.pool, payer: buyer.publicKey, inputMint: stMint.publicKey, outputMint: NATIVE_MINT, inputAccount: buyerSt, outputAccount: h.buyerQuote, amount0: balance(svm, buyerSt).divn(2), amount1: new BN(0), mode: dbc.SwapMode.ExactIn });
    send(svm, [sellIx], [buyer], { label: "dbc.sell after unwind" });
    await dbc.buy(svm, buyer, L.pool, h.buyerQuote, buyerSt, R.muln(6).divn(5));
    const mig = await dbc.migrateToDammV2(svm, buyer, L.pool, DAMM_V2_MIGRATION_CONFIG.customizable);
    // the migration's creator position belongs to the depositor, not to the vault
    expect(damm.findPositionOwnedBy(svm, [mig.firstPosition, mig.secondPosition], creator.publicKey)).not.null;
    expect(damm.findPositionOwnedBy(svm, [mig.firstPosition, mig.secondPosition], cv.vault)).null;
    const pos = damm.findPositionOwnedBy(svm, [mig.firstPosition, mig.secondPosition], creator.publicKey)!;
    // nothing on the vault runs again
    expectFail(svm, [await client.registerOwnPosition({ vault: cv.vault, payer: buyer.publicKey, streamIndex: 2, dbcPool: L.pool, dbcConfig: cfgs[0], dammPool: mig.dammPool, position: pos.position, nftAccount: pos.nftAccount })], [buyer], "WrongStatus");
    const ps = dbc.getPool(svm, L.pool);
    expectFail(svm, [await client.cashout({ vault: cv.vault, dbcPool: L.pool, dbcConfig: cfgs[0], quoteVault: ps.quoteVault, depositorWsol: cv.depositorWsol })], [buyer], "WrongStatus");
    expect(client.decodeVault(Buffer.from(svm.getAccount(cv.vault)!.data)).status).deep.eq({ unwound: {} });
  });

  it("a curve that reached its threshold cannot be unwound, however long it waits", async () => {
    const h = await launched();
    const { svm, creator, buyer, L, cfgs, stMint } = h;
    const R: BN = dbc.getConfig(svm, cfgs[0]).migrationQuoteThreshold;
    const buyerSt = ensureAta(svm, buyer, stMint.publicKey, buyer.publicKey);
    await dbc.buy(svm, buyer, L.pool, h.buyerQuote, buyerSt, R.muln(6).divn(5));
    warp(svm, WINDOW + 1);
    expectFail(svm, [await h.unwindIx()], [creator], "NotUnwindable");
  });

  it("an Open vault cannot drop migrated rights before their creator position is registered; registered, they leave together", async () => {
    const w = await world();
    const { svm, client, creator, buyer, anyone, ext, plain, mint, R, buyerQuote, buyerBase, cv } = w;
    const xfer = await dbc.transferPoolCreatorIx(svm, ext.pool, creator.publicKey, cv.vault);
    send(svm, [xfer, await client.depositDbcRights({ vault: cv.vault, depositor: creator.publicKey, streamIndex: 0, dbcPool: ext.pool, dbcConfig: plain, baseMint: mint.publicKey })], [creator]);
    await dbc.buy(svm, buyer, ext.pool, buyerQuote, buyerBase, R.muln(6).divn(5));
    const mig = await dbc.migrateToDammV2(svm, buyer, ext.pool, DAMM_V2_MIGRATION_CONFIG.customizable);
    const stream = deriveStream(cv.vault, 0);
    const withdrawRightsOnly = await client.withdrawStream({ vault: cv.vault, depositor: creator.publicKey, stream, kind: "dbc", indexKey: ext.pool, dbcPool: ext.pool, dbcConfig: plain });
    expectFail(svm, [withdrawRightsOnly], [creator], "RegisterPositionFirst");
    const vaultPos = damm.findPositionOwnedBy(svm, [mig.firstPosition, mig.secondPosition], cv.vault)!;
    send(svm, [await client.registerStreamPosition({ vault: cv.vault, stream, payer: anyone.publicKey, dbcPool: ext.pool, dbcConfig: plain, dammPool: mig.dammPool, position: vaultPos.position, nftAccount: vaultPos.nftAccount })], [anyone]);
    const s = client.decodeStream(Buffer.from(svm.getAccount(stream)!.data));
    expect(s.position.equals(vaultPos.position)).true;
    send(svm, [await client.withdrawStream({ vault: cv.vault, depositor: creator.publicKey, stream, kind: "dbc", indexKey: ext.pool, position: vaultPos.position, dbcPool: ext.pool, dbcConfig: plain, nftAccount: vaultPos.nftAccount, nftMint: s.nftMint })], [creator]);
    expect(dbc.getPool(svm, ext.pool).creator.equals(creator.publicKey)).true;
    const gone = svm.getAccount(stream);
    expect(gone === null || Number(gone.lamports) === 0).true;
  });
});
