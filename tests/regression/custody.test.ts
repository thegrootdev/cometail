// Regression: a program-derived address holds DBC creator rights and
// DAMM v2 positions and exercises every right through CPI, against the live binaries.
import { BN } from "@coral-xyz/anchor";
import { Keypair } from "@solana/web3.js";
import { NATIVE_MINT, TOKEN_2022_PROGRAM_ID, createTransferCheckedInstruction } from "@solana/spl-token";
import { expect } from "chai";
import { startSvm, fund, DAMM_V2_MIGRATION_CONFIG } from "../harness/svm";
import { send, expectFail, forward, loadForwarder, pdaSigner } from "../harness/tx";
import { ataIx, ensureAta, balance, wrapSol, tokenOwner } from "../harness/tokens";
import * as dbc from "../harness/dbc";
import * as damm from "../harness/damm";

const U64 = new BN("18446744073709551615");

describe("custody: PDA as DBC creator and DAMM v2 position owner", () => {
  it("transfer_pool_creator to a PDA, claims through CPI, migration NFT routing, NFT transfer, split with a PDA co-signer", async () => {
    const svm = startSvm({ withVaultProgram: false });
    loadForwarder(svm);
    const protocol = fund(svm), creator = fund(svm), buyer = fund(svm);
    const vault = pdaSigner("custody");
    const stranger = pdaSigner("stranger");

    // a plain launch by a wallet creator (the stream we will deposit)
    const config = await dbc.createConfig(svm, { payer: protocol, feeClaimer: protocol.publicKey, leftoverReceiver: protocol.publicKey, quoteMint: NATIVE_MINT, params: dbc.configParams("plain") });
    const mint = Keypair.generate();
    const launch = await dbc.createPoolIx({ config, baseMint: mint.publicKey, quoteMint: NATIVE_MINT, creator: creator.publicKey, payer: creator.publicKey });
    send(svm, [launch.ix], [creator, mint], { cu: 600_000 });
    const R: BN = dbc.getConfig(svm, config).migrationQuoteThreshold;
    const buyerQuote = wrapSol(svm, buyer, R.muln(3));
    const buyerBase = ensureAta(svm, buyer, mint.publicKey, buyer.publicKey);
    await dbc.buy(svm, buyer, launch.pool, buyerQuote, buyerBase, R.divn(2)); // half: fees accrue, curve still open

    // A: the creator hands the rights to the PDA while the curve is open
    const before = dbc.getPool(svm, launch.pool);
    expect(before.creatorQuoteFee.gtn(0)).true;
    send(svm, [await dbc.transferPoolCreatorIx(svm, launch.pool, creator.publicKey, vault.key)], [creator]);
    expect(dbc.getPool(svm, launch.pool).creator.equals(vault.key)).true;
    expect(dbc.getPool(svm, launch.pool).migrationProgress).eq(dbc.MigrationProgress.PreBondingCurve);

    // B: the PDA claims creator fees; a different PDA is Unauthorized
    const vaultQuote = ensureAta(svm, buyer, NATIVE_MINT, vault.key);
    const vaultBase = ensureAta(svm, buyer, mint.publicKey, vault.key);
    const strangerClaim = await dbc.claimCreatorTradingFeeIx(svm, launch.pool, stranger.key, vaultBase, vaultQuote, U64, U64);
    expectFail(svm, [forward(strangerClaim, stranger)], [buyer], "Unauthorized");
    const claim = await dbc.claimCreatorTradingFeeIx(svm, launch.pool, vault.key, vaultBase, vaultQuote, U64, U64);
    const q0 = balance(svm, vaultQuote);
    send(svm, [forward(claim, vault)], [buyer]);
    expect(balance(svm, vaultQuote).sub(q0).toString()).eq(before.creatorQuoteFee.toString());
    expect(dbc.getPool(svm, launch.pool).creatorQuoteFee.isZero()).true;

    // C: complete the curve and migrate; the creator NFT lands with the PDA (creator at migration time)
    await dbc.buy(svm, buyer, launch.pool, buyerQuote, buyerBase, R);
    const mig = await dbc.migrateToDammV2(svm, buyer, launch.pool, DAMM_V2_MIGRATION_CONFIG.customizable);
    const mine = damm.findPositionOwnedBy(svm, [mig.firstPosition, mig.secondPosition], vault.key)!;
    const theirs = damm.findPositionOwnedBy(svm, [mig.firstPosition, mig.secondPosition], protocol.publicKey)!;
    expect(mine).not.null; expect(theirs).not.null;
    expect(mine.state.permanentLockedLiquidity.gtn(0)).true;

    // D: the PDA claims position fees on its permanently locked position
    const pool = damm.getPool(svm, mig.dammPool);
    const buyerBase2 = ensureAta(svm, buyer, pool.tokenAMint, buyer.publicKey);
    send(svm, [await damm.swapIx(svm, { pool: mig.dammPool, payer: buyer.publicKey, inputAccount: buyerQuote, outputAccount: buyerBase2, amountIn: new BN(20_000_000_000) })], [buyer]);
    const claimPos = await damm.claimPositionFeeIx(svm, { pool: mig.dammPool, position: mine.position, signer: vault.key, tokenAAccount: vaultBase, tokenBAccount: vaultQuote, nftAccount: mine.nftAccount });
    const q1 = balance(svm, vaultQuote);
    send(svm, [forward(claimPos, vault)], [buyer]);
    // 20 SOL at 1%: 200,000,000 fee, 80% LP, half claimable, 80% to this position = 64,000,000
    const got = balance(svm, vaultQuote).sub(q1);
    expect(got.gte(new BN(63_999_990)) && got.lte(new BN(64_000_010))).true;

    // E: migration fee (0 for plain) and surplus (0) withdraw through the PDA without error
    send(svm, [forward(await dbc.withdrawMigrationFeeIx(svm, launch.pool, vault.key, vaultQuote, 1), vault)], [buyer]);
    send(svm, [forward(await dbc.creatorWithdrawSurplusIx(svm, launch.pool, vault.key, vaultQuote), vault)], [buyer]);

    // F: the locked position NFT is a plain Token-2022 token: the PDA can transfer it out
    const other = fund(svm);
    const dest = ataIx(buyer.publicKey, mine.state.nftMint, other.publicKey, TOKEN_2022_PROGRAM_ID);
    const xfer = createTransferCheckedInstruction(mine.nftAccount, mine.state.nftMint, dest.address, vault.key, 1, 0, [], TOKEN_2022_PROGRAM_ID);
    send(svm, [dest.ix, forward(xfer, vault)], [buyer]);
    expect(balance(svm, dest.address).toString()).eq("1");
    expect(balance(svm, mine.nftAccount).isZero()).true;

    // G: transfer back through the migration window (CreatedPool) works again
    send(svm, [forward(await dbc.transferPoolCreatorIx(svm, launch.pool, vault.key, creator.publicKey), vault)], [buyer]);
    expect(dbc.getPool(svm, launch.pool).creator.equals(creator.publicKey)).true;

    // H: the protocol splits 30% of its permanently locked position into a PDA-owned position in one tx
    const nft = Keypair.generate();
    const created = await damm.createPositionIx({ pool: mig.dammPool, owner: vault.key, payer: buyer.publicKey, nftMint: nft });
    const split = await damm.splitPositionIx({ pool: mig.dammPool, first: theirs.position, firstNftAccount: theirs.nftAccount, second: created.position, secondNftAccount: created.nftAccount, firstOwner: protocol.publicKey, secondOwner: vault.key,
      pct: { unlockedLiquidityPercentage: 0, permanentLockedLiquidityPercentage: 30, feeAPercentage: 0, feeBPercentage: 0, reward0Percentage: 0, reward1Percentage: 0, innerVestingLiquidityPercentage: 0 } });
    const t0 = damm.getPosition(svm, theirs.position).permanentLockedLiquidity;
    send(svm, [created.ix, forward(split, vault)], [buyer, nft, protocol]);
    const slice = damm.getPosition(svm, created.position);
    const t1 = damm.getPosition(svm, theirs.position).permanentLockedLiquidity;
    expect(slice.permanentLockedLiquidity.add(t1).toString()).eq(t0.toString());
    const share = slice.permanentLockedLiquidity.muln(10000).div(t0).toNumber(); // basis points, floor
    expect(share).gte(2999); expect(share).lte(3000);
    expect(slice.unlockedLiquidity.isZero() && slice.vestedLiquidity.isZero()).true;
    expect(tokenOwner(svm, created.nftAccount).equals(vault.key)).true;
    send(svm, [await damm.swapIx(svm, { pool: mig.dammPool, payer: buyer.publicKey, inputAccount: buyerQuote, outputAccount: buyerBase2, amountIn: new BN(10_000_000_000) })], [buyer]);
    const q2 = balance(svm, vaultQuote);
    send(svm, [forward(await damm.claimPositionFeeIx(svm, { pool: mig.dammPool, position: created.position, signer: vault.key, tokenAAccount: vaultBase, tokenBAccount: vaultQuote, nftAccount: created.nftAccount }), vault)], [buyer]);
    expect(balance(svm, vaultQuote).sub(q2).gtn(0)).true;
  });
});
