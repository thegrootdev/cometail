// COMETAIL worker: one binary, three modes.
//   keeper   loop: migrate, register, cash out, harvest, settle, route for every vault
//   indexer  loop: follow program events into the store, snapshot vault state, scan the Sky, serve the API
//   once     a single keeper pass (for scripts and the devnet end-to-end)
import { burnViewer, burnHistory, parseBurnCursor } from "./burnview";
import { burnIndexPass, chainDeps } from "./burnindex";
import { pairedBurnDeps, pairedBurnPass } from "./pairedburns";
import { BurnClient } from "@cometail/client";
import { Connection } from "@solana/web3.js";
import { Chain } from "./chain";
import { loadConfig } from "./config";
import { Indexer } from "./indexer";
import { startApi } from "./api";
import { scanSky } from "./sky";
import { type FeeIndex, openFeeIndexSoft } from "./feeindex";
import { feedFromTokens, publish, feedBus } from "./feed";
import { scanTokens } from "./tokens";
import { openStore } from "./store";
import { keeperPass } from "./keeper";
import { LookupTables } from "./lut";
import { log } from "./tx";
import { chainWalkDeps, refreshSources, reserveAddress, tailIndexPass, tailView } from "./tails";
import { statsViewer } from "./stats";

export const WORKER_VERSION = "0.1.0";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
let stopping = false;
process.on("SIGINT", () => { stopping = true; });
process.on("SIGTERM", () => { stopping = true; });

