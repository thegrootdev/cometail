// Devnet end-to-end: two plain launches, a vault holding both tails (one still
// bonding, one graduated), the stream token launched and filled, the keeper migrating,
// registering, cashing out, harvesting, laddering bids and settling a fill, and the indexer
// reading it all back. Devnet-only small-threshold configs with the presets' economics, so a
// curve fills with half a SOL. Addresses and signatures go to .local/e2e-<time>.json.
//   cd tests && RPC=https://api.devnet.solana.com ./node_modules/.bin/ts-mocha --exit -p ./tsconfig.json -t 2000000 devnet/e2e.ts
import { BN } from "@coral-xyz/anchor";
import { Connection, Keypair, PublicKey } from "@solana/web3.js";
import { createTransferInstruction } from "@solana/spl-token";
import { expect } from "chai";
import fs from "fs";
import path from "path";
import { VaultClientStep6, deriveStream, handPositionNftToVaultIx } from "@cometail/client";
import { createPoolIx } from "../harness/dbc";
import * as dlmm from "../harness/dlmm";
import { Chain } from "../../worker/src/chain";
import { keeperPass } from "../../worker/src/keeper";
import { LookupTables } from "../../worker/src/lut";
import { Indexer } from "../../worker/src/indexer";
import { openStore } from "../../worker/src/store";
import { scanSky } from "../../worker/src/sky";
import type { Config } from "../../worker/src/config";
import {
  NATIVE_MINT, ata, ataIx, createConfigIx, curveBuyIx, dammPool, dammSwapIx, dbcConfig, dbcPool, deriveDammV2PoolAddress, dlmmSwapIx, dlmmPair, log, migrateToDammV2,
  positionOwnedBy, smallConfigParams, send, tokenBalance, transferPoolCreatorIx, wrapSolIxs, DAMM_V2_MIGRATION_CONFIG,
} from "./rpc";

const ROOT = path.resolve(__dirname, "..", "..");
const KEYS = path.join(ROOT, "keys", "devnet");
const STATE = path.join(ROOT, "configs", "devnet.json");
const RPC = process.env.RPC ?? "https://api.devnet.solana.com";
const key = (name: string) => Keypair.fromSecretKey(Uint8Array.from(JSON.parse(fs.readFileSync(path.join(KEYS, `${name}.json`), "utf8"))));
const META = (name: string, symbol: string) => ({ name, symbol, uri: "https://cometail.fun/devnet/e2e.json" });
const CAP = new BN(1).shln(64).muln(1_000_000);
const policy = { maxSpendPerPeriod: new BN(5_000_000_000), periodSeconds: new BN(3600), maxOutstandingOrders: 4, maxBinsPerOrder: 20, maxPriceQ64: CAP };

