// A tail launched by a plain wallet on a fee-sale config gets exactly what the vault gets: the same creator
// curve fees, the same graduation payout (DBC's creator migration fee and creator surplus) and the same
// permanently locked creator position after migration. Two coins on the same stream-50 config (mainnet
// parameters), one created by a vault and one by a wallet, receive identical trades and are compared.
import { BN } from "@coral-xyz/anchor";
import { Keypair } from "@solana/web3.js";
import { NATIVE_MINT, TOKEN_2022_PROGRAM_ID, createTransferCheckedInstruction } from "@solana/spl-token";
import { expect } from "chai";
import { VaultClientStep4 } from "@cometail/client";
import { startSvm, fund, DAMM_V2_MIGRATION_CONFIG } from "../harness/svm";
import { send } from "../harness/tx";
import { ataIx, ensureAta, balance, wrapSol } from "../harness/tokens";
import * as dbc from "../harness/dbc";
import * as damm from "../harness/damm";

const policy = { maxSpendPerPeriod: new BN(5_000_000_000), periodSeconds: new BN(3600), maxOutstandingOrders: 4, maxBinsPerOrder: 20, maxPriceQ64: new BN(1).shln(64).muln(10) };
const U64_MAX = new BN("18446744073709551615");

describe("tail by a plain wallet on a fee-sale config", () => {
  it("stream-50: the wallet creator's curve fees, graduation payout and locked position equal the vault's", async () => {
    const owner = Keypair.generate();
    const svm = startSvm({ upgradeAuthority: owner.publicKey });
    svm.airdrop(owner.publicKey, BigInt(100_000_000_000));
    const client = new VaultClientStep4();
    const keeper = fund(svm), depositor = fund(svm), tailCreator = fund(svm), buyer = fund(svm);
    ensureAta(svm, owner, NATIVE_MINT, owner.publicKey);
    const cfgs = [] as any[];
    for (const n of ["stream-25", "stream-50", "stream-75"] as const) cfgs.push(await dbc.createConfig(svm, { payer: owner, feeClaimer: owner.publicKey, leftoverReceiver: owner.publicKey, quoteMint: NATIVE_MINT, params: dbc.configParams(n) }));
    const config = cfgs[1];
    send(svm, [await client.initProtocol({ admin: owner.publicKey, keeper: keeper.publicKey, payer: owner.publicKey, streamConfigs: cfgs as any })], [owner]);

    // the vault side needs a deposited stream before it may launch: a plain launch, filled and migrated
    const plain = await dbc.createConfig(svm, { payer: owner, feeClaimer: owner.publicKey, leftoverReceiver: owner.publicKey, quoteMint: NATIVE_MINT, params: dbc.configParams("plain") });
    const extMint = Keypair.generate();
    const ext = await dbc.createPoolIx({ config: plain, baseMint: extMint.publicKey, quoteMint: NATIVE_MINT, creator: depositor.publicKey, payer: depositor.publicKey });
    send(svm, [ext.ix], [depositor, extMint], { cu: 600_000 });
    const Rp: BN = dbc.getConfig(svm, plain).migrationQuoteThreshold;
    const buyerQuote = wrapSol(svm, buyer, Rp.muln(20));
    await dbc.buy(svm, buyer, ext.pool, buyerQuote, ensureAta(svm, buyer, extMint.publicKey, buyer.publicKey), Rp.muln(6).divn(5));
    const extMig = await dbc.migrateToDammV2(svm, buyer, ext.pool, DAMM_V2_MIGRATION_CONFIG.customizable);
    const extPos = damm.findPositionOwnedBy(svm, [extMig.firstPosition, extMig.secondPosition], depositor.publicKey)!;
    const stMint = Keypair.generate();
    const cv = await client.createVault({ depositor: depositor.publicKey, stMint: stMint.publicKey, policy });
    send(svm, [cv.ix], [depositor, cv.placeholder, stMint]);
    const vaultNft = ataIx(depositor.publicKey, extPos.state.nftMint, cv.vault, TOKEN_2022_PROGRAM_ID);
    send(svm, [vaultNft.ix, createTransferCheckedInstruction(extPos.nftAccount, extPos.state.nftMint, vaultNft.address, depositor.publicKey, 1, 0, [], TOKEN_2022_PROGRAM_ID)], [depositor]);
    send(svm, [await client.depositPosition({ vault: cv.vault, depositor: depositor.publicKey, streamIndex: 0, dammPool: extMig.dammPool, position: extPos.position, nftMint: extPos.state.nftMint, nftAccount: vaultNft.address, baseMint: extMint.publicKey })], [depositor]);

    // coin V: launched by the vault; coin W: launched by the wallet, no vault, no deposit
    const V = await client.launch({ vault: cv.vault, depositor: depositor.publicKey, stMint: stMint.publicKey, config, preset: 1, streamIndex: 1, metadata: { name: "tail", symbol: "tV", uri: "https://cometail.fun/t.json" } });
    send(svm, [V.ix], [depositor, stMint], { cu: 500_000 });
    const wMint = Keypair.generate();
    const W = await dbc.createPoolIx({ config, baseMint: wMint.publicKey, quoteMint: NATIVE_MINT, creator: tailCreator.publicKey, payer: tailCreator.publicKey, name: "tail", symbol: "tW", uri: "https://cometail.fun/t.json" });
    send(svm, [W.ix], [tailCreator, wMint], { cu: 500_000 });
    expect(dbc.getPool(svm, V.pool).creator.equals(cv.vault)).true;
    expect(dbc.getPool(svm, W.pool).creator.equals(tailCreator.publicKey)).true;

    // identical trades on both: two buys on the curve, then the fill
    const R: BN = dbc.getConfig(svm, config).migrationQuoteThreshold;
    const vSt = ensureAta(svm, buyer, stMint.publicKey, buyer.publicKey), wSt = ensureAta(svm, buyer, wMint.publicKey, buyer.publicKey);
    for (const amount of [new BN(1_000_000_000), new BN(3_000_000_000)]) {
      await dbc.buy(svm, buyer, V.pool, buyerQuote, vSt, amount);
      await dbc.buy(svm, buyer, W.pool, buyerQuote, wSt, amount);
    }
    const pv = dbc.getPool(svm, V.pool), pw = dbc.getPool(svm, W.pool);
    expect(pw.creatorQuoteFee.toString()).eq(pv.creatorQuoteFee.toString());
    expect(pw.partnerQuoteFee.toString()).eq(pv.partnerQuoteFee.toString());
    expect(pw.creatorQuoteFee.gtn(0)).true;
    // the wallet claims its curve fees itself: exactly the pool's creator fee
    const wWsol = ensureAta(svm, tailCreator, NATIVE_MINT, tailCreator.publicKey);
    const wBase = ensureAta(svm, tailCreator, wMint.publicKey, tailCreator.publicKey);
    const c0 = balance(svm, wWsol);
    send(svm, [await dbc.claimCreatorTradingFeeIx(svm, W.pool, tailCreator.publicKey, wBase, wWsol, U64_MAX, U64_MAX)], [tailCreator], { label: "wallet claims creator curve fees" });
    expect(balance(svm, wWsol).sub(c0).toString()).eq(pw.creatorQuoteFee.toString());

    await dbc.buy(svm, buyer, V.pool, buyerQuote, vSt, R.muln(6).divn(5));
    await dbc.buy(svm, buyer, W.pool, buyerQuote, wSt, R.muln(6).divn(5));
    const fv = dbc.getPool(svm, V.pool), fw = dbc.getPool(svm, W.pool);
    expect(fw.quoteReserve.toString()).eq(fv.quoteReserve.toString());

    // graduation payout: the vault's cash-out vs the wallet's own DBC creator withdrawals
    const migV = await dbc.migrateToDammV2(svm, buyer, V.pool, DAMM_V2_MIGRATION_CONFIG.customizable);
    const migW = await dbc.migrateToDammV2(svm, buyer, W.pool, DAMM_V2_MIGRATION_CONFIG.customizable);
    const d0 = balance(svm, cv.depositorWsol);
    send(svm, [await client.cashout({ vault: cv.vault, dbcPool: V.pool, dbcConfig: config, quoteVault: fv.quoteVault, depositorWsol: cv.depositorWsol })], [buyer], { label: "vault cash-out" });
    const vaultPaid = balance(svm, cv.depositorWsol).sub(d0);
    const w0 = balance(svm, wWsol);
    send(svm, [
      await dbc.withdrawMigrationFeeIx(svm, W.pool, tailCreator.publicKey, wWsol, 1),
      await dbc.creatorWithdrawSurplusIx(svm, W.pool, tailCreator.publicKey, wWsol),
    ], [tailCreator], { label: "wallet: creator migration fee + surplus" });
    const walletPaid = balance(svm, wWsol).sub(w0);
    const expected = R.sub(R.muln(50).addn(99).divn(100)); // the preset's 50% of the raise (gate 04's formula)
    expect(vaultPaid.toString()).eq(expected.toString());
    expect(walletPaid.toString()).eq(vaultPaid.toString());

    // the creator's permanently locked position: in the vault for V, in the wallet for W, same liquidity
    const posV = damm.findPositionOwnedBy(svm, [migV.firstPosition, migV.secondPosition], cv.vault)!;
    const posW = damm.findPositionOwnedBy(svm, [migW.firstPosition, migW.secondPosition], tailCreator.publicKey)!;
    expect(posV, "vault holds V's creator position").not.undefined;
    expect(posW, "wallet holds W's creator position").not.undefined;
    expect(posW.state.permanentLockedLiquidity.toString()).eq(posV.state.permanentLockedLiquidity.toString());
    expect(posW.state.unlockedLiquidity.toString()).eq("0");
    console.log(JSON.stringify({ raise: R.toString(), creatorCurveFee: pw.creatorQuoteFee.toString(), vaultPaid: vaultPaid.toString(), walletPaid: walletPaid.toString(), lockedLiquidity: posW.state.permanentLockedLiquidity.toString() }));
  });
});
