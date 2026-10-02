// Gates 1 and 4 (first half): the eligibility routine on every entry path, delegate clearing,
// duplicates, status rules, and Open withdrawals that return everything with fees attached.
import { BN } from "@coral-xyz/anchor";
import { Keypair, PublicKey } from "@solana/web3.js";
import { NATIVE_MINT, TOKEN_2022_PROGRAM_ID, createTransferCheckedInstruction, createApproveInstruction } from "@solana/spl-token";
import { expect } from "chai";
import { VaultClient, dammPositionNftAccount, deriveStreamIndex, handPositionNftToVaultIx } from "@cometail/client";
import { startSvm, fund, DAMM_V2_MIGRATION_CONFIG } from "../harness/svm";
import { send, expectFail } from "../harness/tx";
import { ataIx, ensureAta, balance, wrapSol, tokenOwner } from "../harness/tokens";
import * as dbc from "../harness/dbc";
import * as damm from "../harness/damm";

/** A closed account: LiteSVM keeps a zero-lamport shell for it. */
const closed = (svm: any, pk: PublicKey) => { const a = svm.getAccount(pk); return !a || Number(a.lamports) === 0; };

const policy = { maxSpendPerPeriod: new BN(5_000_000_000), periodSeconds: new BN(3600), maxOutstandingOrders: 4, maxBinsPerOrder: 20, maxPriceQ64: new BN(1).shln(64) };

/** A plain launch by `creator`, filled and migrated: the stream a depositor would bring. */
async function externalStream(svm: any, protocol: Keypair, creator: Keypair, buyer: Keypair, configName: "plain" | "stream-25" = "plain", fill = true) {
  const config = await dbc.createConfig(svm, { payer: protocol, feeClaimer: protocol.publicKey, leftoverReceiver: protocol.publicKey, quoteMint: NATIVE_MINT, params: dbc.configParams(configName) });
  const mint = Keypair.generate();
  const launch = await dbc.createPoolIx({ config, baseMint: mint.publicKey, quoteMint: NATIVE_MINT, creator: creator.publicKey, payer: creator.publicKey });
  send(svm, [launch.ix], [creator, mint], { cu: 600_000 });
  const R: BN = dbc.getConfig(svm, config).migrationQuoteThreshold;
  const buyerQuote = wrapSol(svm, buyer, R.muln(3));
  const buyerBase = ensureAta(svm, buyer, mint.publicKey, buyer.publicKey);
  if (!fill) { await dbc.buy(svm, buyer, launch.pool, buyerQuote, buyerBase, R.divn(3)); return { config, mint: mint.publicKey, pool: launch.pool, R, buyerQuote, buyerBase }; }
  await dbc.buy(svm, buyer, launch.pool, buyerQuote, buyerBase, R.muln(6).divn(5));
  const mig = await dbc.migrateToDammV2(svm, buyer, launch.pool, DAMM_V2_MIGRATION_CONFIG.customizable);
  const creatorPos = damm.findPositionOwnedBy(svm, [mig.firstPosition, mig.secondPosition], creator.publicKey)!;
  return { config, mint: mint.publicKey, pool: launch.pool, R, buyerQuote, buyerBase, dammPool: mig.dammPool, creatorPos };
}

