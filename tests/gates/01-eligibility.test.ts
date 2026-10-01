// Gate 1: the eligibility routine rejects everything the plan says it must, from actual
// account state. Gate 2: persistent delegate bits are cleared on entry.
import { BN } from "@coral-xyz/anchor";
import { Keypair, PublicKey } from "@solana/web3.js";
import { NATIVE_MINT, TOKEN_2022_PROGRAM_ID, TOKEN_PROGRAM_ID, createTransferCheckedInstruction } from "@solana/spl-token";
import { expect } from "chai";
import { VaultClient, deriveStream } from "@cometail/client";
import { startSvm, fund, DAMM_V2_MIGRATION_CONFIG } from "../harness/svm";
import { send, expectFail } from "../harness/tx";
import { ataIx, ensureAta, wrapSol, createMint, createMint2022, mintTo2022, tokenOwner } from "../harness/tokens";
import * as dbc from "../harness/dbc";
import * as damm from "../harness/damm";

const policy = { maxSpendPerPeriod: new BN(5_000_000_000), periodSeconds: new BN(3600), maxOutstandingOrders: 4, maxBinsPerOrder: 20, maxPriceQ64: new BN(1).shln(64) };

function configWith(overrides: (p: any) => void, quoteDecimals = 9) {
  const p = JSON.parse(JSON.stringify(require("../../configs/plain.json")));
  p.token.tokenQuoteDecimal = quoteDecimals;
  overrides(p);
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { buildCurveWithMarketCap } = require("@meteora-ag/dynamic-bonding-curve-sdk");
  return dbc.normalize(buildCurveWithMarketCap(p));
}

async function launchAndFill(svm: any, protocol: Keypair, creator: Keypair, buyer: Keypair, params: any, quoteMint: PublicKey, migrate = true) {
  const config = await dbc.createConfig(svm, { payer: protocol, feeClaimer: protocol.publicKey, leftoverReceiver: protocol.publicKey, quoteMint, params });
  const mint = Keypair.generate();
  const launch = await dbc.createPoolIx({ config, baseMint: mint.publicKey, quoteMint, creator: creator.publicKey, payer: creator.publicKey });
  send(svm, [launch.ix], [creator, mint], { cu: 600_000 });
  const R: BN = dbc.getConfig(svm, config).migrationQuoteThreshold;
  let buyerQuote: PublicKey;
  if (quoteMint.equals(NATIVE_MINT)) buyerQuote = wrapSol(svm, buyer, R.muln(3));
  else { const { mintTo } = require("../harness/tokens"); buyerQuote = mintTo(svm, protocol, quoteMint, buyer.publicKey, R.muln(3)); }
  const buyerBase = ensureAta(svm, buyer, mint.publicKey, buyer.publicKey);
  await dbc.buy(svm, buyer, launch.pool, buyerQuote, buyerBase, R.divn(3));
  if (!migrate) return { config, mint: mint.publicKey, pool: launch.pool, R, buyerQuote, buyerBase };
  await dbc.buy(svm, buyer, launch.pool, buyerQuote, buyerBase, R.muln(6).divn(5));
  const mig = await dbc.migrateToDammV2(svm, buyer, launch.pool, DAMM_V2_MIGRATION_CONFIG.customizable);
  const creatorPos = damm.findPositionOwnedBy(svm, [mig.firstPosition, mig.secondPosition], creator.publicKey)!;
  return { config, mint: mint.publicKey, pool: launch.pool, R, buyerQuote, buyerBase, dammPool: mig.dammPool, creatorPos };
}

function newVault(svm: any, client: VaultClient, depositor: Keypair) {
  const stMintKp = Keypair.generate();
  return client.createVault({ depositor: depositor.publicKey, stMint: stMintKp.publicKey, policy }).then((cv) => { send(svm, [cv.ix], [depositor, cv.placeholder, stMintKp]); return cv; });
}

