// Devnet end-to-end for coins paired with $COMETAIL, with the site's own builders and the worker's own modules:
//   1. a paired config on devnet: configs/paired.json at devnet scale (the market caps divided so the raise is about
//      0.08 SOL of the stand-in $COMETAIL), quote = the burn program's stand-in $COMETAIL, fee claimer the authority;
//   2. a launch with a first buy paid in SOL, as the launch page does it (buy the $COMETAIL, then create + first buy);
//   3. a SOL buy, a sale to SOL and a sale keeping $COMETAIL (web/src/lib/paired.ts), each one transaction;
//   4. the curve filled with SOL buys; the worker's keeper pass migrates it (the config in its migrate list) into a
//      coin/$COMETAIL DAMM v2 pool; a buy and a sale there;
//   5. the creator's fees claimed in $COMETAIL; the protocol's claims found by the /admin/fees scan and each built with
//      its burn (web/src/lib/protocol-fees.ts): supply falls by exactly the burned half;
//   6. the worker's indexer, token scan, paired burn walk, /api/stats and /api/tokens read it back: the paired volume
//      valued in SOL, the routed legs, the burned counter equal to the supply drop, the coin priced in SOL and dollars.
// Devnet only. Record: .local/e2e-paired-<time>.json.
//   cd tests && RPC=<devnet rpc> ./node_modules/.bin/ts-mocha --exit -p ./tsconfig.json -t 3000000 devnet/e2e-paired.ts
import { BN } from "@coral-xyz/anchor";
import { Connection, Keypair, PublicKey, SystemProgram, Transaction } from "@solana/web3.js";
import { buildCurveWithMarketCap } from "@meteora-ag/dynamic-bonding-curve-sdk";
import { expect } from "chai";
import fs from "fs";
import path from "path";
import { BurnClient } from "@cometail/client";
import { Chain } from "../../worker/src/chain";
import { keeperPass } from "../../worker/src/keeper";
import { LookupTables } from "../../worker/src/lut";
import { openStore } from "../../worker/src/store";
import { Indexer } from "../../worker/src/indexer";
import { scanSky } from "../../worker/src/sky";
import { scanTokens } from "../../worker/src/tokens";
import { burnViewer } from "../../worker/src/burnview";
import { burnIndexPass, chainDeps } from "../../worker/src/burnindex";
import { pairedBurnDeps, pairedBurnPass } from "../../worker/src/pairedburns";
import { statsViewer } from "../../worker/src/stats";
import { startApi } from "../../worker/src/api";
import type { Config } from "../../worker/src/config";
import { normalize } from "../harness/dbc";
import { dammProgram, dbcProgram } from "../harness/programs";
import { ata, dbcPool, log, send, tokenBalance, DAMM_V2_MIGRATION_CONFIG, deriveDammV2PoolAddress } from "./rpc";

const ROOT = path.resolve(__dirname, "..", "..");
const KEYS = path.join(ROOT, "keys", "devnet");
const RPC = process.env.RPC ?? "https://api.devnet.solana.com";
const key = (name: string) => Keypair.fromSecretKey(Uint8Array.from(JSON.parse(fs.readFileSync(path.join(KEYS, `${name}.json`), "utf8"))));
/** The stand-in $COMETAIL's own launch config (e2e-burn), so the indexer follows its pool and can price the paired trades. */
const STANDIN_CONFIG = new PublicKey(process.env.STANDIN_CONFIG ?? "F87hyo6jEE1GHdUKhW3ay4g2VfrkcZwaRatSufKS1fp");
const supplyOf = async (c: Connection, mint: PublicKey) => BigInt((await c.getTokenSupply(mint, "confirmed")).value.amount);
const bal = async (c: Connection, a: PublicKey) => BigInt((await tokenBalance(c, a).catch(() => new BN(0))).toString());