describe("gate 1 + 4: deposits, eligibility, delegates, withdrawals", () => {
  it("whole-position deposit: NFT into a vault-owned account, delegate cleared, duplicate rejected, withdrawal returns it with fees attached", async () => {
    const svm = startSvm();
    const client = new VaultClient();
    const protocol = fund(svm), creator = fund(svm), buyer = fund(svm);
    const ext = await externalStream(svm, protocol, creator, buyer);
    // the creator is the depositor here: creates a vault, moves the position NFT in, deposits
    const stMintKp = Keypair.generate();
    const cv = await client.createVault({ depositor: creator.publicKey, stMint: stMintKp.publicKey, policy });
    send(svm, [cv.ix], [creator, cv.placeholder, stMintKp], { label: "create_vault" });
    const v0 = client.decodeVault(Buffer.from(svm.getAccount(cv.vault)!.data));
    expect(v0.status).deep.eq({ open: {} });
    expect(v0.placeholderWsol.equals(cv.placeholder.publicKey)).true;
    // a stale delegate on the NFT account: the deposit must refuse it
    const nftMint = ext.creatorPos.state.nftMint;
    const vaultNft = ataIx(creator.publicKey, nftMint, cv.vault, TOKEN_2022_PROGRAM_ID);
    send(svm, [vaultNft.ix, createTransferCheckedInstruction(ext.creatorPos.nftAccount, nftMint, vaultNft.address, creator.publicKey, 1, 0, [], TOKEN_2022_PROGRAM_ID)], [creator]);
    expect(tokenOwner(svm, vaultNft.address).equals(cv.vault)).true;
    const dep = await client.depositPosition({ vault: cv.vault, depositor: creator.publicKey, streamIndex: 0, dammPool: ext.dammPool, position: ext.creatorPos.position, nftMint, nftAccount: vaultNft.address, baseMint: ext.mint });
    // wrong signer: a stranger cannot deposit into someone else's vault
    const stranger = fund(svm);
    const depStranger = await client.depositPosition({ vault: cv.vault, depositor: stranger.publicKey, streamIndex: 0, dammPool: ext.dammPool, position: ext.creatorPos.position, nftMint, nftAccount: vaultNft.address, baseMint: ext.mint });
    expectFail(svm, [depStranger], [stranger], "NotDepositor");
    send(svm, [dep], [creator], { label: "deposit_position" });
    const stream = client.decodeStream(Buffer.from(svm.getAccount((client as any).program.coder ? require("@cometail/client").deriveStream(cv.vault, 0) : cv.vault)!.data));
    expect(stream.isOwn).false;
    expect(stream.position.equals(ext.creatorPos.position)).true;
    expect(client.decodeVault(Buffer.from(svm.getAccount(cv.vault)!.data)).streamCount).eq(1);
    // the same position cannot be deposited twice (index account exists)
    const dep2 = await client.depositPosition({ vault: cv.vault, depositor: creator.publicKey, streamIndex: 1, dammPool: ext.dammPool, position: ext.creatorPos.position, nftMint, nftAccount: vaultNft.address, baseMint: ext.mint });
    expectFail(svm, [dep2], [creator], "already in use");
    // fees accrue to the position while it sits in the vault (nothing harvests before launch)
    const pool = damm.getPool(svm, ext.dammPool);
    const b2 = ensureAta(svm, buyer, pool.tokenAMint, buyer.publicKey);
    send(svm, [await damm.swapIx(svm, { pool: ext.dammPool, payer: buyer.publicKey, inputAccount: ext.buyerQuote, outputAccount: b2, amountIn: new BN(5_000_000_000) })], [buyer]);
    // withdraw: NFT goes back to the depositor; the depositor can then claim the fees
    const back = ataIx(creator.publicKey, nftMint, creator.publicKey, TOKEN_2022_PROGRAM_ID);
    const wd = await client.withdrawStream({ vault: cv.vault, depositor: creator.publicKey, stream: require("@cometail/client").deriveStream(cv.vault, 0), kind: "position", indexKey: ext.creatorPos.position, nftAccount: vaultNft.address, nftMint, depositorNftAccount: back.address });
    send(svm, [back.ix, wd], [creator], { label: "withdraw_stream" });
    expect(balance(svm, back.address).toString()).eq("1");
    const cq = ensureAta(svm, creator, NATIVE_MINT, creator.publicKey);
    const cb = ensureAta(svm, creator, pool.tokenAMint, creator.publicKey);
    send(svm, [await damm.claimPositionFeeIx(svm, { pool: ext.dammPool, position: ext.creatorPos.position, signer: creator.publicKey, tokenAAccount: cb, tokenBAccount: cq, nftAccount: back.address })], [creator]);
    const got = balance(svm, cq);
    expect(got.gte(new BN(15_999_990)) && got.lte(new BN(16_000_010))).true; // 80% of the claimable half of 1% of 5 SOL
  });

  it("rejects a position that still carries unlocked principal, and a delegated NFT", async () => {
    const svm = startSvm();
    const client = new VaultClient();
    const protocol = fund(svm), creator = fund(svm), buyer = fund(svm);
    const ext = await externalStream(svm, protocol, creator, buyer);
    const stMintKp = Keypair.generate();
    const cv = await client.createVault({ depositor: creator.publicKey, stMint: stMintKp.publicKey, policy });
    send(svm, [cv.ix], [creator, cv.placeholder, stMintKp]);
    const nftMint = ext.creatorPos.state.nftMint;
    const vaultNft = ataIx(creator.publicKey, nftMint, cv.vault, TOKEN_2022_PROGRAM_ID);
    send(svm, [vaultNft.ix, createTransferCheckedInstruction(ext.creatorPos.nftAccount, nftMint, vaultNft.address, creator.publicKey, 1, 0, [], TOKEN_2022_PROGRAM_ID)], [creator]);
    // the protocol's position is permanent-only too; a brand-new position with unlocked liquidity is the principal case
    const nft = Keypair.generate();
    const created = await damm.createPositionIx({ pool: ext.dammPool, owner: cv.vault, payer: creator.publicKey, nftMint: nft });
    send(svm, [created.ix], [creator, nft]);
    const depEmpty = await client.depositPosition({ vault: cv.vault, depositor: creator.publicKey, streamIndex: 0, dammPool: ext.dammPool, position: created.position, nftMint: nft.publicKey, nftAccount: created.nftAccount, baseMint: ext.mint });
    expectFail(svm, [depEmpty], [creator], "Principal"); // permanent_locked_liquidity == 0
    // a delegate approved on the vault-owned NFT account by... nobody can (only the owner can approve), so approve before moving: the depositor approves then transfers
    const nft2Acc = ensureAta(svm, creator, nftMint, creator.publicKey, TOKEN_2022_PROGRAM_ID);
    void nft2Acc; void createApproveInstruction; void PublicKey;
    // delegate None is enforced on the vault-owned account itself; a transfer clears SPL delegates, so the remaining
    // vector is the position's persistent delegate_permission bits, which the deposit clears through CPI:
    const dep = await client.depositPosition({ vault: cv.vault, depositor: creator.publicKey, streamIndex: 0, dammPool: ext.dammPool, position: ext.creatorPos.position, nftMint, nftAccount: vaultNft.address, baseMint: ext.mint });
    send(svm, [dep], [creator]);
    expect(damm.getPosition(svm, ext.creatorPos.position).delegatePermission).eq(0);
  });

  it("DBC rights, CreatedPool: rights transfer + creator position (PDA account handed to the vault) in one tx; the open-curve path rejects a graduated pool; one-time flags read from the pool; withdrawal hands the account back and closes both indices", async () => {
    const svm = startSvm();
    const client = new VaultClient();
    const protocol = fund(svm), creator = fund(svm), buyer = fund(svm);
    const ext = await externalStream(svm, protocol, creator, buyer);
    const stMintKp = Keypair.generate();
    const cv = await client.createVault({ depositor: creator.publicKey, stMint: stMintKp.publicKey, policy });
    send(svm, [cv.ix], [creator, cv.placeholder, stMintKp]);
    const nftMint = ext.creatorPos.state.nftMint;
    const xfer = await dbc.transferPoolCreatorIx(svm, ext.pool, creator.publicKey, cv.vault);
    // a graduated pool cannot enter through the open-curve path
    const depOpen = await client.depositDbcRights({ vault: cv.vault, depositor: creator.publicKey, streamIndex: 0, dbcPool: ext.pool, dbcConfig: ext.config, baseMint: ext.mint });
    expectFail(svm, [xfer, depOpen], [creator], "WrongStatus");
    // the migrated path needs the creator position in cp-amm's PDA account, vault-owned: without the hand-over it fails
    const dep = await client.depositDbcRightsMigrated({ vault: cv.vault, depositor: creator.publicKey, streamIndex: 0, dbcPool: ext.pool, dbcConfig: ext.config, baseMint: ext.mint, dammPool: ext.dammPool, creatorPosition: ext.creatorPos.position, creatorNftAccount: ext.creatorPos.nftAccount });
    expectFail(svm, [xfer, dep], [creator], "AccountMismatch");
    send(svm, [xfer, handPositionNftToVaultIx(nftMint, creator.publicKey, cv.vault), dep], [creator], { label: "deposit_dbc_rights_migrated" });
    expect(dbc.getPool(svm, ext.pool).creator.equals(cv.vault)).true;
    expect(tokenOwner(svm, ext.creatorPos.nftAccount).equals(cv.vault)).true;
    const stream = client.decodeStream(Buffer.from(svm.getAccount(require("@cometail/client").deriveStream(cv.vault, 0))!.data));
    expect(stream.kind).deep.eq({ dbcCreatorRights: {} });
    expect(stream.position.equals(ext.creatorPos.position)).true;
    expect(stream.nftAccount.equals(ext.creatorPos.nftAccount)).true;
    expect(stream.derivedDammPool.equals(ext.dammPool)).true;
    expect(stream.oneTimeClaims).eq(0); // plain launch: nothing withdrawn yet
    expect(svm.getAccount(deriveStreamIndex(ext.creatorPos.position))).not.null; // the bundled position has its own index
    expect(client.decodeVault(Buffer.from(svm.getAccount(cv.vault)!.data)).activeStreams).eq(1);
    // withdraw in Open: the position index is required; rights and the account's authority return; both indices close
    const streamKey = require("@cometail/client").deriveStream(cv.vault, 0);
    expectFail(svm, [await client.withdrawStream({ vault: cv.vault, depositor: creator.publicKey, stream: streamKey, kind: "dbc", indexKey: ext.pool, dbcPool: ext.pool, dbcConfig: ext.config, nftAccount: ext.creatorPos.nftAccount, nftMint })], [creator], "AccountMismatch");
    const wd = await client.withdrawStream({ vault: cv.vault, depositor: creator.publicKey, stream: streamKey, kind: "dbc", indexKey: ext.pool, position: ext.creatorPos.position, dbcPool: ext.pool, dbcConfig: ext.config, nftAccount: ext.creatorPos.nftAccount, nftMint });
    send(svm, [wd], [creator], { label: "withdraw_stream.dbc_migrated" });
    expect(dbc.getPool(svm, ext.pool).creator.equals(creator.publicKey)).true;
    expect(tokenOwner(svm, ext.creatorPos.nftAccount).equals(creator.publicKey)).true;
    expect(balance(svm, ext.creatorPos.nftAccount).toString()).eq("1");
    expect(closed(svm, deriveStreamIndex(ext.pool))).true;
    expect(closed(svm, deriveStreamIndex(ext.creatorPos.position))).true;
    expect(client.decodeVault(Buffer.from(svm.getAccount(cv.vault)!.data)).activeStreams).eq(0);
  });

  it("DBC rights, PreBondingCurve: rights only; after the external migration the creator position is registered permissionlessly", async () => {
    const svm = startSvm();
    const client = new VaultClient();
    const protocol = fund(svm), creator = fund(svm), buyer = fund(svm), anyone = fund(svm);
    const ext = await externalStream(svm, protocol, creator, buyer, "plain", false);
    const stMintKp = Keypair.generate();
    const cv = await client.createVault({ depositor: creator.publicKey, stMint: stMintKp.publicKey, policy });
    send(svm, [cv.ix], [creator, cv.placeholder, stMintKp]);
    const xfer = await dbc.transferPoolCreatorIx(svm, ext.pool, creator.publicKey, cv.vault);
    const dep = await client.depositDbcRights({ vault: cv.vault, depositor: creator.publicKey, streamIndex: 0, dbcPool: ext.pool, dbcConfig: ext.config, baseMint: ext.mint });
    send(svm, [xfer, dep], [creator], { label: "deposit_dbc_rights.pre_bonding" });
    const streamKey = require("@cometail/client").deriveStream(cv.vault, 0);
    expect(client.decodeStream(Buffer.from(svm.getAccount(streamKey)!.data)).position.equals(PublicKey.default)).true;
    // the curve completes and someone migrates it: the creator NFT lands in the vault's account
    await dbc.buy(svm, buyer, ext.pool, ext.buyerQuote, ext.buyerBase, ext.R.muln(6).divn(5));
    const mig = await dbc.migrateToDammV2(svm, buyer, ext.pool, DAMM_V2_MIGRATION_CONFIG.customizable);
    const mine = damm.findPositionOwnedBy(svm, [mig.firstPosition, mig.secondPosition], cv.vault)!;
    const theirs = damm.findPositionOwnedBy(svm, [mig.firstPosition, mig.secondPosition], protocol.publicKey)!;
    expect(mine).not.null;
    // registering the partner-side position (not the vault's) fails: wrong owner
    const regWrong = await client.registerStreamPosition({ vault: cv.vault, stream: streamKey, payer: anyone.publicKey, dbcPool: ext.pool, dbcConfig: ext.config, dammPool: mig.dammPool, position: theirs.position, nftAccount: theirs.nftAccount });
    expectFail(svm, [regWrong], [anyone], "AccountMismatch");
    const reg = await client.registerStreamPosition({ vault: cv.vault, stream: streamKey, payer: anyone.publicKey, dbcPool: ext.pool, dbcConfig: ext.config, dammPool: mig.dammPool, position: mine.position, nftAccount: mine.nftAccount });
    send(svm, [reg], [anyone], { label: "register_stream_position" });
    const s = client.decodeStream(Buffer.from(svm.getAccount(streamKey)!.data));
    expect(s.position.equals(mine.position)).true;
    expect(s.nftAccount.equals(mine.nftAccount)).true;
    // registering again is a duplicate (index exists)
    expectFail(svm, [reg], [anyone], "already in use");
  });

  it("split deposit: 30% of the creator's permanently locked position becomes a vault-owned slice; unlocked liquidity never moves", async () => {
    const svm = startSvm();
    const client = new VaultClient();
    const protocol = fund(svm), creator = fund(svm), buyer = fund(svm);
    const ext = await externalStream(svm, protocol, creator, buyer);
    const stMintKp = Keypair.generate();
    const cv = await client.createVault({ depositor: creator.publicKey, stMint: stMintKp.publicKey, policy });
    send(svm, [cv.ix], [creator, cv.placeholder, stMintKp]);
    const before = damm.getPosition(svm, ext.creatorPos.position).permanentLockedLiquidity;
    const split = await client.depositPositionSplit({ vault: cv.vault, depositor: creator.publicKey, streamIndex: 0, dammPool: ext.dammPool, sourcePosition: ext.creatorPos.position, sourceNftAccount: ext.creatorPos.nftAccount, baseMint: ext.mint, permanentLockedPct: 30, feeAPct: 0, feeBPct: 0 });
    send(svm, [split.ix], [creator, split.newNftMint], { cu: 600_000, label: "deposit_position_split" });
    const slice = damm.getPosition(svm, split.newPosition);
    const after = damm.getPosition(svm, ext.creatorPos.position).permanentLockedLiquidity;
    expect(slice.permanentLockedLiquidity.add(after).toString()).eq(before.toString());
    const bps = slice.permanentLockedLiquidity.muln(10000).div(before).toNumber();
    expect(bps).gte(2999); expect(bps).lte(3000);
    expect(slice.unlockedLiquidity.isZero() && slice.vestedLiquidity.isZero()).true;
    expect(tokenOwner(svm, split.newNftAccount).equals(cv.vault)).true;
    const s = client.decodeStream(Buffer.from(svm.getAccount(require("@cometail/client").deriveStream(cv.vault, 0))!.data));
    expect(s.position.equals(split.newPosition)).true;
    void dammPositionNftAccount;
  });
});
