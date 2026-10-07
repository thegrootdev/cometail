// Regression for spikes 03, 08 and 09: the four configs, built from configs/*.json, launched
// with a program-derived creator, filled with native WSOL, migrated through Meteora's live
// Customizable config, with the measured economics asserted exactly.
import { BN } from "@coral-xyz/anchor";
import { Keypair, PublicKey } from "@solana/web3.js";
import { createInitializeAccount3Instruction, ACCOUNT_SIZE, NATIVE_MINT, TOKEN_PROGRAM_ID } from "@solana/spl-token";
import { SystemProgram } from "@solana/web3.js";
import { expect } from "chai";
import { startSvm, fund, DAMM_V2_MIGRATION_CONFIG } from "../harness/svm";
import { send, expectFail, forward, loadForwarder, pdaSigner } from "../harness/tx";
import { ataIx, ensureAta, balance, wrapSol, tokenOwner } from "../harness/tokens";
import * as dbc from "../harness/dbc";
import * as damm from "../harness/damm";

const presets = ["stream-25", "stream-50", "stream-75", "plain"] as const;
const feePct: Record<string, number> = { "stream-25": 25, "stream-50": 50, "stream-75": 75, plain: 0 };

describe("configs: economics through the live Customizable migration config (native WSOL)", () => {
  for (const name of presets) {
    it(`${name}: 75/25 curve split, LP 80/20, cash-out, SOL-only position fees`, async () => {
      const svm = startSvm({ withVaultProgram: false });
      loadForwarder(svm);
      const protocol = fund(svm), depositor = fund(svm), buyer = fund(svm);
      const vault = pdaSigner(`vault-${name}`);
      const p = feePct[name];

      // config from configs/<name>.json
      const params = dbc.configParams(name);
      const R: BN = params.migrationQuoteThreshold;
      expect(params.tokenSupply).not.null;
      expect(R.gte(new BN(10_000_000_000))).true;
      const config = await dbc.createConfig(svm, { payer: protocol, feeClaimer: protocol.publicKey, leftoverReceiver: protocol.publicKey, quoteMint: NATIVE_MINT, params });
      const cfg = dbc.getConfig(svm, config);
      expect(cfg.creatorTradingFeePercentage).eq(75);
      expect(cfg.partnerPermanentLockedLiquidityPercentage).eq(20);
      expect(cfg.creatorPermanentLockedLiquidityPercentage).eq(80);
      expect(cfg.migrationFeeOption).eq(6);
      expect(cfg.migratedCollectFeeMode).eq(2);
      expect(cfg.migratedCompoundingFeeBps).eq(5000);
      expect(cfg.migratedPoolFeeBps).eq(100);
      expect(cfg.migrationFeePercentage).eq(p);
      expect(cfg.creatorMigrationFeePercentage).eq(p === 0 ? 0 : 100);
      expect(cfg.poolCreationFee.toNumber()).eq(name === "plain" ? 10_000_000 : 0);

      // launch with the PDA as creator; the depositor pays
      const stMint = Keypair.generate();
      const launch = await dbc.createPoolIx({ config, baseMint: stMint.publicKey, quoteMint: NATIVE_MINT, creator: vault.key, payer: depositor.publicKey });
      const vaultQuote = ataIx(depositor.publicKey, NATIVE_MINT, vault.key);
      const vaultBase = ataIx(depositor.publicKey, stMint.publicKey, vault.key);
      const depositorQuote = ataIx(depositor.publicKey, NATIVE_MINT, depositor.publicKey);
      const placeholder = Keypair.generate();
      const rent = Number(svm.minimumBalanceForRentExemption(BigInt(ACCOUNT_SIZE)));
      send(svm, [
        forward(launch.ix, vault), vaultQuote.ix, depositorQuote.ix, vaultBase.ix,
        SystemProgram.createAccount({ fromPubkey: depositor.publicKey, newAccountPubkey: placeholder.publicKey, lamports: rent, space: ACCOUNT_SIZE, programId: TOKEN_PROGRAM_ID }),
        createInitializeAccount3Instruction(placeholder.publicKey, NATIVE_MINT, vault.key),
      ], [depositor, stMint, placeholder], { cu: 600_000, label: `launch.${name}` });
      expect(dbc.getPool(svm, launch.pool).creator.equals(vault.key)).true;

      // fill the curve with wrapped SOL (exact-in past the threshold is rejected, partial fill stops at R)
      const buyerQuote = wrapSol(svm, buyer, R.muln(3));
      const buyerBase = ensureAta(svm, buyer, stMint.publicKey, buyer.publicKey);
      await dbc.buy(svm, buyer, launch.pool, buyerQuote, buyerBase, R.muln(6).divn(5));
      const filled = dbc.getPool(svm, launch.pool);
      expect(filled.migrationProgress).eq(dbc.MigrationProgress.LockedVesting);
      expect(filled.creatorBaseFee.isZero() && filled.partnerBaseFee.isZero()).true;
      expect(filled.creatorQuoteFee.muln(25).sub(filled.partnerQuoteFee.muln(75)).abs().lten(100)).true;

      // migration window closed, then migrate through the live config
      const back = await dbc.transferPoolCreatorIx(svm, launch.pool, vault.key, depositor.publicKey);
      expectFail(svm, [forward(back, vault)], [depositor], "NotPermitToDoThisAction");
      const mig = await dbc.migrateToDammV2(svm, buyer, launch.pool, DAMM_V2_MIGRATION_CONFIG.customizable);
      expect(dbc.getPool(svm, launch.pool).migrationProgress).eq(dbc.MigrationProgress.CreatedPool);
      const pool = damm.getPool(svm, mig.dammPool);
      expect(pool.collectFeeMode).eq(2);
      expect(pool.poolFees.compoundingFeeBps).eq(5000);
      const mine = damm.findPositionOwnedBy(svm, [mig.firstPosition, mig.secondPosition], vault.key)!;
      const theirs = damm.findPositionOwnedBy(svm, [mig.firstPosition, mig.secondPosition], protocol.publicKey)!;
      expect(mine).not.null; expect(theirs).not.null;
      expect(mine.state.unlockedLiquidity.lten(3)).true;
      expect(mine.state.vestedLiquidity.isZero()).true;
      const share = mine.state.permanentLockedLiquidity.muln(1000).div(mine.state.permanentLockedLiquidity.add(theirs.state.permanentLockedLiquidity)).toNumber() / 10;
      expect(share).gte(79.9); expect(share).lte(80.1);

      // cash-out: exact migration fee to the depositor; nothing to the protocol
      const migIx = await dbc.withdrawMigrationFeeIx(svm, launch.pool, vault.key, depositorQuote.address, 1);
      const d0 = balance(svm, depositorQuote.address);
      send(svm, [forward(migIx, vault)], [depositor], { label: "cashout.migration_fee" });
      const quoteAmount = R.muln(100 - p).addn(99).divn(100);
      expect(balance(svm, depositorQuote.address).sub(d0).toString()).eq(R.sub(quoteAmount).toString());
      const surplusIx = await dbc.creatorWithdrawSurplusIx(svm, launch.pool, vault.key, depositorQuote.address);
      const d1 = balance(svm, depositorQuote.address);
      send(svm, [forward(surplusIx, vault)], [depositor], { label: "cashout.surplus" });
      expect(balance(svm, depositorQuote.address).sub(d1).isZero()).true;

      // own-curve fees: the vault claims 75% share with max_base = 0 and the placeholder as token A
      const claimDbc = await dbc.claimCreatorTradingFeeIx(svm, launch.pool, vault.key, placeholder.publicKey, vaultQuote.address, new BN(0), new BN("18446744073709551615"));
      const q0 = balance(svm, vaultQuote.address);
      send(svm, [forward(claimDbc, vault)], [depositor], { label: "harvest.dbc" });
      expect(balance(svm, vaultQuote.address).sub(q0).toString()).eq(filled.creatorQuoteFee.toString());
      expect(balance(svm, placeholder.publicKey).isZero()).true;

      // graduated-pool fees: 5 SOL swap at 1% -> vault claims 80% of the claimable half = 16,000,000, SOL only
      const buyerBase2 = ensureAta(svm, buyer, pool.tokenAMint, buyer.publicKey);
      const sw = await damm.swapIx(svm, { pool: mig.dammPool, payer: buyer.publicKey, inputAccount: buyerQuote, outputAccount: buyerBase2, amountIn: new BN(5_000_000_000) });
      send(svm, [sw], [buyer], { label: "damm.swap" });
      const claimPos = await damm.claimPositionFeeIx(svm, { pool: mig.dammPool, position: mine.position, signer: vault.key, tokenAAccount: placeholder.publicKey, tokenBAccount: vaultQuote.address, nftAccount: mine.nftAccount });
      const q1 = balance(svm, vaultQuote.address);
      send(svm, [forward(claimPos, vault)], [depositor], { label: "harvest.position" });
      const got = balance(svm, vaultQuote.address).sub(q1);
      expect(got.gte(new BN(15_999_990)) && got.lte(new BN(16_000_010))).true;
      expect(balance(svm, placeholder.publicKey).isZero()).true;

      // the protocol claims its partner share of curve fees and, for plain launches, 90% of the creation fee
      const protoQuote = ensureAta(svm, protocol, NATIVE_MINT, protocol.publicKey);
      const protoBase = ensureAta(svm, protocol, stMint.publicKey, protocol.publicKey);
      const pc = await dbc.claimPartnerTradingFeeIx(svm, launch.pool, protocol.publicKey, protoBase, protoQuote);
      send(svm, [pc], [protocol], { label: "partner.claim_trading_fee" });
      expect(balance(svm, protoQuote).toString()).eq(filled.partnerQuoteFee.toString());
      if (name === "plain") {
        const receiver = Keypair.generate().publicKey;
        const fee = await dbc.claimPartnerPoolCreationFeeIx(svm, launch.pool, protocol.publicKey, receiver);
        send(svm, [fee], [protocol], { label: "partner.claim_creation_fee" });
        expect(Number(svm.getBalance(receiver))).eq(9_000_000);
      }
      // the migration window reopens after migration
      send(svm, [forward(back, vault)], [depositor]);
      expect(dbc.getPool(svm, launch.pool).creator.equals(depositor.publicKey)).true;
      void tokenOwner; void PublicKey;
    });
  }
});

