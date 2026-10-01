// Regression for spike 05: zero-amount claims still need an initialized, distinct token A
// destination; a vault-owned WSOL placeholder works and stays empty.
import { BN } from "@coral-xyz/anchor";
import { Keypair, SystemProgram } from "@solana/web3.js";
import { ACCOUNT_SIZE, NATIVE_MINT, TOKEN_PROGRAM_ID, createInitializeAccount3Instruction } from "@solana/spl-token";
import { expect } from "chai";
import { startSvm, fund, DAMM_V2_MIGRATION_CONFIG } from "../harness/svm";
import { send, expectFail, forward, loadForwarder, pdaSigner } from "../harness/tx";
import { ata, ensureAta, balance, wrapSol } from "../harness/tokens";
import * as dbc from "../harness/dbc";
import * as damm from "../harness/damm";

const U64 = new BN("18446744073709551615");

describe("claim destinations: token A must be initialized and distinct even when zero is due", () => {
  it("uninitialized and aliased token A fail; a distinct vault-owned WSOL placeholder works", async () => {
    const svm = startSvm({ withVaultProgram: false });
    loadForwarder(svm);
    const protocol = fund(svm), depositor = fund(svm), buyer = fund(svm);
    const vault = pdaSigner("dest");
    const config = await dbc.createConfig(svm, { payer: protocol, feeClaimer: protocol.publicKey, leftoverReceiver: protocol.publicKey, quoteMint: NATIVE_MINT, params: dbc.configParams("stream-50") });
    const mint = Keypair.generate();
    const launch = await dbc.createPoolIx({ config, baseMint: mint.publicKey, quoteMint: NATIVE_MINT, creator: vault.key, payer: depositor.publicKey });
    send(svm, [forward(launch.ix, vault)], [depositor, mint], { cu: 600_000 });
    const R: BN = dbc.getConfig(svm, config).migrationQuoteThreshold;
    const buyerQuote = wrapSol(svm, buyer, R.muln(3));
    const buyerBase = ensureAta(svm, buyer, mint.publicKey, buyer.publicKey);
    await dbc.buy(svm, buyer, launch.pool, buyerQuote, buyerBase, R.muln(6).divn(5));
    const vaultQuote = ensureAta(svm, depositor, NATIVE_MINT, vault.key);
    const neverCreatedBase = ata(mint.publicKey, vault.key);

    // DBC creator claim: base fee is zero (quote-only mode) but the destination is still checked
    const uninit = await dbc.claimCreatorTradingFeeIx(svm, launch.pool, vault.key, neverCreatedBase, vaultQuote, new BN(0), U64);
    expectFail(svm, [forward(uninit, vault)], [depositor], "AccountNotInitialized");
    const alias = await dbc.claimCreatorTradingFeeIx(svm, launch.pool, vault.key, vaultQuote, vaultQuote, new BN(0), U64);
    expectFail(svm, [forward(alias, vault)], [depositor], "2040"); // ConstraintDuplicateMutableAccount
    const placeholder = Keypair.generate();
    const rent = Number(svm.minimumBalanceForRentExemption(BigInt(ACCOUNT_SIZE)));
    send(svm, [
      SystemProgram.createAccount({ fromPubkey: depositor.publicKey, newAccountPubkey: placeholder.publicKey, lamports: rent, space: ACCOUNT_SIZE, programId: TOKEN_PROGRAM_ID }),
      createInitializeAccount3Instruction(placeholder.publicKey, NATIVE_MINT, vault.key),
    ], [depositor, placeholder]);
    const ok = await dbc.claimCreatorTradingFeeIx(svm, launch.pool, vault.key, placeholder.publicKey, vaultQuote, new BN(0), U64);
    const expected = dbc.getPool(svm, launch.pool).creatorQuoteFee;
    send(svm, [forward(ok, vault)], [depositor]);
    expect(balance(svm, vaultQuote).toString()).eq(expected.toString());
    expect(balance(svm, placeholder.publicKey).isZero()).true;
    expect(svm.getAccount(neverCreatedBase)).null;

    // DAMM v2 position claim: same rules
    const mig = await dbc.migrateToDammV2(svm, buyer, launch.pool, DAMM_V2_MIGRATION_CONFIG.customizable);
    const mine = damm.findPositionOwnedBy(svm, [mig.firstPosition, mig.secondPosition], vault.key)!;
    const pool = damm.getPool(svm, mig.dammPool);
    const buyerBase2 = ensureAta(svm, buyer, pool.tokenAMint, buyer.publicKey);
    send(svm, [await damm.swapIx(svm, { pool: mig.dammPool, payer: buyer.publicKey, inputAccount: buyerQuote, outputAccount: buyerBase2, amountIn: new BN(5_000_000_000) })], [buyer]);
    const pUninit = await damm.claimPositionFeeIx(svm, { pool: mig.dammPool, position: mine.position, signer: vault.key, tokenAAccount: neverCreatedBase, tokenBAccount: vaultQuote, nftAccount: mine.nftAccount });
    expectFail(svm, [forward(pUninit, vault)], [depositor], "AccountNotInitialized");
    const pAlias = await damm.claimPositionFeeIx(svm, { pool: mig.dammPool, position: mine.position, signer: vault.key, tokenAAccount: vaultQuote, tokenBAccount: vaultQuote, nftAccount: mine.nftAccount });
    expectFail(svm, [forward(pAlias, vault)], [depositor], "2040");
    const pOk = await damm.claimPositionFeeIx(svm, { pool: mig.dammPool, position: mine.position, signer: vault.key, tokenAAccount: placeholder.publicKey, tokenBAccount: vaultQuote, nftAccount: mine.nftAccount });
    const q0 = balance(svm, vaultQuote);
    send(svm, [forward(pOk, vault)], [depositor]);
    const got = balance(svm, vaultQuote).sub(q0);
    expect(got.gte(new BN(15_999_990)) && got.lte(new BN(16_000_010))).true;
    expect(balance(svm, placeholder.publicKey).isZero()).true;
  });
});