async function finish(a: { connection: Connection; chain: Chain; client: VaultClientStep6; ctx: any; buyer: Keypair; vault: PublicKey; pair: PublicKey; plainCfg: PublicKey; streamCfgs: PublicKey[]; step: (name: string, data: Record<string, unknown>) => void }) {
  const { connection, chain, ctx, buyer, step, plainCfg, streamCfgs } = a;
  const cv = { vault: a.vault };
  const pair = { pair: a.pair };
  // the order record can lag a few seconds behind the confirmed route on the public RPC
  let records = await chain.orderRecords(cv.vault);
  for (let i = 0; i < 10 && records.length === 0; i++) { await new Promise((r) => setTimeout(r, 3000)); records = await chain.orderRecords(cv.vault); }
  expect(records.length).gte(1);
  let v = await chain.vault(cv.vault);
  const alreadySettled = v.accounting.burnedSt.gtn(0); // a resumed run that already sold and settled goes straight to the indexer
  // 7. the market crosses the bids: the buyer sells stream tokens into the pair; the keeper settles and burns
  if (!alreadySettled) {
  const before = await dlmmPair(connection, pair.pair);
  const order = await chain.limitOrder(records[0].account.limitOrder);
  const bidIds = (order?.bins ?? []).map((b) => b.id);
  const lowest = Math.min(...bidIds, before.activeId);
  const touched = Array.from({ length: before.activeId - lowest + 2 }, (_, i) => lowest - 1 + i);
  // sell enough stream token to cross the upper bins and part of the lowest one: 92% of the
  // ladder's WSOL at the current bin price (1.01^bin lamports per raw unit); the keeper's ladder
  // front-loads its nearest bid, so less than that fills only the first bin without crossing it;
  // selling past the ladder would make DLMM look for liquidity beyond its internal bitmap
  const ladderWsol = (order?.bins ?? []).reduce((acc, b) => acc + b.amount, 0n);
  const amountIn = new BN(Math.floor((Number(ladderWsol) * 0.92) / Math.pow(1.01, before.activeId)).toString());
  await send(connection, [await dlmmSwapIx(connection, { pair: pair.pair, user: buyer.publicKey, amountIn, binIds: touched })], [buyer], { cu: 800_000, label: "buyer sells stream tokens into the pair" });
  const after = await dlmmPair(connection, pair.pair);
  step("sell into the ladder", { activeBefore: before.activeId, activeAfter: after.activeId, bids: bidIds });
  await new Promise((r) => setTimeout(r, 4000));
  await keeperPass(ctx);
  v = await chain.vault(cv.vault);
  step("keeper pass 3", { burnedSt: v.accounting.burnedSt.toString(), refundedPrincipal: v.accounting.refundedPrincipal.toString(), orderFeesWsol: v.accounting.orderFeesWsol.toString(), outstanding: v.routing.outstandingOrders });
  expect(v.accounting.burnedSt.gtn(0)).true;
  }

  // 8. the indexer reads it all back
  const store = openStore(`sqlite:${path.join(ROOT, ".local", "e2e.sqlite")}`);
  await store.init();
  await new Indexer(chain, store).pass();
  await store.upsertSky(await scanSky(chain, [plainCfg, ...streamCfgs]));
  const events = await store.listEvents(cv.vault.toBase58(), 100);
  const sky = await store.listSky(50);
  const names = [...new Set(events.map((e) => e.name))];
  step("indexer", { events: names, skyStreams: sky.map((s) => `${s.baseMint.slice(0, 6)} ${s.progress} ${s.custody} eligible=${s.eligible}`) });
  expect(names).include.members(["launched", "live", "cashedOut", "harvested", "routed", "settled"]);
  await store.close();
}

