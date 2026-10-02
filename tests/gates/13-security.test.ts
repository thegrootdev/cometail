// Gate 13: regressions for the security pass over 35ec647..16b35a2 (eleven findings), with the
// verifier's four focused invariants folded in: one active stream per position, the active
// count follows custody, unrelated LP additions do not break registration, and registration
// preserves creator-position identity. Every case here failed or was unreachable before the fix.
import { BN } from "@coral-xyz/anchor";
import { Keypair, PublicKey } from "@solana/web3.js";
import { NATIVE_MINT, TOKEN_2022_PROGRAM_ID, TOKEN_PROGRAM_ID, createTransferCheckedInstruction } from "@solana/spl-token";
import { expect } from "chai";
import { VaultClientStep5, deriveStream, deriveStreamIndex, dammPositionNftAccount, handPositionNftToVaultIx } from "@cometail/client";
import { startSvm, fund, DAMM_V2_MIGRATION_CONFIG } from "../harness/svm";
import { send, expectFail } from "../harness/tx";
import { ataIx, ensureAta, balance, wrapSol, tokenOwner, createMint2022, mintTo2022 } from "../harness/tokens";
import * as dbc from "../harness/dbc";
import * as damm from "../harness/damm";
import * as dlmm from "../harness/dlmm";

const policy = { maxSpendPerPeriod: new BN(5_000_000_000), periodSeconds: new BN(3600), maxOutstandingOrders: 4, maxBinsPerOrder: 20, maxPriceQ64: new BN(1).shln(64).muln(10) };
/** A closed account: LiteSVM keeps a zero-lamport shell for it. */
const closed = (svm: any, pk: PublicKey) => { const a = svm.getAccount(pk); return !a || Number(a.lamports) === 0; };
const META = { name: "tail", symbol: "tTKN", uri: "https://cometail.fun/t.json" };

function configWith(name: "plain" | "stream-25", overrides: (p: any) => void) {
  const p = JSON.parse(JSON.stringify(require(`../../configs/${name}.json`)));
  overrides(p);
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { buildCurveWithMarketCap } = require("@meteora-ag/dynamic-bonding-curve-sdk");
  return dbc.normalize(buildCurveWithMarketCap(p));
}

/** Protocol with the three presets owned by `owner`; actors funded. */
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
  return { svm, client, owner, keeper, creator, buyer, anyone, treasury, cfgs };
}

/** An external plain launch by `creator` (partner = `owner`), open or filled + migrated. */
async function external(w: any, fill: boolean, params: any = dbc.configParams("plain"), token2022 = false) {
  const config = await dbc.createConfig(w.svm, { payer: w.owner, feeClaimer: w.owner.publicKey, leftoverReceiver: w.owner.publicKey, quoteMint: NATIVE_MINT, params });
  const mint = Keypair.generate();
  const L = token2022
    ? await dbc.createPool2022Ix({ config, baseMint: mint.publicKey, quoteMint: NATIVE_MINT, creator: w.creator.publicKey, payer: w.creator.publicKey })
    : await dbc.createPoolIx({ config, baseMint: mint.publicKey, quoteMint: NATIVE_MINT, creator: w.creator.publicKey, payer: w.creator.publicKey });
  send(w.svm, [L.ix], [w.creator, mint], { cu: 600_000 });
  const R: BN = dbc.getConfig(w.svm, config).migrationQuoteThreshold;
  const buyerQuote = wrapSol(w.svm, w.buyer, R.muln(6));
  const buyerBase = ensureAta(w.svm, w.buyer, mint.publicKey, w.buyer.publicKey, token2022 ? TOKEN_2022_PROGRAM_ID : TOKEN_PROGRAM_ID);
  await dbc.buy(w.svm, w.buyer, L.pool, buyerQuote, buyerBase, R.divn(3));
  if (!fill) return { config, mint: mint.publicKey, pool: L.pool, R, buyerQuote, buyerBase };
  await dbc.buy(w.svm, w.buyer, L.pool, buyerQuote, buyerBase, R.muln(6).divn(5));
  const mig = await dbc.migrateToDammV2(w.svm, w.buyer, L.pool, DAMM_V2_MIGRATION_CONFIG.customizable);
  const creatorPos = damm.findPositionOwnedBy(w.svm, [mig.firstPosition, mig.secondPosition], w.creator.publicKey)!;
  const partnerPos = damm.findPositionOwnedBy(w.svm, [mig.firstPosition, mig.secondPosition], w.owner.publicKey)!;
  return { config, mint: mint.publicKey, pool: L.pool, R, buyerQuote, buyerBase, dammPool: mig.dammPool, creatorPos, partnerPos };
}

