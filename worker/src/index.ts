// COMETAIL worker: one binary, three modes.
//   keeper   loop: migrate, register, cash out, harvest, settle, route for every vault
//   indexer  loop: follow program events into the store, snapshot vault state, scan the Sky, serve the API
//   once     a single keeper pass (for scripts and the devnet end-to-end)
import { Connection } from "@solana/web3.js";
import { Chain } from "./chain";
import { loadConfig } from "./config";
import { Indexer } from "./indexer";
import { startApi } from "./api";
import { scanSky } from "./sky";
import { feedFromTokens, publish } from "./feed";
import { scanTokens } from "./tokens";
import { openStore } from "./store";
import { keeperPass } from "./keeper";
import { LookupTables } from "./lut";
import { log } from "./tx";

export const WORKER_VERSION = "0.1.0";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
let stopping = false;
process.on("SIGINT", () => { stopping = true; });
process.on("SIGTERM", () => { stopping = true; });

async function main() {
  const cfg = loadConfig();
  const chain = new Chain(new Connection(cfg.rpcUrl, "confirmed"));
  log(`cometail worker ${WORKER_VERSION}`, { mode: cfg.mode, rpc: cfg.rpcUrl, dryRun: cfg.dryRun, keeper: cfg.keeper?.publicKey });

  if (cfg.mode === "indexer") {
    if (!cfg.databaseUrl) throw new Error("DATABASE_URL is required in indexer mode");
    const store = openStore(cfg.databaseUrl);
    await store.init();
    const indexer = new Indexer(chain, store);
    // exit status 2 = the API port is taken; the service unit does not restart on it
    const api = cfg.apiPort > 0 ? await startApi(store, { host: cfg.apiHost, port: cfg.apiPort, origins: cfg.apiOrigins, ratePerMinute: cfg.apiRatePerMinute, demoActors: cfg.demoActors, plainConfigs: cfg.migrateConfigs.map((k) => k.toBase58()), cluster: cfg.cluster }).catch((e) => { log("api refused to start", { error: String((e as Error).message ?? e) }); process.exit(2); }) : null;
    let passes = 0;
    while (!stopping) {
      let added = 0;
      try { added = await indexer.pass(); } catch (e) { log("indexer pass failed", { error: String((e as Error).message ?? e) }); }
      // the Sky refreshes on its schedule, and right away when new events change what it shows
      if (added > 0 || passes % cfg.skyEveryPasses === 0) {
        try {
          const rows = await scanSky(chain, cfg.skyConfigs, store); await store.upsertSky(rows); await store.pruneSky(rows.map((r) => r.pool));
          // the token rows behind /api/tokens follow the Sky's curve rows
          const tokens = await scanTokens(chain, rows, store, new Set(cfg.migrateConfigs.map((k) => k.toBase58())));
          const previous = new Map((await store.listTokens()).map((t) => [t.mint, t]));
          await store.upsertTokens(tokens); await store.pruneTokens(tokens.map((t) => t.mint));
          // the first scan of a fresh store announces nothing: every token would read as a launch
          if (previous.size > 0) await publish(store, feedFromTokens(previous, tokens, (await store.observedSlot()) ?? 0));
          await store.setMeta("tokens_scanned_at", String(Date.now()));
          log("token scan", { tokens: tokens.length, graduated: tokens.filter((t) => t.stage === "graduated").length });
        } catch (e) { log("sky scan failed", { error: String((e as Error).message ?? e) }); }
      }
      passes++;
      if (process.env.COMETAIL_ONCE === "1") break;
      await sleep(cfg.pollMs);
    }
    api?.close();
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