// review 133: the burn configs' preflight compares today's presets with the plan before anything is sent
import { todayMatchesPlan, sameExceptClaimer } from "../mainnet/burn-plan";
import { Keypair as Kp } from "@solana/web3.js";
describe("burn configs preflight (tests/mainnet/burn-plan.ts)", () => {
  it("a today's preset whose parameters differ from the plan fails before any simulation; bytes differing outside the claimer fail", async () => {
    const { startSvm, fund } = await import("../harness/svm");
    const dbcH = await import("../harness/dbc");
    const { NATIVE_MINT: W } = await import("@solana/spl-token");
    const svm = startSvm({ withVaultProgram: false });
    const payer = fund(svm);
    const claimer = Kp.generate().publicKey, leftover = payer.publicKey;
    const good = await dbcH.createConfig(svm, { payer, feeClaimer: payer.publicKey, leftoverReceiver: leftover, quoteMint: W, params: dbcH.configParams("plain") });
    const p = dbcH.configParams("plain"); p.creatorTradingFeePercentage = 99;
    const bad = await dbcH.createConfig(svm, { payer, feeClaimer: payer.publicKey, leftoverReceiver: leftover, quoteMint: W, params: p });
    const fresh = await dbcH.createConfig(svm, { payer, feeClaimer: claimer, leftoverReceiver: leftover, quoteMint: W, params: dbcH.configParams("plain") });
    expect(todayMatchesPlan(dbcH.getConfig(svm, good), "plain", payer.publicKey.toBase58(), leftover.toBase58())).deep.eq([]);
    expect(todayMatchesPlan(dbcH.getConfig(svm, bad), "plain", payer.publicKey.toBase58(), leftover.toBase58()).length).gt(0);
    const data = (k: any) => Buffer.from(svm.getAccount(k)!.data);
    expect(sameExceptClaimer(data(good), data(fresh), claimer)).deep.eq([]);
    expect(sameExceptClaimer(data(bad), data(fresh), claimer).length).gt(0);
  });
});