function newVault(w: any, depositor: Keypair, pol = policy) {
  const stMint = Keypair.generate();
  return w.client.createVault({ depositor: depositor.publicKey, stMint: stMint.publicKey, policy: pol }).then((cv: any) => { send(w.svm, [cv.ix], [depositor, cv.placeholder, stMint]); return { ...cv, stMint }; });
}
const vaultOf = (w: any, cv: any) => w.client.decodeVault(Buffer.from(w.svm.getAccount(cv.vault)!.data));
const streamOf = (w: any, key: PublicKey) => w.client.decodeStream(Buffer.from(w.svm.getAccount(key)!.data));
function harvestArgs(w: any, cv: any, stream: PublicKey) {
  return { vault: cv.vault, stream, incomeWsol: cv.incomeWsol, placeholderWsol: cv.placeholder.publicKey, depositorWsol: cv.depositorWsol, treasury: w.treasury };
}

describe("gate 13: security regressions", () => {
  it("F7 + F8 + F5 (verifier 01, 02): a bundled creator position has its own index and cannot enter again; withdrawal requires that index, hands the PDA account back, closes both indices and takes the active count to 0; the sources enter again afterwards; launch refuses a vault whose streams were all withdrawn", async () => {
    const w = await world();
    const { svm, client, creator } = w;
    const ext = await external(w, true);
    const cv = await newVault(w, creator);
    const nftMint = ext.creatorPos.state.nftMint;
    const pda = ext.creatorPos.nftAccount;
    expect(pda.equals(dammPositionNftAccount(nftMint))).true;
    const xfer = await dbc.transferPoolCreatorIx(svm, ext.pool, creator.publicKey, cv.vault);
    const dep = await client.depositDbcRightsMigrated({ vault: cv.vault, depositor: creator.publicKey, streamIndex: 0, dbcPool: ext.pool, dbcConfig: ext.config, baseMint: ext.mint, dammPool: ext.dammPool, creatorPosition: ext.creatorPos.position, creatorNftAccount: pda });
    send(svm, [xfer, handPositionNftToVaultIx(nftMint, creator.publicKey, cv.vault), dep], [creator], { label: "deposit_dbc_rights_migrated" });
    expect(vaultOf(w, cv).activeStreams).eq(1);
    // verifier 01: the bundled position cannot be recorded again as a standalone stream
    const again = await client.depositPosition({ vault: cv.vault, depositor: creator.publicKey, streamIndex: 1, dammPool: ext.dammPool, position: ext.creatorPos.position, nftMint, nftAccount: pda, baseMint: ext.mint });
    expectFail(svm, [again], [creator], "already in use");
    // F8: the position index is required, and must belong to this stream
    const s0 = deriveStream(cv.vault, 0);
    expectFail(svm, [await client.withdrawStream({ vault: cv.vault, depositor: creator.publicKey, stream: s0, kind: "dbc", indexKey: ext.pool, dbcPool: ext.pool, dbcConfig: ext.config, nftAccount: pda, nftMint })], [creator], "AccountMismatch");
    send(svm, [await client.withdrawStream({ vault: cv.vault, depositor: creator.publicKey, stream: s0, kind: "dbc", indexKey: ext.pool, position: ext.creatorPos.position, dbcPool: ext.pool, dbcConfig: ext.config, nftAccount: pda, nftMint })], [creator], { label: "withdraw_stream.migrated" });
    // verifier 02: the active count follows custody
    expect(vaultOf(w, cv).activeStreams).eq(0);
    expect(vaultOf(w, cv).streamCount).eq(1); // the PDA index is monotonic
    expect(closed(svm, s0)).true;
    expect(closed(svm, deriveStreamIndex(ext.pool))).true;
    expect(closed(svm, deriveStreamIndex(ext.creatorPos.position))).true;
    expect(tokenOwner(svm, pda).equals(creator.publicKey)).true;
    expect(dbc.getPool(svm, ext.pool).creator.equals(creator.publicKey)).true;
    // F5: nothing backs the vault now; launch refuses
    const L = await client.launch({ vault: cv.vault, depositor: creator.publicKey, stMint: cv.stMint.publicKey, config: w.cfgs[1], preset: 1, streamIndex: 1, metadata: META });
    expectFail(svm, [L.ix], [creator, cv.stMint], "Ineligible", { cu: 800_000 });
    // index cleanup regression: the same position enters again as a standalone stream (PDA account handed over again)
    const re = await client.depositPosition({ vault: cv.vault, depositor: creator.publicKey, streamIndex: 1, dammPool: ext.dammPool, position: ext.creatorPos.position, nftMint, nftAccount: pda, baseMint: ext.mint });
    send(svm, [handPositionNftToVaultIx(nftMint, creator.publicKey, cv.vault), re], [creator], { label: "deposit_position.after_withdrawal" });
    expect(vaultOf(w, cv).activeStreams).eq(1);
    expect(streamOf(w, deriveStream(cv.vault, 1)).position.equals(ext.creatorPos.position)).true;
    // and the rights enter again too, now as a migrated bundle is impossible (the position is taken), so rights-only is refused as well: the pool graduated
    expectFail(svm, [await dbc.transferPoolCreatorIx(svm, ext.pool, creator.publicKey, cv.vault), await client.depositDbcRights({ vault: cv.vault, depositor: creator.publicKey, streamIndex: 2, dbcPool: ext.pool, dbcConfig: ext.config, baseMint: ext.mint })], [creator], "WrongStatus");
    // a position stream withdraws through the PDA path as well
    send(svm, [await client.withdrawStream({ vault: cv.vault, depositor: creator.publicKey, stream: deriveStream(cv.vault, 1), kind: "position", indexKey: ext.creatorPos.position, nftAccount: pda, nftMint })], [creator]);
    expect(tokenOwner(svm, pda).equals(creator.publicKey)).true;
    expect(vaultOf(w, cv).activeStreams).eq(0);
    // with a stream back in, launch works
    send(svm, [handPositionNftToVaultIx(nftMint, creator.publicKey, cv.vault), await client.depositPosition({ vault: cv.vault, depositor: creator.publicKey, streamIndex: 2, dammPool: ext.dammPool, position: ext.creatorPos.position, nftMint, nftAccount: pda, baseMint: ext.mint })], [creator]);
    const L2 = await client.launch({ vault: cv.vault, depositor: creator.publicKey, stMint: cv.stMint.publicKey, config: w.cfgs[1], preset: 1, streamIndex: 3, metadata: META });
    send(svm, [L2.ix], [creator, cv.stMint], { cu: 800_000 });
    expect(vaultOf(w, cv).activeStreams).eq(2);
  });

  it("F2 + F3 + F9 (verifier 03, 04): registration survives an unrelated 1% LP addition; the partner position is rejected whether it sits in a vault ATA or in its PDA account handed to the vault; a dust position cannot pose as the creator position at a migrated deposit", async () => {
    const w = await world();
    const { svm, client, creator, buyer, owner, anyone } = w;
    // verifier 03: open curve, rights deposited, then the external migration and a 1% addition by someone else
    const ext = await external(w, false);
    const cv = await newVault(w, creator);
    send(svm, [await dbc.transferPoolCreatorIx(svm, ext.pool, creator.publicKey, cv.vault), await client.depositDbcRights({ vault: cv.vault, depositor: creator.publicKey, streamIndex: 0, dbcPool: ext.pool, dbcConfig: ext.config, baseMint: ext.mint })], [creator]);
    await dbc.buy(svm, buyer, ext.pool, ext.buyerQuote, ext.buyerBase, ext.R.muln(6).divn(5));
    const mig = await dbc.migrateToDammV2(svm, buyer, ext.pool, DAMM_V2_MIGRATION_CONFIG.customizable);
    const genuine = damm.findPositionOwnedBy(svm, [mig.firstPosition, mig.secondPosition], cv.vault)!;
    const partner = damm.findPositionOwnedBy(svm, [mig.firstPosition, mig.secondPosition], owner.publicKey)!;
    const nft = Keypair.generate();
    const addition = await damm.createPositionIx({ pool: mig.dammPool, owner: buyer.publicKey, payer: buyer.publicKey, nftMint: nft });
    send(svm, [addition.ix], [buyer, nft]);
    const L = damm.getPool(svm, mig.dammPool).liquidity.divn(100);
    send(svm, [await damm.addLiquidityIx(svm, { pool: mig.dammPool, position: addition.position, owner: buyer.publicKey, tokenAAccount: ext.buyerBase, tokenBAccount: ext.buyerQuote, liquidityDelta: L })], [buyer], { cu: 400_000 });
    const s0 = deriveStream(cv.vault, 0);
    // verifier 04 (a): the partner NFT moved into a vault-owned ATA is not the creator position
    const dest = ataIx(owner.publicKey, partner.state.nftMint, cv.vault, TOKEN_2022_PROGRAM_ID);
    send(svm, [dest.ix, createTransferCheckedInstruction(partner.nftAccount, partner.state.nftMint, dest.address, owner.publicKey, 1, 0, [], TOKEN_2022_PROGRAM_ID)], [owner]);
    expectFail(svm, [await client.registerStreamPosition({ vault: cv.vault, stream: s0, payer: anyone.publicKey, dbcPool: ext.pool, dbcConfig: ext.config, dammPool: mig.dammPool, position: partner.position, nftAccount: dest.address })], [anyone], "AccountMismatch");
    // verifier 04 (b): even in its own PDA account handed to the vault, the 20% position fails the creator-share bound
    const partner2 = await external(w, true, dbc.configParams("plain"));
    const cv2 = await newVault(w, creator);
    send(svm, [await dbc.transferPoolCreatorIx(svm, partner2.pool, creator.publicKey, cv2.vault), handPositionNftToVaultIx(partner2.partnerPos.state.nftMint, owner.publicKey, cv2.vault)], [creator, owner]);
    expectFail(svm, [await client.depositDbcRightsMigrated({ vault: cv2.vault, depositor: creator.publicKey, streamIndex: 0, dbcPool: partner2.pool, dbcConfig: partner2.config, baseMint: partner2.mint, dammPool: partner2.dammPool, creatorPosition: partner2.partnerPos.position, creatorNftAccount: partner2.partnerPos.nftAccount })], [creator], "AccountMismatch");
    // F3: a dust position in the derived pool, permanently locked and handed to the vault, is not the creator position either
    const dustNft = Keypair.generate();
    const dust = await damm.createPositionIx({ pool: partner2.dammPool, owner: creator.publicKey, payer: creator.publicKey, nftMint: dustNft });
    send(svm, [dust.ix], [creator, dustNft]);
    const cq = wrapSol(svm, creator, new BN(1_000_000_000));
    const cb = ensureAta(svm, creator, partner2.mint, creator.publicKey);
    send(svm, [createTransferCheckedInstruction(partner2.buyerBase, partner2.mint, cb, buyer.publicKey, BigInt(1_000_000), 6)], [buyer]);
    send(svm, [await damm.addLiquidityIx(svm, { pool: partner2.dammPool, position: dust.position, owner: creator.publicKey, tokenAAccount: cb, tokenBAccount: cq, liquidityDelta: new BN(1_000_000) })], [creator], { cu: 400_000 });
    send(svm, [await damm.permanentLockIx(svm, { pool: partner2.dammPool, position: dust.position, owner: creator.publicKey, liquidity: damm.getPosition(svm, dust.position).unlockedLiquidity })], [creator]);
    send(svm, [handPositionNftToVaultIx(dustNft.publicKey, creator.publicKey, cv2.vault)], [creator]);
    expectFail(svm, [await client.depositDbcRightsMigrated({ vault: cv2.vault, depositor: creator.publicKey, streamIndex: 0, dbcPool: partner2.pool, dbcConfig: partner2.config, baseMint: partner2.mint, dammPool: partner2.dammPool, creatorPosition: dust.position, creatorNftAccount: dust.nftAccount })], [creator], "AccountMismatch");
    // the real one passes on cv2
    send(svm, [handPositionNftToVaultIx(partner2.creatorPos.state.nftMint, creator.publicKey, cv2.vault), await client.depositDbcRightsMigrated({ vault: cv2.vault, depositor: creator.publicKey, streamIndex: 0, dbcPool: partner2.pool, dbcConfig: partner2.config, baseMint: partner2.mint, dammPool: partner2.dammPool, creatorPosition: partner2.creatorPos.position, creatorNftAccount: partner2.creatorPos.nftAccount })], [creator]);
    // verifier 03: the genuine registration on the first vault passes after the LP addition
    send(svm, [await client.registerStreamPosition({ vault: cv.vault, stream: s0, payer: anyone.publicKey, dbcPool: ext.pool, dbcConfig: ext.config, dammPool: mig.dammPool, position: genuine.position, nftAccount: genuine.nftAccount })], [anyone], { label: "register_stream_position.after_lp_addition" });
    expect(streamOf(w, s0).position.equals(genuine.position)).true;
    expect(damm.getPosition(svm, genuine.position).delegatePermission).eq(0);
  });

  it("F1: a creator position that came in through DBC rights is harvestable on the derived pool, 1/5 to the treasury; the DBC pool is not accepted as its pool", async () => {
    const w = await world();
    const { svm, client, creator, buyer, anyone, treasury } = w;
    const ext = await external(w, false);
    const cv = await newVault(w, creator);
    send(svm, [await dbc.transferPoolCreatorIx(svm, ext.pool, creator.publicKey, cv.vault), await client.depositDbcRights({ vault: cv.vault, depositor: creator.publicKey, streamIndex: 0, dbcPool: ext.pool, dbcConfig: ext.config, baseMint: ext.mint })], [creator]);
    const L = await client.launch({ vault: cv.vault, depositor: creator.publicKey, stMint: cv.stMint.publicKey, config: w.cfgs[1], preset: 1, streamIndex: 1, metadata: META });
    send(svm, [L.ix], [creator, cv.stMint], { cu: 800_000 });
    await dbc.buy(svm, buyer, ext.pool, ext.buyerQuote, ext.buyerBase, ext.R.muln(6).divn(5));
    const mig = await dbc.migrateToDammV2(svm, buyer, ext.pool, DAMM_V2_MIGRATION_CONFIG.customizable);
    const mine = damm.findPositionOwnedBy(svm, [mig.firstPosition, mig.secondPosition], cv.vault)!;
    const s0 = deriveStream(cv.vault, 0);
    send(svm, [await client.registerStreamPosition({ vault: cv.vault, stream: s0, payer: anyone.publicKey, dbcPool: ext.pool, dbcConfig: ext.config, dammPool: mig.dammPool, position: mine.position, nftAccount: mine.nftAccount })], [anyone]);
    const pool = damm.getPool(svm, mig.dammPool);
    const bBase = ensureAta(svm, buyer, pool.tokenAMint, buyer.publicKey);
    send(svm, [await damm.swapIx(svm, { pool: mig.dammPool, payer: buyer.publicKey, inputAccount: ext.buyerQuote, outputAccount: bBase, amountIn: new BN(5_000_000_000) })], [buyer]);
    const args = { ...harvestArgs(w, cv, s0), position: mine.position, nftAccount: mine.nftAccount, tokenAVault: pool.tokenAVault, tokenBVault: pool.tokenBVault, tokenAMint: pool.tokenAMint };
    expectFail(svm, [await client.harvestPosition({ ...args, dammPool: ext.pool })], [anyone], "AccountOwnedByWrongProgram"); // the DBC pool is not a DAMM v2 pool
    const i0 = balance(svm, cv.incomeWsol), t0 = balance(svm, treasury);
    send(svm, [await client.harvestPosition({ ...args, dammPool: mig.dammPool })], [anyone], { label: "harvest_position.dbc_rights_stream" });
    const got = balance(svm, cv.incomeWsol).sub(i0).add(balance(svm, treasury).sub(t0));
    expect(got.gte(new BN(15_999_990)) && got.lte(new BN(16_000_010))).true; // 80% of the claimable half of 1% of 5 SOL
    expect(balance(svm, treasury).sub(t0).toString()).eq(got.divn(5).toString());
  });

  it("F4: Token-2022 base mints harvest with their own token program (DBC curve fees and DAMM v2 position fees); the SPL program is refused for them", async () => {
    const w = await world();
    const { svm, client, creator, buyer, anyone, treasury } = w;
    // a Token-2022 base launch (config tokenType 1), still on the curve
    const ext = await external(w, false, configWith("plain", (p) => { p.token.tokenType = 1; }), true);
    expect(svm.getAccount(ext.mint)!.owner.equals(TOKEN_2022_PROGRAM_ID)).true;
    const cv = await newVault(w, creator);
    send(svm, [await dbc.transferPoolCreatorIx(svm, ext.pool, creator.publicKey, cv.vault), await client.depositDbcRights({ vault: cv.vault, depositor: creator.publicKey, streamIndex: 0, dbcPool: ext.pool, dbcConfig: ext.config, baseMint: ext.mint })], [creator], { label: "deposit_dbc_rights.token2022" });
    // a Token-2022 base DAMM v2 position (clean mint, compounding, permanently locked)
    const base = createMint2022(svm, w.owner, 6);
    const lpBase = mintTo2022(svm, w.owner, base, creator.publicKey, new BN(1_000_000_000_000));
    const lpWsol = wrapSol(svm, creator, new BN(50_000_000_000));
    const nft = Keypair.generate();
    const init = await damm.initCustomizablePoolIx({ creator: creator.publicKey, payer: creator.publicKey, nftMint: nft, tokenAMint: base, tokenBMint: NATIVE_MINT, tokenAProgram: TOKEN_2022_PROGRAM_ID, tokenBProgram: TOKEN_PROGRAM_ID, payerTokenA: lpBase, payerTokenB: lpWsol, liquidity: new BN("1000000000000000000000000"), sqrtPrice: new BN(1).shln(64), collectFeeMode: 2 });
    send(svm, [init.ix], [creator, nft], { cu: 600_000 });
    send(svm, [await damm.permanentLockIx(svm, { pool: init.pool, position: init.position, owner: creator.publicKey, liquidity: damm.getPosition(svm, init.position).unlockedLiquidity })], [creator]);
    send(svm, [handPositionNftToVaultIx(nft.publicKey, creator.publicKey, cv.vault), await client.depositPosition({ vault: cv.vault, depositor: creator.publicKey, streamIndex: 1, dammPool: init.pool, position: init.position, nftMint: nft.publicKey, nftAccount: init.nftAccount, baseMint: base })], [creator], { label: "deposit_position.token2022_base" });
    const L = await client.launch({ vault: cv.vault, depositor: creator.publicKey, stMint: cv.stMint.publicKey, config: w.cfgs[1], preset: 1, streamIndex: 2, metadata: META });
    send(svm, [L.ix], [creator, cv.stMint], { cu: 800_000 });
    // curve fees
    const ps = dbc.getPool(svm, ext.pool);
    const accrued: BN = ps.creatorQuoteFee;
    expect(accrued.gtn(0)).true;
    const dArgs = { ...harvestArgs(w, cv, deriveStream(cv.vault, 0)), dbcPool: ext.pool, baseVault: ps.baseVault, quoteVault: ps.quoteVault, baseMint: ext.mint };
    expectFail(svm, [await client.harvestDbc({ ...dArgs, baseTokenProgram: TOKEN_PROGRAM_ID })], [anyone], "AccountMismatch");
    const t0 = balance(svm, treasury), i0 = balance(svm, cv.incomeWsol);
    send(svm, [await client.harvestDbc({ ...dArgs, baseTokenProgram: TOKEN_2022_PROGRAM_ID })], [anyone], { label: "harvest_dbc.token2022" });
    expect(balance(svm, treasury).sub(t0).toString()).eq(accrued.divn(5).toString());
    expect(balance(svm, cv.incomeWsol).sub(i0).toString()).eq(accrued.sub(accrued.divn(5)).toString());
    // position fees
    const pool = damm.getPool(svm, init.pool);
    const bq = wrapSol(svm, buyer, new BN(5_000_000_000));
    const bBase = ensureAta(svm, buyer, base, buyer.publicKey, TOKEN_2022_PROGRAM_ID);
    send(svm, [await damm.swapIx(svm, { pool: init.pool, payer: buyer.publicKey, inputAccount: bq, outputAccount: bBase, amountIn: new BN(5_000_000_000) })], [buyer]);
    const pArgs = { ...harvestArgs(w, cv, deriveStream(cv.vault, 1)), dammPool: init.pool, position: init.position, nftAccount: init.nftAccount, tokenAVault: pool.tokenAVault, tokenBVault: pool.tokenBVault, tokenAMint: base };
    expectFail(svm, [await client.harvestPosition({ ...pArgs, tokenAProgram: TOKEN_PROGRAM_ID })], [anyone], "AccountMismatch");
    const i1 = balance(svm, cv.incomeWsol), t1 = balance(svm, treasury);
    send(svm, [await client.harvestPosition({ ...pArgs, tokenAProgram: TOKEN_2022_PROGRAM_ID })], [anyone], { label: "harvest_position.token2022" });
    const got = balance(svm, cv.incomeWsol).sub(i1).add(balance(svm, treasury).sub(t1));
    expect(got.gtn(0)).true;
    expect(balance(svm, treasury).sub(t1).toString()).eq(got.divn(5).toString());
  });

  it("F6: register_pair needs the keeper or the depositor and refuses a base fee above 1%", async () => {
    const w = await world();
    const { svm, client, creator, keeper, anyone } = w;
    const ext = await external(w, true);
    // vault A: a 2% pair squats the customizable address: rejected even by the keeper
    const cvA = await newVault(w, creator);
    send(svm, [handPositionNftToVaultIx(ext.creatorPos.state.nftMint, creator.publicKey, cvA.vault), await client.depositPosition({ vault: cvA.vault, depositor: creator.publicKey, streamIndex: 0, dammPool: ext.dammPool, position: ext.creatorPos.position, nftMint: ext.creatorPos.state.nftMint, nftAccount: ext.creatorPos.nftAccount, baseMint: ext.mint })], [creator]);
    const LA = await client.launch({ vault: cvA.vault, depositor: creator.publicKey, stMint: cvA.stMint.publicKey, config: w.cfgs[1], preset: 1, streamIndex: 1, metadata: META });
    send(svm, [LA.ix], [creator, cvA.stMint], { cu: 800_000 });
    const anyQuote = wrapSol(svm, anyone, new BN(2_000_000_000));
    const anySt = ensureAta(svm, anyone, cvA.stMint.publicKey, anyone.publicKey);
    await dbc.buy(svm, anyone, LA.pool, anyQuote, anySt, new BN(100_000_000));
    const fat = await dlmm.initPairIx({ x: cvA.stMint.publicKey, y: NATIVE_MINT, funder: anyone.publicKey, userTokenX: anySt, userTokenY: anyQuote, binStep: 100, baseFactor: 20000 }); // 20000 * 100 * 10 = 2e7 = 2%
    send(svm, [fat.ix], [anyone], { cu: 400_000 });
    expectFail(svm, [await client.registerPair({ vault: cvA.vault, signer: keeper.publicKey, lbPair: fat.pair })], [keeper], "Ineligible");
    // vault B: a proper 0.1% pair; a stranger cannot bind it, the depositor can
    const cvB = await newVault(w, creator);
    const ext2 = await external(w, true);
    send(svm, [handPositionNftToVaultIx(ext2.creatorPos.state.nftMint, creator.publicKey, cvB.vault), await client.depositPosition({ vault: cvB.vault, depositor: creator.publicKey, streamIndex: 0, dammPool: ext2.dammPool, position: ext2.creatorPos.position, nftMint: ext2.creatorPos.state.nftMint, nftAccount: ext2.creatorPos.nftAccount, baseMint: ext2.mint })], [creator]);
    const LB = await client.launch({ vault: cvB.vault, depositor: creator.publicKey, stMint: cvB.stMint.publicKey, config: w.cfgs[1], preset: 1, streamIndex: 1, metadata: META });
    send(svm, [LB.ix], [creator, cvB.stMint], { cu: 800_000 });
    const anySt2 = ensureAta(svm, anyone, cvB.stMint.publicKey, anyone.publicKey);
    await dbc.buy(svm, anyone, LB.pool, anyQuote, anySt2, new BN(100_000_000));
    const fine = await dlmm.initPairIx({ x: cvB.stMint.publicKey, y: NATIVE_MINT, funder: anyone.publicKey, userTokenX: anySt2, userTokenY: anyQuote, binStep: 100, baseFactor: 1000 }); // 0.1%
    send(svm, [fine.ix], [anyone], { cu: 400_000 });
    expectFail(svm, [await client.registerPair({ vault: cvB.vault, signer: anyone.publicKey, lbPair: fine.pair })], [anyone], "NotKeeper");
    send(svm, [await client.registerPair({ vault: cvB.vault, signer: creator.publicKey, lbPair: fine.pair })], [creator], { label: "register_pair.depositor" });
    expect(vaultOf(w, cvB).dlmmPair.equals(fine.pair)).true;
  });

  it("F10 + F11: a stream config with another migration fee option, a Token-2022 type or a vesting schedule is refused; a cap below the lowest representable bin price is refused at create_vault", async () => {
    const owner = Keypair.generate();
    const svm = startSvm({ upgradeAuthority: owner.publicKey });
    svm.airdrop(owner.publicKey, BigInt(100_000_000_000));
    const client = new VaultClientStep5();
    const keeper = fund(svm), creator = fund(svm);
    ensureAta(svm, owner, NATIVE_MINT, owner.publicKey);
    const mk = async (params: any, label = "config") => { try { return await dbc.createConfig(svm, { payer: owner, feeClaimer: owner.publicKey, leftoverReceiver: owner.publicKey, quoteMint: NATIVE_MINT, params }); } catch (e: any) { throw new Error(`${label}: ${e.message}`); } };
    const good = [await mk(dbc.configParams("stream-25")), await mk(dbc.configParams("stream-50")), await mk(dbc.configParams("stream-75"))] as [PublicKey, PublicKey, PublicKey];
    // option 0 (fixed 25 bps) changes the migration math, so the SDK-sized fixed supply no longer fits: drop the fixed-supply check for this one
    const option0 = configWith("stream-25", (p) => { p.migration.migrationFeeOption = 0; });
    option0.tokenSupply = null;
    const badOption = await mk(option0, "badOption");
    const badType = await mk(configWith("stream-25", (p) => { p.token.tokenType = 1; }), "badType");
    // a vesting schedule on the preset parameters; the fixed-supply check is dropped so the curve needs no re-sizing
    const vesting = dbc.configParams("stream-25");
    vesting.tokenSupply = null;
    vesting.lockedVesting = { amountPerPeriod: new BN(1_000_000_000_000), cliffDurationFromMigrationTime: new BN(0), frequency: new BN(86_400), numberOfPeriod: new BN(1), cliffUnlockAmount: new BN(0) };
    const badVesting = await mk(vesting, "badVesting");
    for (const bad of [badOption, badType, badVesting]) {
      expectFail(svm, [await client.initProtocol({ admin: owner.publicKey, keeper: keeper.publicKey, payer: owner.publicKey, streamConfigs: [bad, good[1], good[2]] })], [owner], "Ineligible");
    }
    send(svm, [await client.initProtocol({ admin: owner.publicKey, keeper: keeper.publicKey, payer: owner.publicKey, streamConfigs: good })], [owner]);
    // F11: 2^-64 lamports per raw unit has no bin on any approved step; 2^64 (1 lamport) does
    const st = Keypair.generate();
    const low = await client.createVault({ depositor: creator.publicKey, stMint: st.publicKey, policy: { ...policy, maxPriceQ64: new BN(1) } });
    expectFail(svm, [low.ix], [creator, low.placeholder, st], "InvalidPolicy");
    const ok = await client.createVault({ depositor: creator.publicKey, stMint: st.publicKey, policy: { ...policy, maxPriceQ64: new BN(1).shln(64) } });
    send(svm, [ok.ix], [creator, ok.placeholder, st], { label: "create_vault.feasible_cap" });
    expect(client.decodeVault(Buffer.from(svm.getAccount(ok.vault)!.data)).activeStreams).eq(0);
  });
});
