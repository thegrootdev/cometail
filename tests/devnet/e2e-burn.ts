// Devnet end-to-end for the burn program, through the real keeper and indexer modules:
//   1. a stand-in $COMETAIL: a coin on a Standard-economics config (fee claimer = the devnet authority, as
//      today), filled and graduated into a 1% compounding DAMM v2 pool;
//   2. setup of the burn program by its upgrade authority (the devnet authority key);
//   3. a new launch config naming the program's claimer, byte-identical to a fresh copy of today's preset
//      except the fee claimer;
//   4. a coin launched on the new config, traded; the keeper's pass claims its curve and creation fees through
//      the program, which splits them 50/50 (exact deltas checked);
//   5. the curve filled; the keeper migrates it (the new config in its migrate list); trading on the pool; the
//      keeper claims the claimer-held position's fees, split 50/50;
//   6. half of a direct deposit to the reserve (the owner's commitment path: a plain transfer from the treasury);
//   7. the keeper's buyback: a real buy on the stand-in pool and a burn of exactly what it bought (supply
//      delta = event), the caller paid nothing; a second buyback refused inside ten minutes;
//   8. the indexer's burn pass and /api/burn's view against the program's own counters.
// Devnet only. Record: .local/e2e-burn-<time>.json.
//   cd tests && RPC=<devnet rpc> ./node_modules/.bin/ts-mocha --exit -p ./tsconfig.json -t 3000000 devnet/e2e-burn.ts
import { BN } from "@coral-xyz/anchor";
import { Connection, Keypair, PublicKey } from "@solana/web3.js";
import { createTransferInstruction } from "@solana/spl-token";
import { expect } from "chai";
import fs from "fs";
import path from "path";
import { BurnClient } from "@cometail/client";
import { createPoolIx } from "../harness/dbc";
import { Chain } from "../../worker/src/chain";
import { keeperPass } from "../../worker/src/keeper";
import { LookupTables } from "../../worker/src/lut";
import { openStore } from "../../worker/src/store";
import { burnParser, readBurnState } from "../../worker/src/burn";
import { burnIndexPass, chainDeps } from "../../worker/src/burnindex";
import { burnViewer } from "../../worker/src/burnview";
import type { Config } from "../../worker/src/config";
import { NATIVE_MINT, poolAddrs, ata, ataIx, createConfigIx, curveBuyIx, dammPool, dammSwapIx, dbcConfig, dbcPool, deriveDammV2PoolAddress, log, migrateToDammV2, send, smallConfigParams, tokenBalance, wrapSolIxs, DAMM_V2_MIGRATION_CONFIG } from "./rpc";

