// Devnet end-to-end for tails (no program of ours changes; the burn program and its stand-in $COMETAIL pool are
// the ones e2e-burn set up):
//   1. a fee-sale config with stream-50's parameters at devnet scale; a plain wallet launches the tail on it;
//   2. trades on the curve; the wallet creates its position in the stand-in $COMETAIL pool;
//   3. two claims, each split in one transaction (half kept, a quarter to the burn reserve, a quarter locked as
//      $COMETAIL liquidity), exact amounts checked;
//   4. a buyback spends the reserve; the worker's tail index reads both claims, the reserve ledger and the burn;
//   5. the curve fills; the keeper's tail migration graduates it; the wallet collects the graduation payout;
//   6. a trade on the graduated pool; its creator position fees through the burn program's owner claim, half
//      to the reserve.
// Devnet only. Record: .local/e2e-tail-<time>.json.
//   cd tests && RPC=<devnet rpc> ./node_modules/.bin/ts-mocha --exit -p ./tsconfig.json -t 3000000 devnet/e2e-tail.ts
import { BN } from "@coral-xyz/anchor";
import { Connection, Keypair, PublicKey, SystemProgram, SYSVAR_INSTRUCTIONS_PUBKEY } from "@solana/web3.js";
import { TOKEN_PROGRAM_ID } from "@solana/spl-token";
import { expect } from "chai";
import fs from "fs";
import path from "path";
import { BurnClient, compoundingPool, createLockedPositionIxs, tailCashoutIxs, tailClaimIxs } from "@cometail/client";
import { createPoolIx, DBC_POOL_AUTHORITY } from "../harness/dbc";
import { dbcProgram } from "../harness/programs";
import { Chain } from "../../worker/src/chain";
import { migrateTails } from "../../worker/src/keeper";
import { LookupTables } from "../../worker/src/lut";
import { openStore } from "../../worker/src/store";
import { readBurnState } from "../../worker/src/burn";
import { chainWalkDeps, parseTails, refreshSources, tailIndexPass, tailView } from "../../worker/src/tails";
import { NATIVE_MINT, poolAddrs, ata, ataIx, createConfigIx, curveBuyIx, dammPool, dammSwapIx, dbcConfig, dbcPool, deriveDammV2PoolAddress, log, positionOwnedBy, send, smallConfigParams, tokenBalance, wrapSolIxs, DAMM_V2_MIGRATION_CONFIG } from "./rpc";

const ROOT = path.resolve(__dirname, "..", "..");
const KEYS = path.join(ROOT, "keys", "devnet");
const RPC = process.env.RPC ?? "https://api.devnet.solana.com";
const key = (name: string) => Keypair.fromSecretKey(Uint8Array.from(JSON.parse(fs.readFileSync(path.join(KEYS, `${name}.json`), "utf8"))));
const big = (v: any) => BigInt(v.toString());
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Sell `amount` raw tail tokens back into the curve (exact in). */
async function curveSellIx(a: { config: PublicKey; baseMint: PublicKey; seller: PublicKey; amount: BN }) {
  const addrs = poolAddrs(a.config, a.baseMint, NATIVE_MINT);
  return dbcProgram.methods.swap2({ amount0: a.amount, amount1: new BN(0), swapMode: 0 }).accountsPartial({
    poolAuthority: DBC_POOL_AUTHORITY, config: a.config, pool: addrs.pool, inputTokenAccount: ata(a.baseMint, a.seller), outputTokenAccount: ata(NATIVE_MINT, a.seller),
    baseVault: addrs.baseVault, quoteVault: addrs.quoteVault, baseMint: a.baseMint, quoteMint: NATIVE_MINT, payer: a.seller, tokenBaseProgram: TOKEN_PROGRAM_ID, tokenQuoteProgram: TOKEN_PROGRAM_ID, referralTokenAccount: null,
  }).remainingAccounts([{ pubkey: SYSVAR_INSTRUCTIONS_PUBKEY, isSigner: false, isWritable: false }]).instruction();
}