async function main() {
  const cfg = loadConfig();
  const chain = new Chain(new Connection(cfg.rpcUrl, "confirmed"));
  log(`cometail worker ${WORKER_VERSION}`, { mode: cfg.mode, rpc: new URL(cfg.rpcUrl).origin, dryRun: cfg.dryRun, keeper: cfg.keeper?.publicKey });

  if (cfg.mode === "indexer") {
    if (!cfg.databaseUrl) throw new Error("DATABASE_URL is required in indexer mode");
    const store = openStore(cfg.databaseUrl);
    await store.init();
    const indexer = new Indexer(chain, store);
    // the Fee Index runs on its own clock beside the indexer: a full walk can take minutes and must never hold up the trade index
    let feeIndex: FeeIndex | null = null;
    if (cfg.feeIndexDb) feeIndex = await openFeeIndexSoft(chain, store, cfg.feeIndexDb, { fullEveryHours: cfg.feeIndexFullHours, deltaEveryMinutes: cfg.feeIndexDeltaMinutes, pageDelayMs: 50, claimLookupsPerPass: 20, namesPerPass: 3000, imagesPerPass: 400, imagePassMs: 60_000, ourConfigs: cfg.skyConfigs.map((k) => k.toBase58()) });
    if (feeIndex) {
      void (async () => {
        while (!stopping) {
          try { await feeIndex!.pass(); } catch (e) { log("fee index pass failed", { error: String((e as Error).message ?? e) }); }
          if (process.env.COMETAIL_ONCE === "1") break;
          await sleep(cfg.feeIndexDeltaMinutes * 60_000);
        }
      })();
    }
    // exit status 2 = the API port is taken; the service unit does not restart on it
    const burnView = burnViewer(chain, store, { cluster: cfg.cluster, burnConfigs: cfg.burnConfigs.map((k) => k.toBase58()), legacyConfigs: cfg.migrateConfigs.map((k) => k.toBase58()).filter((k) => !cfg.burnConfigs.some((b) => b.toBase58() === k)), feeIndex });
    const tails = (mint: string | null) => tailView(store, cfg.tails, mint);
    // the $COMETAIL mint and the paired configs' fee claimer, once a config paired with $COMETAIL is among ours; and
    // $COMETAIL's identity (mint, pinned pool) from the burn program's state: undefined until read, then kept
    let pairedTarget: { mint: string; claimer: string; configs: string[] } | null | undefined;
    let cometailIdentity: { mint: string; pool: string } | null | undefined;
    const stats = statsViewer(chain, store, { cluster: cfg.cluster, team: cfg.demoActors, feeIndex, burnView, tailView: tails, pairedIdentity: () => cometailIdentity });
    const api = cfg.apiPort > 0 ? await startApi(store, { host: cfg.apiHost, port: cfg.apiPort, origins: cfg.apiOrigins, ratePerMinute: cfg.apiRatePerMinute, demoActors: cfg.demoActors, plainConfigs: cfg.migrateConfigs.map((k) => k.toBase58()), cluster: cfg.cluster , feeIndex, burnView, burnHistory: async (kind, before, limit) => { const c = parseBurnCursor(before); return c === "invalid" ? "invalid" : burnHistory(store, kind, c, limit); }, tailView: tails, stats, pairedMint: async () => pairedTarget?.mint ?? null }).catch((e) => { log("api refused to start", { error: String((e as Error).message ?? e) }); process.exit(2); }) : null;
    let passes = 0;
    while (!stopping) {
      let added = 0;
      try { added = await indexer.pass(); } catch (e) { log("indexer pass failed", { error: String((e as Error).message ?? e) }); }
      // the burn program's events: their own cursor, never fatal to the pass
      if (cfg.burnConfigs?.length) { try { await burnIndexPass(chainDeps(chain.connection), store); } catch (e) { log("burn index pass failed", { error: String((e as Error).message ?? e) }); } }
      // $COMETAIL burned with the paired configs' protocol claims: the burn program's $COMETAIL mint names the paired
      // configs among ours (their quote); the first one's fee claimer is the account walked; never fatal to the pass
      if (cfg.burnConfigs?.length) {
        try {
          // configs and the burn state's mint never change: looked up once, and again every 30 passes while none is found
          if (pairedTarget === undefined || (pairedTarget === null && passes % 30 === 0)) {
            const st = await chain.connection.getAccountInfo(new BurnClient(chain.connection).a.burnState, "confirmed");
            const decoded = st ? new BurnClient(chain.connection).decodeState(st.data) : null;
            cometailIdentity = decoded ? { mint: decoded.cometailMint.toBase58(), pool: decoded.pool.toBase58() } : null;
            const mint = decoded ? decoded.cometailMint.toBase58() : null;
            const found: { config: string; claimer: string }[] = [];
            for (const k of mint ? cfg.skyConfigs : []) { const c: any = await chain.dbcConfig(k); if (c && c.quoteMint.toBase58() === mint) found.push({ config: k.toBase58(), claimer: c.feeClaimer.toBase58() }); }
            const claimers = [...new Set(found.map((f) => f.claimer))];
            if (claimers.length > 1) log("paired configs name more than one fee claimer; walking the first", { claimers });
            // a DBC claim counts only under one of the walked claimer's own paired configs
            pairedTarget = mint && claimers.length ? { mint, claimer: claimers[0], configs: found.filter((f) => f.claimer === claimers[0]).map((f) => f.config) } : null;
          }
          if (pairedTarget) await pairedBurnPass(pairedBurnDeps(chain.connection), store, pairedTarget);
        } catch (e) { log("paired burn pass failed", { error: String((e as Error).message ?? e) }); }
      }
      // tail claims and the reserve ledger they are traced through: their own cursors, never fatal to the pass
      if (cfg.tails.length) { try { { const deps = chainWalkDeps(chain.connection); await tailIndexPass(deps, store, cfg.tails, reserveAddress(), (t) => refreshSources(chain, deps, store, t)); } } catch (e) { log("tail index pass failed", { error: String((e as Error).message ?? e) }); } }
      // the Sky refreshes on its schedule, and right away when new events change what it shows
      if (added > 0 || passes % cfg.skyEveryPasses === 0) {
        try {
          const rows = await scanSky(chain, cfg.skyConfigs, store); await store.upsertSky(rows); await store.pruneSky(rows.map((r) => r.pool));
          // the token rows behind /api/tokens follow the Sky's curve rows
          const tokens = await scanTokens(chain, rows, store, new Set(cfg.migrateConfigs.map((k) => k.toBase58())));
          const previous = new Map((await store.listTokens()).map((t) => [t.mint, t]));
          // the first scan of a fresh store announces nothing: every token would read as a launch.
          // The snapshot and the launch/graduation rows it implies commit together; the live push
          // follows the commit, so a crash in between leaves the rows in replay, never lost.
          const announced = previous.size > 0 || (await store.getMeta("tokens_scanned_at")) !== null ? feedFromTokens(previous, tokens, await chain.connection.getSlot("confirmed")) : [];
          for (const r of await store.upsertTokensAndFeed(tokens, tokens.map((t) => t.mint), announced)) feedBus.emit("event", r);
          log("token scan", { tokens: tokens.length, graduated: tokens.filter((t) => t.stage === "graduated").length });
        } catch (e) { log("sky scan failed", { error: String((e as Error).message ?? e) }); }
      }
      passes++;
      if (process.env.COMETAIL_ONCE === "1") break;
      await sleep(cfg.pollMs);
    }
    api?.close();
    feeIndex?.close();
    await store.close();
    return;
  }

  const ctx = { chain, cfg, keeper: cfg.keeper!, luts: new LookupTables(chain.connection, cfg.keeper!, cfg.dryRun) };
  if (cfg.mode === "once") { await keeperPass(ctx); return; }
  while (!stopping) {
    try { await keeperPass(ctx); } catch (e) { log("keeper pass failed", { error: String((e as Error).message ?? e) }); }
    await sleep(cfg.pollMs);
  }
}

main().catch((e) => { console.error(e); process.exit(1); });