const ROOT = path.resolve(__dirname, "..", "..");
const KEYS = path.join(ROOT, "keys", "devnet");
const RPC = process.env.RPC ?? "https://api.devnet.solana.com";
const key = (name: string) => Keypair.fromSecretKey(Uint8Array.from(JSON.parse(fs.readFileSync(path.join(KEYS, `${name}.json`), "utf8"))));
const META = (name: string, symbol: string) => ({ name, symbol, uri: "https://cometail.fun/devnet/e2e.json" });
const supplyOf = async (c: Connection, mint: PublicKey) => BigInt((await c.getTokenSupply(mint, "confirmed")).value.amount);
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe("devnet end-to-end: burn program", () => {
  it("claims split 50/50 through the program, and a real buyback burns what it bought", async () => {
    const connection = new Connection(RPC, "confirmed");
    if ((await connection.getGenesisHash()) !== "EtWTRABZaYq6iMfeYKouRu166VU2xqa1wcaWoxPkrZBG") throw new Error("not devnet");
    const authority = key("authority"), keeper = key("keeper"), buyer = key("buyer"), creator = key("depositor");
    const chain = new Chain(connection);
    const client = new BurnClient(connection);
    const record: any = { startedAt: new Date().toISOString(), rpc: RPC.replace(/api-key=[^&]+/, "api-key=…"), steps: [] };
    const out = path.join(ROOT, ".local", `e2e-burn-${record.startedAt.replace(/[:.]/g, "-")}.json`);
    const step = (name: string, data: Record<string, unknown>) => { record.steps.push({ name, ...data }); fs.writeFileSync(out, JSON.stringify(record, null, 2)); log(name, data); };
    const treasury = ata(NATIVE_MINT, authority.publicKey);
    // the keeper needs SOL for its fees; the buyer funds it from the faucet money it holds
    if ((await connection.getBalance(keeper.publicKey)) < 200_000_000) {
      const { SystemProgram } = await import("@solana/web3.js");
      await send(connection, [SystemProgram.transfer({ fromPubkey: buyer.publicKey, toPubkey: keeper.publicKey, lamports: 300_000_000 })], [buyer], { label: "buyer funds the keeper" });
    }
    const wsolHeld = await tokenBalance(connection, ata(NATIVE_MINT, buyer.publicKey)).catch(() => new BN(0));
    if (wsolHeld.lt(new BN(900_000_000))) await send(connection, [ataIx(buyer.publicKey, NATIVE_MINT, buyer.publicKey), ...wrapSolIxs(buyer.publicKey, new BN(900_000_000).sub(wsolHeld))], [buyer], { label: "buyer wraps up to 0.9 SOL" });

    // 1. the stand-in $COMETAIL on today's Standard economics (deeper curve so a buyback chunk clears the 0.001 SOL
    //    minimum); STANDIN=<mint>,<config> reuses one an earlier attempt filled
    let coin: { publicKey: PublicKey }, legacyCfg: { publicKey: PublicKey };
    if (process.env.STANDIN) {
      const [m, c] = process.env.STANDIN.split(",");
      coin = { publicKey: new PublicKey(m) }; legacyCfg = { publicKey: new PublicKey(c) };
    } else {
      const cfgKp = Keypair.generate(), coinKp = Keypair.generate();
      await send(connection, [await createConfigIx({ config: cfgKp.publicKey, feeClaimer: authority.publicKey, leftoverReceiver: authority.publicKey, payer: authority.publicKey, params: smallConfigParams("plain", 30) })], [authority, cfgKp], { label: "today's Standard config (stand-in scale)" });
      const L1 = await createPoolIx({ config: cfgKp.publicKey, baseMint: coinKp.publicKey, quoteMint: NATIVE_MINT, creator: creator.publicKey, payer: creator.publicKey, ...META("COMETAIL devnet", "dCOMET") });
      await send(connection, [L1.ix], [creator, coinKp], { cu: 600_000, label: "launch stand-in $COMETAIL" });
      const R1 = new BN((await dbcConfig(connection, cfgKp.publicKey)).migrationQuoteThreshold.toString());
      await send(connection, [ataIx(buyer.publicKey, NATIVE_MINT, buyer.publicKey), ...wrapSolIxs(buyer.publicKey, R1.muln(13).divn(10)), ataIx(buyer.publicKey, coinKp.publicKey, buyer.publicKey), await curveBuyIx({ config: cfgKp.publicKey, baseMint: coinKp.publicKey, buyer: buyer.publicKey, amountIn: R1.muln(13).divn(10) })], [buyer], { cu: 400_000, label: "fill the stand-in curve" });
      coin = coinKp; legacyCfg = cfgKp;
    }
    const cometPoolMaybe = deriveDammV2PoolAddress(DAMM_V2_MIGRATION_CONFIG.customizable, coin.publicKey, NATIVE_MINT);
    if (!(await connection.getAccountInfo(cometPoolMaybe))) await migrateToDammV2(connection, buyer, { config: legacyCfg.publicKey, baseMint: coin.publicKey });
    const cometPool = deriveDammV2PoolAddress(DAMM_V2_MIGRATION_CONFIG.customizable, coin.publicKey, NATIVE_MINT);
    const cp = await dammPool(connection, cometPool);
    expect(cp.collectFeeMode).eq(2);
    step("stand-in $COMETAIL", { mint: coin.publicKey.toBase58(), config: legacyCfg.publicKey.toBase58(), pool: cometPool.toBase58(), poolSolLamports: cp.tokenBAmount.toString() });

    // 2. setup by the upgrade authority
    if (!(await readBurnState(chain, client))) {
      const sig = await send(connection, [await client.setup({ authority: authority.publicKey, cometailMint: coin.publicKey, pool: cometPool, treasury })], [authority], { label: "burn setup" });
      step("setup", { signature: sig });
    }
    const st = (await readBurnState(chain, client))!;
    expect(st.pool.equals(cometPool)).eq(true);
    // this run's window: earlier runs on the same program left history (some from the first candidate, whose
    // event format the indexer no longer reads), so the history checks below compare this run's changes only
    const startSlot = await connection.getSlot("confirmed");
    const s0 = st;
    step("burn state", { burnState: client.a.burnState.toBase58(), claimer: client.a.claimer.toBase58(), reserve: st.reserve.toBase58(), treasury: st.treasury.toBase58(), feeNumerator: st.feeNumerator.toString() });

    // 3. the new launch config and a fresh copy of today's preset with the same parameters
    const burnCfg = Keypair.generate(), todayCfg = Keypair.generate();
    const params = smallConfigParams("plain");
    await send(connection, [await createConfigIx({ config: burnCfg.publicKey, feeClaimer: client.a.claimer, leftoverReceiver: authority.publicKey, payer: authority.publicKey, params })], [authority, burnCfg], { label: "new launch config (claimer = burn program)" });
    await send(connection, [await createConfigIx({ config: todayCfg.publicKey, feeClaimer: authority.publicKey, leftoverReceiver: authority.publicKey, payer: authority.publicKey, params })], [authority, todayCfg], { label: "today's preset, same parameters" });
    const a = (await connection.getAccountInfo(todayCfg.publicKey))!.data, b = (await connection.getAccountInfo(burnCfg.publicKey))!.data;
    const diff = [...a.keys()].filter((i) => a[i] !== b[i]);
    expect(diff.every((i) => i >= 40 && i < 72)).eq(true);
    step("configs", { burnConfig: burnCfg.publicKey.toBase58(), todayConfig: todayCfg.publicKey.toBase58(), differingBytes: diff.length, onlyFeeClaimer: true });

    // 4. a launch on the new config; the keeper claims curve and creation fees through the program
    const x = Keypair.generate();
    const L2 = await createPoolIx({ config: burnCfg.publicKey, baseMint: x.publicKey, quoteMint: NATIVE_MINT, creator: creator.publicKey, payer: creator.publicKey, ...META("Burn launch", "BRNL") });
    await send(connection, [L2.ix], [creator, x], { cu: 600_000, label: "launch on the new config" });
    const R2 = new BN((await dbcConfig(connection, burnCfg.publicKey)).migrationQuoteThreshold.toString());
    await send(connection, [ataIx(buyer.publicKey, x.publicKey, buyer.publicKey), await curveBuyIx({ config: burnCfg.publicKey, baseMint: x.publicKey, buyer: buyer.publicKey, amountIn: R2.muln(3).divn(10) })], [buyer], { cu: 400_000, label: "buy 30% of the new launch" });
    const owed = BigInt((await dbcPool(connection, L2.pool)).partnerQuoteFee.toString());
    const ctx = { chain, cfg: keeperCfg(keeper, [legacyCfg.publicKey, burnCfg.publicKey], [burnCfg.publicKey]), keeper, luts: new LookupTables(connection, keeper, false) };
    // one keeper pass: claims split through the program, and a buyback whenever one is due
    const snap = async () => ({ s: (await readBurnState(chain, client))!, reserve: BigInt((await tokenBalance(connection, st.reserve)).toString()), treasury: BigInt((await tokenBalance(connection, treasury)).toString()), supply: await supplyOf(connection, coin.publicKey) });
    const d = (a: any, b: any, f: string) => BigInt(b.s[f].toString()) - BigInt(a.s[f].toString());
    /** Every balance moved exactly as the program's own counters say: reserve += to-reserve - spent, treasury += to-treasury, supply -= burned. */
    const balanced = (a: any, b: any, direct = 0n) => {
      expect(b.reserve - a.reserve, "reserve").eq(d(a, b, "splitToReserve") - d(a, b, "spentTotal") + direct);
      expect(b.treasury - a.treasury, "treasury").eq(d(a, b, "splitToTreasury") - direct);
      expect(a.supply - b.supply, "supply").eq(d(a, b, "burnedTotal"));
    };
    const a4 = await snap();
    await keeperPass(ctx as any);
    const b4 = await snap();
    balanced(a4, b4);
    expect(d(a4, b4, "splitTotal") >= owed).eq(true); // curve fees plus the creation fee
    expect(BigInt((await dbcPool(connection, L2.pool)).partnerQuoteFee.toString())).eq(0n);
    step("claims through the program", { curveFeesOwed: owed.toString(), claimed: d(a4, b4, "splitTotal").toString(), toReserve: d(a4, b4, "splitToReserve").toString(), toTreasury: d(a4, b4, "splitToTreasury").toString(), boughtInSamePass: d(a4, b4, "buybacks").toString(), burnedInSamePass: d(a4, b4, "burnedTotal").toString() });

    // 5. fill, keeper migration, pool trading, position fees through the program
    await send(connection, [await curveBuyIx({ config: burnCfg.publicKey, baseMint: x.publicKey, buyer: buyer.publicKey, amountIn: R2 })], [buyer], { cu: 400_000, label: "fill the new launch" });
    // the keeper migrates curves on its migrate list (the new config is on it); the public RPC's program scan can lag a fresh fill
    for (let i = 0; i < 6 && Number((await dbcPool(connection, L2.pool)).migrationProgress) !== 3; i++) { await keeperPass(ctx as any); if (Number((await dbcPool(connection, L2.pool)).migrationProgress) !== 3) await sleep(20_000); }
    const xPool = deriveDammV2PoolAddress(DAMM_V2_MIGRATION_CONFIG.customizable, x.publicKey, NATIVE_MINT);
    expect(Number((await dbcPool(connection, L2.pool)).migrationProgress)).eq(3);
    const held = await chain.positionsOwnedBy(xPool, client.a.claimer);
    expect(held.length).eq(1);
    step("graduated on the new config", { pool: xPool.toBase58(), claimerPosition: held[0].position.toBase58() });
    await send(connection, [await dammSwapIx(connection, { pool: xPool, payer: buyer.publicKey, inputMint: NATIVE_MINT, outputMint: x.publicKey, amountIn: new BN(150_000_000) })], [buyer], { cu: 400_000, label: "trade on the graduated pool" });
    const a5 = await snap();
    await keeperPass(ctx as any);
    const b5 = await snap();
    balanced(a5, b5);
    expect(d(a5, b5, "splitTotal") > 0n).eq(true);
    step("position fees through the program", { paid: d(a5, b5, "splitTotal").toString(), splitTotal: b5.s.splitTotal.toString() });

    // 5b. owner claims through the program: the devnet authority is the fee claimer of the stand-in's older config
    //     and holds its partner position; exactly half of what each claim pays goes to the reserve, half back to it
    const ownerWsol = treasury;
    const legacyPool = await dbcPool(connection, L1pool(coin.publicKey, legacyCfg.publicKey));
    const before5b = await snap();
    const owedLegacy = BigInt(legacyPool.partnerQuoteFee.toString());
    const inbox0 = BigInt((await tokenBalance(connection, st.inbox)).toString());
    const ownerIxs = [];
    if (owedLegacy > 0n) ownerIxs.push(await client.ownerClaimCurveFees({ state: st, owner: authority.publicKey, ownerWsol, config: legacyCfg.publicKey, pool: L1pool(coin.publicKey, legacyCfg.publicKey), baseVault: legacyPool.baseVault, quoteVault: legacyPool.quoteVault, baseMint: coin.publicKey }));
    const partnerPos = await chain.positionsOwnedBy(cometPool, authority.publicKey);
    const cpNow: any = await dammPool(connection, cometPool);
    if (partnerPos.length) ownerIxs.push(await client.ownerClaimPositionFees({ state: st, owner: authority.publicKey, ownerWsol, pool: cometPool, position: partnerPos[0].position, positionNftAccount: partnerPos[0].nftAccount, tokenAVault: cpNow.tokenAVault, tokenBVault: cpNow.tokenBVault, tokenAMint: coin.publicKey }));
    expect(ownerIxs.length).gte(1);
    const ownerSig = await send(connection, ownerIxs, [authority], { cu: 600_000, label: "owner claims through the program" });
    const ownerTx = await connection.getTransaction(ownerSig, { maxSupportedTransactionVersion: 0, commitment: "confirmed" });
    const evs = [...burnParser.parseLogs(ownerTx?.meta?.logMessages ?? [])].filter((e) => e.name === "ClaimSplit");
    const after5b = await snap();
    const claimedOwner = evs.reduce((t, e: any) => t + BigInt(e.data.claimed.toString()), 0n);
    expect(after5b.reserve - before5b.reserve).eq(evs.reduce((t, e: any) => t + BigInt(e.data.to_reserve.toString()), 0n));
    for (const e of evs as any[]) { expect(BigInt(e.data.to_reserve.toString())).eq(BigInt(e.data.claimed.toString()) / 2n); expect(e.data.claimant.equals(authority.publicKey)).eq(true); }
    expect(BigInt((await tokenBalance(connection, st.inbox)).toString())).eq(inbox0); // carried funds untouched
    if (owedLegacy > 0n) expect(BigInt(evs[0].data.claimed.toString())).eq(owedLegacy);
    step("owner claims through the program", { signature: ownerSig, claims: evs.length, claimed: claimedOwner.toString(), toReserve: (after5b.reserve - before5b.reserve).toString() });

    // 6. a direct deposit from the treasury (the owner's commitment path): a plain transfer, never a close
    const direct = 2_000_000n;
    const a6 = await snap();
    await send(connection, [createTransferInstruction(treasury, st.reserve, authority.publicKey, direct)], [authority], { label: "treasury sends to the burn reserve" });
    balanced(a6, await snap(), direct);
    step("direct deposit", { lamports: direct.toString() });

    // 7. a buyback of its own: wait out the ten minutes since the last one, then one keeper pass
    const due = (await readBurnState(chain, client))!.lastBuyTs.toNumber() + 600 + 5;
    const waitMs = Math.max(0, due * 1000 - Date.now());
    if (waitMs) { log("waiting for the next buyback window", { seconds: Math.round(waitMs / 1000) }); await sleep(waitMs); }
    const a7 = await snap();
    await keeperPass(ctx as any);
    const b7 = await snap();
    balanced(a7, b7);
    expect(d(a7, b7, "buybacks")).eq(1n);
    expect(d(a7, b7, "burnedTotal") > 0n).eq(true);
    expect(BigInt((await tokenBalance(connection, st.bought)).toString())).eq(0n);
    const s7 = b7.s;
    const burned = BigInt(s7.burnedTotal.toString());
    step("buyback", { spentLamports: d(a7, b7, "spentTotal").toString(), burnedRaw: d(a7, b7, "burnedTotal").toString(), supplyBefore: a7.supply.toString(), supplyAfter: b7.supply.toString(), totalBuybacks: s7.buybacks.toString() });
    // a second buyback inside ten minutes is refused by the program (simulated)
    const pool7: any = await dammPool(connection, cometPool);
    const ix = await client.buyback({ state: s7, tokenAVault: pool7.tokenAVault, tokenBVault: pool7.tokenBVault });
    const { Transaction } = await import("@solana/web3.js");
    const tx = new Transaction().add(ix); tx.feePayer = keeper.publicKey; tx.recentBlockhash = (await connection.getLatestBlockhash()).blockhash;
    const sim = await connection.simulateTransaction(tx);
    expect(JSON.stringify(sim.value.logs ?? [])).match(/Cooldown/);
    step("cooldown", { secondBuybackRefused: true });

    // 8. the indexer's burn pass and the /api/burn view
    const store = openStore(`sqlite:${path.join(ROOT, ".local", `e2e-burn-store-${Date.now()}.sqlite`)}`); await store.init();
    // the public RPC rate-limits bursts: each pass retries, and the history must end complete
    for (let i = 0; i < 12; i++) { try { await burnIndexPass(chainDeps(chain.connection), store); } catch (e) { log("burn index pass retry", { error: String((e as Error).message ?? e).slice(0, 120) }); } await sleep(5_000); }
    const view: any = await burnViewer(chain, store, { cluster: "devnet", burnConfigs: [burnCfg.publicKey.toBase58()], legacyConfigs: [legacyCfg.publicKey.toBase58()], feeIndex: null })();
    expect(view.status).eq("live");
    expect(view.coverage.status).eq("complete");
    expect(view.totals.burnedRaw).eq(burned.toString());
    // this run's events against this run's counter changes
    const runBurns = view.burns.filter((b: any) => b.slot >= startSlot), runSplits = view.splits.filter((x: any) => x.slot >= startSlot);
    expect(BigInt(runBurns.length)).eq(BigInt(s7.buybacks.toString()) - BigInt(s0.buybacks.toString()));
    expect(runBurns.reduce((t: bigint, b: any) => t + BigInt(b.burnedRaw), 0n)).eq(burned - BigInt(s0.burnedTotal.toString()));
    expect(runSplits.reduce((t: bigint, x: any) => t + BigInt(x.toReserveLamports) + BigInt(x.toOtherLamports), 0n)).eq(BigInt(s7.splitTotal.toString()) - BigInt(s0.splitTotal.toString()));
    expect(runSplits.filter((x: any) => x.claimant).length).eq(evs.length);
    expect(view.provenance.claimedByOwnersLamports !== null).eq(true);
    expect(BigInt(view.sentDirectLamports) >= direct).eq(true); // this run's deposit, plus any from earlier runs on the same program
    step("indexed view", { coverage: view.coverage.status, burns: view.burns.map((b: any) => b.signature), splits: view.splits.length, sentDirect: view.sentDirectLamports });
    fs.writeFileSync(out.replace(".json", "-view.json"), JSON.stringify(view, null, 2));
    await store.close();
    record.finishedAt = new Date().toISOString();
    fs.writeFileSync(out, JSON.stringify(record, null, 2));
  });
});

function L1pool(mint: PublicKey, config: PublicKey): PublicKey { return poolAddrs(config, mint, NATIVE_MINT).pool; }
function keeperCfg(keeper: Keypair, migrate: PublicKey[], burn: PublicKey[]): Config {
  return { rpcUrl: RPC, mode: "once", migrateConfigs: migrate, burnConfigs: burn, burnMinClaimLamports: 10_000n, pollMs: 0, keeper, dustLamports: 100_000n, minRouteLamports: 5_000_000n, maxRouteLamports: 5_000_000_000n, ladderBins: 3, ladderNearBps: 200, ladderFarBps: 2000, ladderDecay: 0.85, staleOrderSeconds: 86_400, databaseUrl: null, apiPort: 0, skyConfigs: [], skyEveryPasses: 1, dryRun: false, cuPriceMicroLamports: 0 } as any;
}