describe("devnet end-to-end: a tail launched by a plain wallet", () => {
  it("claims split by hand in one transaction, indexed and traced to the burn; graduation payout; graduated fees through the burn", async () => {
    const connection = new Connection(RPC, "confirmed");
    if ((await connection.getGenesisHash()) !== "EtWTRABZaYq6iMfeYKouRu166VU2xqa1wcaWoxPkrZBG") throw new Error("not devnet");
    const authority = key("authority"), keeper = key("keeper"), buyer = key("buyer");
    // a fresh creator wallet: the index finds its claims through this wallet's own transactions
    const creator = Keypair.generate();
    const chain = new Chain(connection);
    const client = new BurnClient(connection);
    const record: any = { startedAt: new Date().toISOString(), rpc: RPC.replace(/api-key=[^&]+/, "api-key=…"), steps: [] };
    const out = path.join(ROOT, ".local", `e2e-tail-${record.startedAt.replace(/[:.]/g, "-")}.json`);
    const plain = (v: unknown) => JSON.parse(JSON.stringify(v, (_k, x) => (typeof x === "bigint" ? x.toString() : x)));
    const step = (name: string, data: Record<string, unknown>) => { record.steps.push({ name, ...plain(data) }); fs.writeFileSync(out, JSON.stringify(record, null, 2)); log(name, plain(data)); };
    const st = (await readBurnState(chain, client))!;
    expect(st, "the burn program is set up on devnet").not.null;
    const target = st.pool;
    step("burn program and its stand-in $COMETAIL pool", { reserve: st.reserve.toBase58(), cometailMint: st.cometailMint.toBase58(), pool: target.toBase58() });
    await send(connection, [SystemProgram.transfer({ fromPubkey: authority.publicKey, toPubkey: creator.publicKey, lamports: 250_000_000 })], [authority], { label: "authority funds the fresh tail creator" });
    if ((await connection.getBalance(buyer.publicKey)) < 300_000_000) await send(connection, [SystemProgram.transfer({ fromPubkey: authority.publicKey, toPubkey: buyer.publicKey, lamports: 300_000_000 })], [authority], { label: "authority funds the buyer" });

    // 1. the fee-sale config (stream-50's parameters, devnet scale) and the tail, launched by the plain wallet
    const cfgKp = Keypair.generate(), tailKp = Keypair.generate();
    await send(connection, [await createConfigIx({ config: cfgKp.publicKey, feeClaimer: authority.publicKey, leftoverReceiver: authority.publicKey, payer: authority.publicKey, params: smallConfigParams("stream-50", 80) })], [authority, cfgKp], { label: "fee-sale config (stream-50 economics, devnet scale)" });
    const L = await createPoolIx({ config: cfgKp.publicKey, baseMint: tailKp.publicKey, quoteMint: NATIVE_MINT, creator: creator.publicKey, payer: creator.publicKey, name: "tail of COMETAIL (devnet)", symbol: "tCOMET", uri: "https://cometail.fun/devnet/e2e.json" });
    const launchSig = await send(connection, [L.ix], [creator, tailKp], { cu: 600_000, label: "launch the tail from the wallet" });
    expect(new PublicKey((await dbcPool(connection, L.pool)).creator).equals(creator.publicKey)).true;
    const R = big((await dbcConfig(connection, cfgKp.publicKey)).migrationQuoteThreshold);
    step("tail launched", { signature: launchSig, mint: tailKp.publicKey.toBase58(), config: cfgKp.publicKey.toBase58(), curve: L.pool.toBase58(), creator: creator.publicKey.toBase58(), raise: R.toString() });

    // 2. trades (buys and sells, so fees accrue without filling) and the wallet's position in the target pool
    const wsolNeed = new BN(((R * 145n) / 100n).toString());
    const held = await tokenBalance(connection, ata(NATIVE_MINT, buyer.publicKey)).catch(() => new BN(0));
    await send(connection, [ataIx(buyer.publicKey, NATIVE_MINT, buyer.publicKey), ...(held.lt(wsolNeed) ? wrapSolIxs(buyer.publicKey, wsolNeed.sub(held)) : []), ataIx(buyer.publicKey, tailKp.publicKey, buyer.publicKey)], [buyer], { label: "buyer wraps SOL" });
    const roundTrip = async (lamports: bigint, label: string) => {
      await send(connection, [await curveBuyIx({ config: cfgKp.publicKey, baseMint: tailKp.publicKey, buyer: buyer.publicKey, amountIn: new BN(lamports.toString()) })], [buyer], { cu: 400_000, label: `${label}: buy` });
      const got = await tokenBalance(connection, ata(tailKp.publicKey, buyer.publicKey));
      await send(connection, [await curveSellIx({ config: cfgKp.publicKey, baseMint: tailKp.publicKey, seller: buyer.publicKey, amount: got })], [buyer], { cu: 400_000, label: `${label}: sell` });
    };
    await roundTrip((R * 8n) / 10n, "trades 1");
    const nft = Keypair.generate();
    const tp = await dammPool(connection, target);
    const setup = createLockedPositionIxs({ owner: creator.publicKey, pool: target, nftMint: nft.publicKey, tokenAMint: tp.tokenAMint, tailMint: tailKp.publicKey });
    const setupSig = await send(connection, setup.ixs, [creator, nft], { cu: 200_000, label: "the wallet's locked position in the $COMETAIL pool" });
    step("locked position", { signature: setupSig, position: setup.position.toBase58() });
    const locked = { position: setup.position, nftAccount: setup.nftAccount };
    const wsol = ata(NATIVE_MINT, creator.publicKey);

    // 3. two claims, each split in its own single transaction
    const claims: any[] = [];
    let lockedTotal = 0n;
    for (const round of [1, 2]) {
      if (round === 2) await roundTrip((R * 7n) / 10n, "trades 2");
      const pool = await dbcPool(connection, L.pool);
      const claimable = big(pool.creatorQuoteFee);
      const x = compoundingPool(target, await dammPool(connection, target));
      const built = tailClaimIxs({ creator: creator.publicKey, curve: { pool: L.pool, baseMint: tailKp.publicKey, baseVault: L.baseVault, quoteVault: L.quoteVault }, claimable, reserve: st.reserve, x, locked });
      const before = { reserve: big(await tokenBalance(connection, st.reserve)), wsol: big(await tokenBalance(connection, wsol)) };
      const sig = await send(connection, built.ixs, [creator], { cu: 400_000, label: `claim and split ${round}` });
      const after = { reserve: big(await tokenBalance(connection, st.reserve)), wsol: big(await tokenBalance(connection, wsol)) };
      const pos = await chain.damm.account.position.fetch(setup.position, "confirmed") as any;
      lockedTotal += built.liquidityDelta;
      expect(after.reserve - before.reserve, "a quarter to the reserve").eq(built.split.toBurn);
      expect(big(pos.permanentLockedLiquidity), "locked exactly what was added").eq(lockedTotal);
      expect(big(pos.unlockedLiquidity)).eq(0n);
      const raw: any = await connection.getTransaction(sig, { commitment: "confirmed", maxSupportedTransactionVersion: 0 });
      claims.push({ round, signature: sig, claimable, split: built.split, liquidityDelta: built.liquidityDelta, keptInWallet: after.wsol - before.wsol, cu: raw?.meta?.computeUnitsConsumed ?? null });
      step(`claim ${round}`, claims[claims.length - 1]);
    }

    // 3b. a claim that is not split (the creator claims directly): the index must list it as such
    await roundTrip((R * 5n) / 10n, "trades 3");
    const owedRaw = big((await dbcPool(connection, L.pool)).creatorQuoteFee);
    const { dbcProgram: dbcP } = await import("../harness/programs");
    const rawClaim = await dbcP.methods.claimCreatorTradingFee(new BN(0), new BN(owedRaw.toString())).accountsPartial({ poolAuthority: DBC_POOL_AUTHORITY, pool: L.pool, tokenAAccount: ata(tailKp.publicKey, creator.publicKey), tokenBAccount: wsol, baseVault: L.baseVault, quoteVault: L.quoteVault, baseMint: tailKp.publicKey, quoteMint: NATIVE_MINT, creator: creator.publicKey, tokenBaseProgram: TOKEN_PROGRAM_ID, tokenQuoteProgram: TOKEN_PROGRAM_ID }).instruction();
    const unsplitSig = await send(connection, [rawClaim], [creator], { cu: 200_000, label: "a claim with no split" });
    step("unsplit claim", { signature: unsplitSig, claimed: owedRaw });

    // 4. a buyback spends the reserve (when the cooldown allows), then the worker's tail index reads it all
    const fresh = (await readBurnState(chain, client))!;
    const due = fresh.lastBuyTs.toNumber() + 600 <= Math.floor(Date.now() / 1000);
    if (due) {
      const p = await dammPool(connection, target);
      const sig = await send(connection, [await client.buyback({ state: fresh, tokenAVault: p.tokenAVault, tokenBVault: p.tokenBVault })], [keeper], { cu: 400_000, label: "burn buyback" });
      step("buyback", { signature: sig });
    } else step("buyback skipped: cooldown", { lastBuyTs: fresh.lastBuyTs.toNumber() });
    const dbPath = path.join(ROOT, ".local", `e2e-tail-store-${Date.now()}.sqlite`);
    const store = openStore(`sqlite:${dbPath}`); await store.init();
    const tails = parseTails(`${tailKp.publicKey.toBase58()}:${cfgKp.publicKey.toBase58()}:${target.toBase58()}`);
    const index = async (want: (v: any) => boolean) => { for (let i = 0; i < 15; i++) { { const deps = chainWalkDeps(connection); await tailIndexPass(deps, store, tails, st.reserve, (t) => refreshSources(chain, deps, store, t)); } const v: any = (await tailView(store, tails, null)).tails[0]; if (v.coverage.claims.status === "complete" && v.coverage.reserve.status === "complete" && want(v)) return v; await sleep(5_000); } return (await tailView(store, tails, null)).tails[0] as any; };
    expect(tails[0].curve.equals(L.pool)).true;
    const view: any = await index((v) => v.claims.length >= 3);
    expect(view.claims.length).eq(3);
    for (const c of claims) {
      const r = view.claims.find((x: any) => x.signature === c.signature);
      expect(r, `indexed claim ${c.round}`).not.undefined;
      expect(r.status).eq("split");
      expect(r.claimedLamports).eq(c.claimable.toString());
      expect(r.toBurnLamports).eq(c.split.toBurn.toString());
      expect(r.liquidity.liquidity).eq(c.liquidityDelta.toString());
    }
    const u = view.claims.find((x: any) => x.signature === unsplitSig);
    expect([u.status, u.claimedLamports, u.toBurnLamports]).deep.eq(["unsplit", owedRaw.toString(), null]);
    expect(view.totals.notSplit).eq(1);
    expect(view.totals.lockedLiquidity).eq(lockedTotal.toString());
    step("worker tail index", { coverage: view.coverage, totals: view.totals, claims: view.claims.map((c: any) => ({ signature: c.signature, toBurn: c.toBurnLamports, burn: c.burn, liquidity: c.liquidity })) });

    // 5. fill; the keeper's tail migration; the graduation payout to the wallet
    await send(connection, [await curveBuyIx({ config: cfgKp.publicKey, baseMint: tailKp.publicKey, buyer: buyer.publicKey, amountIn: new BN(((R * 12n) / 10n).toString()) })], [buyer], { cu: 400_000, label: "fill the tail's curve" });
    const ctx: any = { chain, cfg: { tails, cuPriceMicroLamports: 0, dryRun: false }, keeper, luts: new LookupTables(connection, keeper, false) };
    for (let i = 0; i < 6 && Number((await dbcPool(connection, L.pool)).migrationProgress) !== 3; i++) { await migrateTails(ctx); if (Number((await dbcPool(connection, L.pool)).migrationProgress) !== 3) await sleep(10_000); }
    expect(Number((await dbcPool(connection, L.pool)).migrationProgress), "graduated by the keeper's tail migration").eq(3);
    const gpool = deriveDammV2PoolAddress(DAMM_V2_MIGRATION_CONFIG.customizable, tailKp.publicKey, NATIVE_MINT);
    const p5 = await dbcPool(connection, L.pool);
    const w0 = big(await tokenBalance(connection, wsol));
    const payoutSig = await send(connection, tailCashoutIxs({ creator: creator.publicKey, config: cfgKp.publicKey, curve: { pool: L.pool, baseMint: tailKp.publicKey, baseVault: L.baseVault, quoteVault: L.quoteVault }, migrationFeePending: (Number(p5.migrationFeeWithdrawStatus) & 2) === 0, surplusPending: Number(p5.isCreatorWithdrawSurplus) === 0 }), [creator], { label: "graduation payout" });
    const payout = big(await tokenBalance(connection, wsol)) - w0;
    const migrationFee = R - (R * 50n + 99n) / 100n; // the preset's 50% of the raise (gate 04's formula)
    expect(payout >= migrationFee, "at least the 50% migration fee; any creator surplus on top").true;
    step("graduated", { pool: gpool.toBase58(), payoutSignature: payoutSig, payout, migrationFee, surplus: payout - migrationFee });

    // 6. a trade on the graduated pool; the creator position's fees through the burn program's owner claim
    const gp = await dammPool(connection, gpool);
    await send(connection, [await dammSwapIx(connection, { pool: gpool, payer: buyer.publicKey, inputMint: NATIVE_MINT, outputMint: tailKp.publicKey, amountIn: new BN(150_000_000) })], [buyer], { cu: 400_000, label: "trade on the graduated tail pool" });
    const own = await positionOwnedBy(connection, (await chain.positionsOwnedBy(gpool, creator.publicKey)).map((p) => p.position), creator.publicKey);
    expect(own, "the wallet holds the tail's creator position").not.null;
    const r0 = big(await tokenBalance(connection, st.reserve)), o0 = big(await tokenBalance(connection, wsol));
    const gsig = await send(connection, [await client.ownerClaimPositionFees({ state: fresh, owner: creator.publicKey, ownerWsol: wsol, pool: gpool, position: own!.position, positionNftAccount: own!.nftAccount, tokenAVault: gp.tokenAVault, tokenBVault: gp.tokenBVault, tokenAMint: tailKp.publicKey })], [creator], { cu: 400_000, label: "graduated position fees through the burn owner claim" });
    const toReserve = big(await tokenBalance(connection, st.reserve)) - r0, toOwner = big(await tokenBalance(connection, wsol)) - o0;
    expect(toReserve > 0n).true;
    expect(Number(toOwner - toReserve) <= 1 && Number(toReserve - toOwner) <= 1, "half each").true;
    step("graduated position fees", { signature: gsig, toReserve, toOwner });
    const after: any = await index((v) => v.claims.some((c: any) => c.source === "pool") && v.payouts.length > 0);
    expect(after.origin?.creator).eq(creator.publicKey.toBase58());
    expect(after.graduatedPositions).include(own!.position.toBase58());
    const pc = after.claims.find((c: any) => c.signature === gsig);
    expect(pc && [pc.source, pc.status, pc.toBurnLamports]).deep.eq(["pool", "split", toReserve.toString()]);
    expect(after.payouts.map((p: any) => p.signature)).include(payoutSig);
    step("worker tail index after graduation", { totals: after.totals, coverage: after.coverage, payouts: after.payouts, poolClaim: pc });
    record.finishedAt = new Date().toISOString();
    fs.writeFileSync(out, JSON.stringify(record, (_k, v) => (typeof v === "bigint" ? v.toString() : v), 2));
    await store.close();
  });
});