describe("gate 1 + 2: eligibility rejections and delegate clearing", () => {
  it("DBC rights: non-WSOL quote, output-token fee mode, and migration outcomes with unlocked or vesting creator liquidity are rejected while the curve is open", async () => {
    const svm = startSvm();
    const client = new VaultClient();
    const protocol = fund(svm), creator = fund(svm), buyer = fund(svm);
    const cv = await newVault(svm, client, creator);
    // (a) quote is not WSOL
    const usd = createMint(svm, protocol, 6);
    const a = await launchAndFill(svm, protocol, creator, buyer, configWith(() => {}, 6), usd, false);
    expectFail(svm, [await dbc.transferPoolCreatorIx(svm, a.pool, creator.publicKey, cv.vault), await client.depositDbcRights({ vault: cv.vault, depositor: creator.publicKey, streamIndex: 0, dbcPool: a.pool, dbcConfig: a.config, baseMint: a.mint })], [creator], "Ineligible");
    // (b) fees collected in the output token
    const b = await launchAndFill(svm, protocol, creator, buyer, configWith((p) => { p.fee.collectFeeMode = 1; }), NATIVE_MINT, false);
    expectFail(svm, [await dbc.transferPoolCreatorIx(svm, b.pool, creator.publicKey, cv.vault), await client.depositDbcRights({ vault: cv.vault, depositor: creator.publicKey, streamIndex: 0, dbcPool: b.pool, dbcConfig: b.config, baseMint: b.mint })], [creator], "Ineligible");
    // (c) creator liquidity would migrate unlocked
    const c = await launchAndFill(svm, protocol, creator, buyer, configWith((p) => { p.liquidityDistribution.creatorPermanentLockedLiquidityPercentage = 40; p.liquidityDistribution.creatorLiquidityPercentage = 40; }), NATIVE_MINT, false);
    expectFail(svm, [await dbc.transferPoolCreatorIx(svm, c.pool, creator.publicKey, cv.vault), await client.depositDbcRights({ vault: cv.vault, depositor: creator.publicKey, streamIndex: 0, dbcPool: c.pool, dbcConfig: c.config, baseMint: c.mint })], [creator], "Ineligible");
    // (d) migrated pool would collect fees in both tokens
    const d = await launchAndFill(svm, protocol, creator, buyer, configWith((p) => { p.migration.migratedPoolFee = { collectFeeMode: 1, dynamicFee: 0, poolFeeBps: 100 }; }), NATIVE_MINT, false);
    expectFail(svm, [await dbc.transferPoolCreatorIx(svm, d.pool, creator.publicKey, cv.vault), await client.depositDbcRights({ vault: cv.vault, depositor: creator.publicKey, streamIndex: 0, dbcPool: d.pool, dbcConfig: d.config, baseMint: d.mint })], [creator], "Ineligible");
    // (e) a mismatched config account for the pool
    const e = await launchAndFill(svm, protocol, creator, buyer, dbc.configParams("plain"), NATIVE_MINT, false);
    expectFail(svm, [await dbc.transferPoolCreatorIx(svm, e.pool, creator.publicKey, cv.vault), await client.depositDbcRights({ vault: cv.vault, depositor: creator.publicKey, streamIndex: 0, dbcPool: e.pool, dbcConfig: a.config, baseMint: e.mint })], [creator], "AccountMismatch");
    // the eligible one still works
    send(svm, [await dbc.transferPoolCreatorIx(svm, e.pool, creator.publicKey, cv.vault), await client.depositDbcRights({ vault: cv.vault, depositor: creator.publicKey, streamIndex: 0, dbcPool: e.pool, dbcConfig: e.config, baseMint: e.mint })], [creator]);
    expect(client.decodeVault(Buffer.from(svm.getAccount(cv.vault)!.data)).streamCount).eq(1);
  });

  it("principal: 3 raw units of unlocked liquidity pass, 4 fail, even on an enormous permanently locked position", async () => {
    const svm = startSvm();
    const client = new VaultClient();
    const protocol = fund(svm), creator = fund(svm), buyer = fund(svm);
    const cv = await newVault(svm, client, creator);
    const { createTransferInstruction } = require("@solana/spl-token");
    const run = async (streamIndex: number, target: number) => {
      const ext = await launchAndFill(svm, protocol, creator, buyer, dbc.configParams("plain"), NATIVE_MINT);
      const pool = damm.getPool(svm, ext.dammPool);
      const cq = wrapSol(svm, creator, new BN(1_000_000_000));
      const cb = ensureAta(svm, creator, pool.tokenAMint, creator.publicKey);
      send(svm, [createTransferInstruction(ext.buyerBase, cb, buyer.publicKey, BigInt(1_000_000))], [buyer]); // a few base tokens for the add
      const start = damm.getPosition(svm, ext.creatorPos.position).unlockedLiquidity.toNumber(); // migration remainder, 0 or 1
      if (target > start) send(svm, [await damm.addLiquidityIx(svm, { pool: ext.dammPool, position: ext.creatorPos.position, owner: creator.publicKey, tokenAAccount: cb, tokenBAccount: cq, liquidityDelta: new BN(target - start) })], [creator]);
      const p = damm.getPosition(svm, ext.creatorPos.position);
      expect(p.unlockedLiquidity.toNumber()).eq(target);
      expect(p.permanentLockedLiquidity.gt(new BN(10).pow(new BN(25)))).true; // enormous
      const nftMint = ext.creatorPos.state.nftMint;
      const vaultNft = ataIx(creator.publicKey, nftMint, cv.vault, TOKEN_2022_PROGRAM_ID);
      send(svm, [vaultNft.ix, createTransferCheckedInstruction(ext.creatorPos.nftAccount, nftMint, vaultNft.address, creator.publicKey, 1, 0, [], TOKEN_2022_PROGRAM_ID)], [creator]);
      return client.depositPosition({ vault: cv.vault, depositor: creator.publicKey, streamIndex, dammPool: ext.dammPool, position: ext.creatorPos.position, nftMint, nftAccount: vaultNft.address, baseMint: ext.mint });
    };
    expectFail(svm, [await run(0, 4)], [creator], "Principal");
    send(svm, [await run(0, 3)], [creator], { label: "deposit_position.dust3" });
    expect(client.decodeVault(Buffer.from(svm.getAccount(cv.vault)!.data)).streamCount).eq(1);
    void tokenOwner;
  });

  it("positions in a pool with Token-2022 base carrying a freeze authority, or non-WSOL token B, are rejected; a clean compounding pool passes", async () => {
    const svm = startSvm();
    const client = new VaultClient();
    const protocol = fund(svm), lp = fund(svm);
    const cv = await newVault(svm, client, lp);
    // custom pool: Token-2022 base with a freeze authority, WSOL quote, compounding
    const frozenBase = createMint2022(svm, protocol, 6, protocol.publicKey);
    const lpBase = mintTo2022(svm, protocol, frozenBase, lp.publicKey, new BN(1_000_000_000_000));
    const lpWsol = wrapSol(svm, lp, new BN(50_000_000_000));
    const nft = Keypair.generate();
    const init = await damm.initCustomizablePoolIx({ creator: lp.publicKey, payer: lp.publicKey, nftMint: nft, tokenAMint: frozenBase, tokenBMint: NATIVE_MINT, tokenAProgram: TOKEN_2022_PROGRAM_ID, tokenBProgram: TOKEN_PROGRAM_ID, payerTokenA: lpBase, payerTokenB: lpWsol, liquidity: new BN("1000000000000000000000000"), sqrtPrice: new BN(1).shln(64), collectFeeMode: 2 });
    send(svm, [init.ix], [lp, nft], { cu: 600_000, label: "damm.init_customizable_pool" });
    const pos = damm.getPosition(svm, init.position);
    send(svm, [await damm.permanentLockIx(svm, { pool: init.pool, position: init.position, owner: lp.publicKey, liquidity: pos.unlockedLiquidity })], [lp]);
    const locked = damm.getPosition(svm, init.position);
    expect(locked.unlockedLiquidity.isZero() && locked.permanentLockedLiquidity.gtn(0)).true;
    const vaultNft = ataIx(lp.publicKey, nft.publicKey, cv.vault, TOKEN_2022_PROGRAM_ID);
    send(svm, [vaultNft.ix, createTransferCheckedInstruction(init.nftAccount, nft.publicKey, vaultNft.address, lp.publicKey, 1, 0, [], TOKEN_2022_PROGRAM_ID)], [lp]);
    const dep = await client.depositPosition({ vault: cv.vault, depositor: lp.publicKey, streamIndex: 0, dammPool: init.pool, position: init.position, nftMint: nft.publicKey, nftAccount: vaultNft.address, baseMint: frozenBase });
    expectFail(svm, [dep], [lp], "Ineligible");
    // token B is not WSOL
    const usd = createMint(svm, protocol, 6);
    const base2 = createMint(svm, protocol, 6);
    const { mintTo } = require("../harness/tokens");
    const lpBase2 = mintTo(svm, protocol, base2, lp.publicKey, new BN(1_000_000_000_000));
    const lpUsd = mintTo(svm, protocol, usd, lp.publicKey, new BN(1_000_000_000_000));
    const nft2 = Keypair.generate();
    const init2 = await damm.initCustomizablePoolIx({ creator: lp.publicKey, payer: lp.publicKey, nftMint: nft2, tokenAMint: base2, tokenBMint: usd, tokenAProgram: TOKEN_PROGRAM_ID, tokenBProgram: TOKEN_PROGRAM_ID, payerTokenA: lpBase2, payerTokenB: lpUsd, liquidity: new BN("1000000000000000000000000"), sqrtPrice: new BN(1).shln(64), collectFeeMode: 2 });
    send(svm, [init2.ix], [lp, nft2], { cu: 600_000 });
    send(svm, [await damm.permanentLockIx(svm, { pool: init2.pool, position: init2.position, owner: lp.publicKey, liquidity: damm.getPosition(svm, init2.position).unlockedLiquidity })], [lp]);
    const vaultNft2 = ataIx(lp.publicKey, nft2.publicKey, cv.vault, TOKEN_2022_PROGRAM_ID);
    send(svm, [vaultNft2.ix, createTransferCheckedInstruction(init2.nftAccount, nft2.publicKey, vaultNft2.address, lp.publicKey, 1, 0, [], TOKEN_2022_PROGRAM_ID)], [lp]);
    expectFail(svm, [await client.depositPosition({ vault: cv.vault, depositor: lp.publicKey, streamIndex: 0, dammPool: init2.pool, position: init2.position, nftMint: nft2.publicKey, nftAccount: vaultNft2.address, baseMint: base2 })], [lp], "Ineligible");
    // a clean SPL base + WSOL compounding pool passes
    const base3 = createMint(svm, protocol, 6);
    const lpBase3 = mintTo(svm, protocol, base3, lp.publicKey, new BN(1_000_000_000_000));
    const nft3 = Keypair.generate();
    const init3 = await damm.initCustomizablePoolIx({ creator: lp.publicKey, payer: lp.publicKey, nftMint: nft3, tokenAMint: base3, tokenBMint: NATIVE_MINT, tokenAProgram: TOKEN_PROGRAM_ID, tokenBProgram: TOKEN_PROGRAM_ID, payerTokenA: lpBase3, payerTokenB: lpWsol, liquidity: new BN("1000000000000000000000000"), sqrtPrice: new BN(1).shln(64), collectFeeMode: 2 });
    send(svm, [init3.ix], [lp, nft3], { cu: 600_000 });
    send(svm, [await damm.permanentLockIx(svm, { pool: init3.pool, position: init3.position, owner: lp.publicKey, liquidity: damm.getPosition(svm, init3.position).unlockedLiquidity })], [lp]);
    const vaultNft3 = ataIx(lp.publicKey, nft3.publicKey, cv.vault, TOKEN_2022_PROGRAM_ID);
    send(svm, [vaultNft3.ix, createTransferCheckedInstruction(init3.nftAccount, nft3.publicKey, vaultNft3.address, lp.publicKey, 1, 0, [], TOKEN_2022_PROGRAM_ID)], [lp]);
    send(svm, [await client.depositPosition({ vault: cv.vault, depositor: lp.publicKey, streamIndex: 0, dammPool: init3.pool, position: init3.position, nftMint: nft3.publicKey, nftAccount: vaultNft3.address, baseMint: base3 })], [lp], { label: "deposit_position.custom_pool" });
    expect(client.decodeStream(Buffer.from(svm.getAccount(deriveStream(cv.vault, 0))!.data)).pool.equals(init3.pool)).true;
  });

  it("persistent delegate bits set by the previous owner are cleared on deposit", async () => {
    const svm = startSvm();
    const client = new VaultClient();
    const protocol = fund(svm), creator = fund(svm), buyer = fund(svm);
    const cv = await newVault(svm, client, creator);
    const ext = await launchAndFill(svm, protocol, creator, buyer, dbc.configParams("plain"), NATIVE_MINT);
    send(svm, [await damm.updateDelegatePermissionIx(svm, ext.creatorPos.position, creator.publicKey, 0xff)], [creator]);
    expect(damm.getPosition(svm, ext.creatorPos.position).delegatePermission).eq(0xff);
    const nftMint = ext.creatorPos.state.nftMint;
    const vaultNft = ataIx(creator.publicKey, nftMint, cv.vault, TOKEN_2022_PROGRAM_ID);
    send(svm, [vaultNft.ix, createTransferCheckedInstruction(ext.creatorPos.nftAccount, nftMint, vaultNft.address, creator.publicKey, 1, 0, [], TOKEN_2022_PROGRAM_ID)], [creator]);
    send(svm, [await client.depositPosition({ vault: cv.vault, depositor: creator.publicKey, streamIndex: 0, dammPool: ext.dammPool, position: ext.creatorPos.position, nftMint, nftAccount: vaultNft.address, baseMint: ext.mint })], [creator]);
    expect(damm.getPosition(svm, ext.creatorPos.position).delegatePermission).eq(0);
  });
});