describe("devnet: coins paired with $COMETAIL", () => {
  it("launch, trade with SOL, graduate, claim and burn, and read it all back through the worker", async () => {
    const connection = new Connection(RPC, "confirmed");
    if ((await connection.getGenesisHash()) !== "EtWTRABZaYq6iMfeYKouRu166VU2xqa1wcaWoxPkrZBG") throw new Error("not devnet");
    const authority = key("authority"), keeper = key("keeper"), buyer = key("buyer");
    const chain = new Chain(connection);
    const record: any = { startedAt: new Date().toISOString(), rpc: RPC.replace(/api-key=[^&]+/, "api-key=…"), steps: [] };
    const out = path.join(ROOT, ".local", `e2e-paired-${record.startedAt.replace(/[:.]/g, "-")}.json`);
    const step = (name: string, data: Record<string, unknown>) => { record.steps.push({ name, ...data }); fs.writeFileSync(out, JSON.stringify(record, null, 2)); log(name, data); };

    // the stand-in $COMETAIL and its pool, as the burn program pinned them
    const burnClient = new BurnClient(connection);
    const st = burnClient.decodeState((await connection.getAccountInfo(burnClient.a.burnState))!.data);
    const mint = st.cometailMint, pool = st.pool;
    step("stand-in $COMETAIL", { mint: mint.toBase58(), pool: pool.toBase58() });

    // 1. the paired config at devnet scale (PAIRED_CONFIG=<address> reuses one)
    let config: PublicKey;
    if (process.env.PAIRED_CONFIG) config = new PublicKey(process.env.PAIRED_CONFIG);
    else {
      const p = JSON.parse(fs.readFileSync(path.join(ROOT, "configs", "paired.json"), "utf8"));
      const { curve: _c, quote: _q, name: _n, ...file } = p;
      const params = normalize(buildCurveWithMarketCap({ ...file, initialMarketCap: 12_000_000, migrationMarketCap: 70_000_000 }));
      const kp = Keypair.generate();
      const ix = await dbcProgram.methods.createConfig(params).accountsPartial({ config: kp.publicKey, feeClaimer: authority.publicKey, leftoverReceiver: authority.publicKey, quoteMint: mint, payer: authority.publicKey, systemProgram: SystemProgram.programId }).instruction();
      await send(connection, [ix], [authority, kp], { label: "paired config (devnet scale)" });
      config = kp.publicKey;
    }
    const cfg: any = await chain.dbcConfig(config);
    expect(cfg.quoteMint.toBase58()).eq(mint.toBase58());
    step("paired config", { config: config.toBase58(), thresholdRaw: cfg.migrationQuoteThreshold.toString() });

    // the site's modules, configured for this devnet deployment
    process.env.NEXT_PUBLIC_CLUSTER = "devnet"; process.env.NEXT_PUBLIC_RPC_URL = RPC;
    process.env.NEXT_PUBLIC_OFFICIAL_MINT = mint.toBase58(); process.env.NEXT_PUBLIC_COMETAIL_POOL = pool.toBase58(); process.env.NEXT_PUBLIC_PAIRED_CONFIG = config.toBase58();
    const paired = await import("../../web/src/lib/paired");
    const fees = await import("../../web/src/lib/protocol-fees");
    const dbcLib = await import("../../web/src/lib/dbc");
    const sendIxs = (ixs: any[], signers: Keypair[], label: string, cu = 400_000) => send(connection, ixs, signers, { cu, label });
    const supply0 = await supplyOf(connection, mint);

    // 2. a launch with a first buy paid in SOL: the $COMETAIL first, then the coin created with exactly that buy
    const coin = Keypair.generate();
    const authorityCometail = await bal(connection, ata(mint, authority.publicKey));
    const first = await paired.cometailForSol(connection, authority.publicKey, new BN(5_000_000));
    const s1 = await sendIxs(first.instructions, [authority], "launch 1/2: SOL -> $COMETAIL", 300_000);
    const launch = await dbcLib.launchTx(connection, { payer: authority.publicKey, baseMint: coin.publicKey, name: "Paired devnet", symbol: "PAIRD", uri: "https://cometail.fun/devnet/e2e.json", firstBuyRaw: first.cometail, config, quoteMint: mint, quoteDecimals: 6 });
    const s2 = await sendIxs(launch.instructions, [authority, coin], "launch 2/2: create + first buy", 800_000);
    const { deriveDbcPoolAddress } = await import("@meteora-ag/dynamic-bonding-curve-sdk");
    const dbcPk = deriveDbcPoolAddress(mint, coin.publicKey, config);
    expect(await bal(connection, ata(mint, authority.publicKey))).eq(authorityCometail);
    step("launch", { mint: coin.publicKey.toBase58(), pool: dbcPk.toBase58(), swap: s1, create: s2, firstBuyCometail: first.cometail.toString() });

    const curve = async () => ({ kind: "curve" as const, view: (await dbcLib.loadPool(connection, dbcPk))! });
    // 3. a SOL buy, a sale to SOL, a sale keeping $COMETAIL
    // the buyer may hold stand-in $COMETAIL from earlier runs: a buy leaves its balance exactly as it was
    const cometailBefore = await bal(connection, ata(mint, buyer.publicKey));
    const buy = await paired.pairedBuy(connection, buyer.publicKey, await curve(), new BN(10_000_000));
    const sb = await sendIxs(buy.instructions, [buyer], "buy with SOL");
    const held = await bal(connection, ata(coin.publicKey, buyer.publicKey));
    expect(held >= BigInt(buy.coinMinOut!.toString())).eq(true);
    expect(await bal(connection, ata(mint, buyer.publicKey))).eq(cometailBefore);
    const sell = await paired.pairedSell(connection, buyer.publicKey, await curve(), new BN((held / 4n).toString()), true);
    const ss = await sendIxs(sell.instructions, [buyer], "sell to SOL");
    const keepBefore = await bal(connection, ata(mint, buyer.publicKey));
    const keep = await paired.pairedSell(connection, buyer.publicKey, await curve(), new BN((held / 4n).toString()), false);
    const sk = await sendIxs(keep.instructions, [buyer], "sell keeping $COMETAIL");
    expect(await bal(connection, ata(mint, buyer.publicKey)) - keepBefore).eq(BigInt(keep.cometailOut!.toString()));
    step("trades on the curve", { buy: sb, sellToSol: ss, sellKeep: sk, keptMargin: (keepBefore - cometailBefore).toString() });

    // 4. fill with SOL buys, then the keeper's pass migrates the paired curve
    for (let i = 0; i < 12 && Number((await dbcPool(connection, dbcPk)).migrationProgress) === 0; i++) {
      const plan = await paired.pairedBuy(connection, buyer.publicKey, await curve(), new BN(25_000_000));
      await sendIxs(plan.instructions, [buyer], `fill ${i + 1}`);
    }
    expect(Number((await dbcPool(connection, dbcPk)).migrationProgress)).gt(0);
    const kcfg = { rpcUrl: RPC, mode: "once", migrateConfigs: [config], burnConfigs: [], burnMinClaimLamports: 10_000n, pollMs: 0, keeper, dustLamports: 100_000n, minRouteLamports: 5_000_000n, maxRouteLamports: 5_000_000_000n, ladderBins: 3, ladderNearBps: 200, ladderFarBps: 2000, ladderDecay: 0.85, staleOrderSeconds: 86_400, databaseUrl: null, apiPort: 0, skyConfigs: [], skyEveryPasses: 1, dryRun: false, cuPriceMicroLamports: 0 } as unknown as Config;
    const dammPk = deriveDammV2PoolAddress(DAMM_V2_MIGRATION_CONFIG.customizable, coin.publicKey, mint);
    for (let i = 0; i < 4 && !(await connection.getAccountInfo(dammPk)); i++) await keeperPass({ chain, cfg: kcfg, keeper, luts: new LookupTables(connection, keeper, false) } as any);
    const dp: any = dammProgram.coder.accounts.decode("pool", (await connection.getAccountInfo(dammPk))!.data);
    expect(dp.tokenBMint.toBase58()).eq(mint.toBase58());
    step("graduated", { dammPool: dammPk.toBase58(), tokenB: dp.tokenBMint.toBase58(), lockedLiquidity: dp.permanentLockLiquidity.toString(), liquidity: dp.liquidity.toString() });
    const venue = { kind: "damm" as const, pool: dammPk, baseMint: coin.publicKey, baseDecimals: 6 };
    const gb = await sendIxs((await paired.pairedBuy(connection, buyer.publicKey, venue, new BN(10_000_000))).instructions, [buyer], "buy on the graduated pool");
    const gheld = await bal(connection, ata(coin.publicKey, buyer.publicKey));
    const gs = await sendIxs((await paired.pairedSell(connection, buyer.publicKey, venue, new BN((gheld / 10n).toString()), true)).instructions, [buyer], "sell to SOL on the graduated pool");
    step("trades on the pool", { buy: gb, sell: gs });

    // 5. the creator's fees in $COMETAIL; the protocol's claims, each with its burn
    const creatorTx = await dbcLib.claimCreatorFeesTx(connection, dbcPk, authority.publicKey);
    const cBefore = await bal(connection, ata(mint, authority.publicKey));
    const sc = await sendIxs(creatorTx.instructions, [authority], "creator claims in $COMETAIL");
    step("creator fees", { signature: sc, cometailRaw: ((await bal(connection, ata(mint, authority.publicKey))) - cBefore).toString() });
    const scan = await fees.scanProtocolClaims(connection);
    const ours = scan.claims.filter((c) => c.quoteMint.equals(mint) && (c.pool.equals(dbcPk) || c.pool.equals(dammPk)) && c.claimer.equals(authority.publicKey));
    expect(ours.some((c) => c.kind === "dbc-partner-fee")).eq(true);
    let burned = 0n;
    for (const claim of ours) {
      const supplyBefore = await supplyOf(connection, mint);
      let built: Awaited<ReturnType<typeof fees.buildPairedClaim>>;
      try { built = await fees.buildPairedClaim(connection, claim, scan.burn); }
      catch (e) { step("protocol claim skipped", { kind: claim.kind, reason: String((e as Error).message) }); continue; }
      const treasuryBefore = await bal(connection, ata(mint, authority.publicKey));
      const sig = await sendIxs(built.instructions, [authority, ...built.signers], `protocol claim + burn (${claim.kind})`, 300_000);
      const drop = supplyBefore - (await supplyOf(connection, mint));
      expect(drop).eq(built.pairedBurn.burned);
      expect((await bal(connection, ata(mint, authority.publicKey))) - treasuryBefore).eq(built.pairedBurn.kept);
      burned += drop;
      // the same transaction again (fresh blockhash): the claim pays nothing now, so it fails whole and burns nothing
      const s2 = await supplyOf(connection, mint), t2 = await bal(connection, ata(mint, authority.publicKey));
      let replay = "landed";
      try { await sendIxs(built.instructions, [authority, ...built.signers], `replay of the ${claim.kind} claim (must fail)`, 300_000); } catch (e) { replay = `failed: ${String((e as Error).message).slice(0, 120)}`; }
      expect(replay.startsWith("failed"), "a replayed claim fails").eq(true);
      expect([await supplyOf(connection, mint), await bal(connection, ata(mint, authority.publicKey))]).to.deep.eq([s2, t2]);
      step("protocol claim", { kind: claim.kind, signature: sig, claimed: built.pairedBurn.claimed.toString(), burned: built.pairedBurn.burned.toString(), kept: built.pairedBurn.kept.toString(), exact: built.pairedBurn.exact, replay });
    }

    // 6. the worker reads it back
    const store = openStore(`sqlite:${path.join(ROOT, ".local", `e2e-paired-store-${Date.now()}.sqlite`)}`); await store.init();
    const rows = await scanSky(chain, [STANDIN_CONFIG, config], store); await store.upsertSky(rows);
    await store.upsertTokens(await scanTokens(chain, rows, store, new Set([config.toBase58()])));
    const indexer = new Indexer(chain, store);
    for (let i = 0; i < 30; i++) { await indexer.pass(); const cs = await store.listPoolCursors(); if (cs.length && cs.every((c) => c.cursor.status === "ok")) break; }
    await store.upsertTokens(await scanTokens(chain, await scanSky(chain, [STANDIN_CONFIG, config], store), store, new Set([config.toBase58()])));
    await store.setMeta("tokens_scanned_at", String(Date.now()));
    await burnIndexPass(chainDeps(connection), store);
    await pairedBurnPass(pairedBurnDeps(connection), store, { mint: mint.toBase58(), claimer: authority.publicKey.toBase58() });
    const burnView = burnViewer(chain, store, { cluster: "devnet", burnConfigs: [], legacyConfigs: [], feeIndex: null });
    const stats: any = await statsViewer(chain, store, { cluster: "devnet", team: [authority.publicKey.toBase58()], feeIndex: null, burnView, tailView: null })();
    const launch2 = stats.launches.list.find((l: any) => l.mint === coin.publicKey.toBase58());
    step("stats", { trading: stats.trading, launch: { volumeLamports: launch2?.volumeLamports, volumeSolLamports: launch2?.volumeSolLamports, paired: launch2?.paired, fees: launch2?.fees, lockedBps: launch2?.lockedBps }, pairedQuote: stats.pairedQuote, feesPaired: stats.fees.paired });
    expect(launch2.paired).eq(true);
    expect(launch2.volumeSolLamports, "the paired volume is valued in SOL").not.eq(null);
    expect(BigInt(stats.trading.pairedRoutedLamports) > 0n).eq(true);
    expect(stats.pairedQuote.burned.complete).eq(true);
    // every burn this run made is counted (earlier runs on this account count too)
    expect(BigInt(stats.pairedQuote.burned.burnedRaw) >= burned).eq(true);
    expect(supply0 - (await supplyOf(connection, mint)) >= burned).eq(true);
    // /api/tokens prices the coin in SOL and dollars
    const port = 18000 + Math.floor(Math.random() * 1000);
    const api = await startApi(store, { host: "127.0.0.1", port, origins: ["*"], ratePerMinute: 1000, cluster: "devnet", pairedMint: async () => mint.toBase58() } as any);
    const t = await (await fetch(`http://127.0.0.1:${port}/api/tokens/${coin.publicKey.toBase58()}`)).json();
    step("api token", { market: t.data.market });
    expect(t.data.market.quoteUsd.sol).gt(0);
    (api as any)?.close?.();
    fs.writeFileSync(out, JSON.stringify(record, null, 2));
  });
});