describe("devnet end-to-end", () => {
  it("runs the whole lifecycle with the keeper and the indexer", async () => {
    const connection = new Connection(RPC, "confirmed");
    const authority = key("authority"), keeper = key("keeper"), depositor = key("depositor"), buyer = key("buyer");
    const client = new VaultClientStep6(connection);
    const chain = new Chain(connection);
    const state = JSON.parse(fs.readFileSync(STATE, "utf8"));
    const record: any = { startedAt: new Date().toISOString(), rpc: RPC, steps: [] as any[] };
    const save = () => fs.writeFileSync(path.join(ROOT, ".local", `e2e-${record.startedAt.replace(/[:.]/g, "-")}.json`), JSON.stringify(record, null, 2));
    const step = (name: string, data: Record<string, unknown>) => { record.steps.push({ name, ...data }); save(); log(name, data); };
    if (process.env.RESUME) {
      // continue a run that stopped after the ladder: addresses come from its record file
      const prior = JSON.parse(fs.readFileSync(process.env.RESUME, "utf8"));
      const find = (n: string) => prior.steps.find((x: any) => x.name === n);
      const vault = new PublicKey(find("vault").vault), pair = new PublicKey(find("pair").pair);
      const plainCfg = new PublicKey(find("configs").plain);
      const streamCfgs = [state.e2e["stream-25"], state.e2e["stream-50"], state.e2e["stream-75"]].map((k: string) => new PublicKey(k));
      const cfg: Config = { rpcUrl: RPC, mode: "once", migrateConfigs: [] as any, pollMs: 0, keeper, dustLamports: 100_000n, minRouteLamports: 5_000_000n, maxRouteLamports: 5_000_000_000n, ladderBins: 3, ladderNearBps: 200, ladderFarBps: 2000, ladderDecay: 0.85, staleOrderSeconds: 86_400, databaseUrl: null, apiPort: 0, skyConfigs: [], skyEveryPasses: 1, dryRun: false, cuPriceMicroLamports: 0 };
      record.resumedFrom = process.env.RESUME; record.steps = prior.steps;
      await finish({ connection, chain, client, ctx: { chain, cfg, keeper, luts: new LookupTables(connection, keeper, false) }, buyer, vault, pair, plainCfg, streamCfgs, step });
      record.finishedAt = new Date().toISOString(); save(); return;
    }

    // 0. small configs with the presets' economics, installed on the devnet protocol
    state.e2e = state.e2e ?? {};
    for (const name of ["plain", "stream-25", "stream-50", "stream-75"] as const) {
      if (state.e2e[name] && (await connection.getAccountInfo(new PublicKey(state.e2e[name])))) continue;
      const cfg = Keypair.generate();
      await send(connection, [await createConfigIx({ config: cfg.publicKey, feeClaimer: authority.publicKey, leftoverReceiver: authority.publicKey, payer: authority.publicKey, params: smallConfigParams(name) })], [authority, cfg], { label: `e2e config ${name}` });
      state.e2e[name] = cfg.publicKey.toBase58();
      fs.writeFileSync(STATE, JSON.stringify(state, null, 2) + "\n");
    }
    const plainCfg = new PublicKey(state.e2e["plain"]);
    const streamCfgs = [state.e2e["stream-25"], state.e2e["stream-50"], state.e2e["stream-75"]].map((k) => new PublicKey(k)) as [PublicKey, PublicKey, PublicKey];
    const proto = await chain.protocol();
    if (!proto.streamConfigs.every((c: PublicKey, i: number) => c.equals(streamCfgs[i]))) {
      await send(connection, [await client.updateProtocol({ admin: authority.publicKey, streamConfigs: streamCfgs })], [authority], { label: "update_protocol: small stream configs" });
    }
    const R: BN = (await dbcConfig(connection, plainCfg)).migrationQuoteThreshold;
    const R50: BN = (await dbcConfig(connection, streamCfgs[1])).migrationQuoteThreshold;
    step("configs", { plain: plainCfg.toBase58(), stream50: streamCfgs[1].toBase58(), thresholdLamports: R.toString(), stThresholdLamports: R50.toString() });

    // buyer: WSOL for everything below
    await send(connection, wrapSolIxs(buyer.publicKey, new BN(3_000_000_000)), [buyer], { label: "buyer wraps 3 SOL" });

    // 1. plain launch A, bonding
    const mintA = Keypair.generate();
    const A = await createPoolIx({ config: plainCfg, baseMint: mintA.publicKey, quoteMint: NATIVE_MINT, creator: depositor.publicKey, payer: depositor.publicKey, ...META("Comet A", "CMTA") });
    await send(connection, [A.ix], [depositor, mintA], { cu: 600_000, label: "plain launch A" });
    await send(connection, [ataIx(buyer.publicKey, mintA.publicKey, buyer.publicKey), await curveBuyIx({ config: plainCfg, baseMint: mintA.publicKey, buyer: buyer.publicKey, amountIn: R.muln(3).divn(10) })], [buyer], { cu: 400_000, label: "buyer buys A (30% of the curve)" });
    step("launch A", { mint: mintA.publicKey.toBase58(), pool: A.pool.toBase58() });

    // 2. plain launch B, filled and migrated: the depositor holds its creator position
    const mintB = Keypair.generate();
    const B = await createPoolIx({ config: plainCfg, baseMint: mintB.publicKey, quoteMint: NATIVE_MINT, creator: depositor.publicKey, payer: depositor.publicKey, ...META("Comet B", "CMTB") });
    await send(connection, [B.ix], [depositor, mintB], { cu: 600_000, label: "plain launch B" });
    await send(connection, [ataIx(buyer.publicKey, mintB.publicKey, buyer.publicKey), await curveBuyIx({ config: plainCfg, baseMint: mintB.publicKey, buyer: buyer.publicKey, amountIn: R.muln(6).divn(5) })], [buyer], { cu: 400_000, label: "buyer fills B" });
    const migB = await migrateToDammV2(connection, buyer, { config: plainCfg, baseMint: mintB.publicKey });
    const posB = (await positionOwnedBy(connection, migB.positions, depositor.publicKey))!;
    expect(posB).not.null;
    step("launch B", { mint: mintB.publicKey.toBase58(), pool: B.pool.toBase58(), dammPool: migB.pool.toBase58(), creatorPosition: posB.position.toBase58() });

    // 3. the vault: both tails in, the stream token launched on the 50% preset
    const stMint = Keypair.generate();
    const cv = await client.createVault({ depositor: depositor.publicKey, stMint: stMint.publicKey, policy });
    await send(connection, [cv.ix], [depositor, cv.placeholder, stMint], { label: "create_vault" });
    await send(connection, [await transferPoolCreatorIx(A.pool, plainCfg, depositor.publicKey, cv.vault), await client.depositDbcRights({ vault: cv.vault, depositor: depositor.publicKey, streamIndex: 0, dbcPool: A.pool, dbcConfig: plainCfg, baseMint: mintA.publicKey })], [depositor], { cu: 400_000, label: "deposit_dbc_rights A" });
    await send(connection, [await transferPoolCreatorIx(B.pool, plainCfg, depositor.publicKey, cv.vault), handPositionNftToVaultIx(posB.nftMint, depositor.publicKey, cv.vault), await client.depositDbcRightsMigrated({ vault: cv.vault, depositor: depositor.publicKey, streamIndex: 1, dbcPool: B.pool, dbcConfig: plainCfg, baseMint: mintB.publicKey, dammPool: migB.pool, creatorPosition: posB.position, creatorNftAccount: posB.nftAccount })], [depositor], { cu: 400_000, label: "deposit_dbc_rights_migrated B" });
    const L = await client.launch({ vault: cv.vault, depositor: depositor.publicKey, stMint: stMint.publicKey, config: streamCfgs[1], preset: 1, streamIndex: 2, metadata: META("Comet tail", "tCMT") });
    await send(connection, [L.ix], [depositor, stMint], { cu: 800_000, label: "launch (stream token)" });
    step("vault", { vault: cv.vault.toBase58(), stMint: stMint.publicKey.toBase58(), stPool: L.pool.toBase58(), incomeWsol: cv.incomeWsol.toBase58() });

    // 4. the stream token's curve fills; the keeper migrates it, registers the own position, cashes out, harvests
    await send(connection, [ataIx(buyer.publicKey, stMint.publicKey, buyer.publicKey), await curveBuyIx({ config: streamCfgs[1], baseMint: stMint.publicKey, buyer: buyer.publicKey, amountIn: R50.muln(6).divn(5) })], [buyer], { cu: 400_000, label: "buyer fills the stream token curve" });
    const cfg: Config = { rpcUrl: RPC, mode: "once", migrateConfigs: [] as any, pollMs: 0, keeper, dustLamports: 100_000n, minRouteLamports: 5_000_000n, maxRouteLamports: 5_000_000_000n, ladderBins: 3, ladderNearBps: 200, ladderFarBps: 2000, ladderDecay: 0.85, staleOrderSeconds: 86_400, databaseUrl: null, apiPort: 0, skyConfigs: [], skyEveryPasses: 1, dryRun: false, cuPriceMicroLamports: 0 };
    const ctx = { chain, cfg, keeper, luts: new LookupTables(connection, keeper, false) };
    await keeperPass(ctx);
    let v = await chain.vault(cv.vault);
    const d0 = await tokenBalance(connection, cv.depositorWsol);
    step("keeper pass 1", { status: Object.keys(v.status)[0], ownPosition: v.ownPosition.toBase58(), cashedOut: v.accounting.cashedOut.toString(), harvestedGross: v.accounting.harvestedGross.toString(), depositorWsol: d0.toString() });
    expect(Object.keys(v.status)[0]).eq("live");
    expect(v.accounting.cashedOut.gtn(0)).true;

    // 5. more trading on every stream, then the DLMM pair for the stream token
    await send(connection, [await curveBuyIx({ config: plainCfg, baseMint: mintA.publicKey, buyer: buyer.publicKey, amountIn: R.muln(2).divn(10) })], [buyer], { cu: 400_000, label: "buyer buys more A" });
    await send(connection, [await dammSwapIx(connection, { pool: migB.pool, payer: buyer.publicKey, inputMint: NATIVE_MINT, outputMint: mintB.publicKey, amountIn: new BN(200_000_000) })], [buyer], { cu: 400_000, label: "buyer swaps on B's DAMM v2 pool" });
    const stDamm = deriveDammV2PoolAddress(DAMM_V2_MIGRATION_CONFIG.customizable, stMint.publicKey, NATIVE_MINT);
    await send(connection, [await dammSwapIx(connection, { pool: stDamm, payer: buyer.publicKey, inputMint: NATIVE_MINT, outputMint: stMint.publicKey, amountIn: new BN(200_000_000) })], [buyer], { cu: 400_000, label: "buyer swaps on the stream token's DAMM v2 pool" });
    // the pair sits at the pool's price: price (lamports per raw unit) = (sqrt_price / 2^64)^2, bin = log(price) / log(1 + step/10000)
    const sp = BigInt((await dammPool(connection, stDamm)).sqrtPrice.toString());
    const price = (Number(sp) / 2 ** 64) ** 2;
    const activeId = Math.round(Math.log(price) / Math.log(1.01));
    const keeperSt = ata(stMint.publicKey, keeper.publicKey);
    await send(connection, [ataIx(buyer.publicKey, stMint.publicKey, keeper.publicKey), createTransferInstruction(ata(stMint.publicKey, buyer.publicKey), keeperSt, buyer.publicKey, BigInt(1_000_000))], [buyer], { label: "buyer hands the keeper a little stream token" });
    await send(connection, wrapSolIxs(keeper.publicKey, new BN(50_000_000)), [keeper], { label: "keeper wraps 0.05 SOL" });
    // the keeper creates and registers the pair itself on its first Live pass; this step only
    // fills in whatever it left out (an older keeper, or a pass that stopped early)
    const pair = await dlmm.initPairIx({ x: stMint.publicKey, y: NATIVE_MINT, funder: keeper.publicKey, userTokenX: keeperSt, userTokenY: ata(NATIVE_MINT, keeper.publicKey), binStep: 100, baseFactor: 1000, activeId });
    if (await connection.getAccountInfo(pair.pair)) log("DLMM pair exists (keeper-made)", { pair: pair.pair.toBase58() });
    else await send(connection, [pair.ix], [keeper], { cu: 400_000, label: "DLMM pair" });
    const liveActive = (await dlmmPair(connection, pair.pair)).activeId as number;
    const arrays = [...new Set([liveActive - 25, liveActive, liveActive + 25].map((b) => Math.floor(b / 70)))];
    for (const i of arrays) {
      const ix = await dlmm.initBinArrayIx(pair.pair, i, keeper.publicKey);
      const addr = ix.keys.find((k) => k.isWritable && !k.isSigner)?.pubkey;
      if (addr && (await connection.getAccountInfo(addr))) continue;
      await send(connection, [ix], [keeper], { cu: 1_400_000, label: `bin array ${i}` });
    }
    const vNow = client.decodeVault(Buffer.from((await connection.getAccountInfo(cv.vault))!.data));
    if (vNow.dlmmPair.equals(pair.pair)) log("register_pair done by the keeper");
    else await send(connection, [await client.registerPair({ vault: cv.vault, signer: keeper.publicKey, lbPair: pair.pair })], [keeper], { label: "register_pair" });
    const pairState = await dlmmPair(connection, pair.pair);
    step("pair", { pair: pair.pair.toBase58(), activeId, stIsX: pairState.tokenXMint.equals(stMint.publicKey), arrays });

    // 6. keeper pass 2: harvests with the splits, then the ladder
    await keeperPass(ctx);
    v = await chain.vault(cv.vault);
    const records = await chain.orderRecords(cv.vault);
    step("keeper pass 2", { harvestedGross: v.accounting.harvestedGross.toString(), income: v.accounting.income.toString(), toProtocol: v.accounting.toProtocol.toString(), toDepositor: v.accounting.toDepositor.toString(), routedGross: v.accounting.routedGross.toString(), outstanding: v.routing.outstandingOrders, orders: records.map((r) => r.account.limitOrder.toBase58()) });
    expect(v.accounting.harvestedGross.gtn(0)).true;
    expect(v.routing.outstandingOrders).gte(1);

    await finish({ connection, chain, client, ctx, buyer, vault: cv.vault, pair: pair.pair, plainCfg, streamCfgs, step });
    record.finishedAt = new Date().toISOString();
    save();
  });
});
