// COMETAIL worker: one binary, three modes.
//   keeper   loop: migrate, register, cash out, harvest, settle, route for every vault
//   indexer  loop: follow program events into Postgres and snapshot vault state
//   once     a single keeper pass (for scripts and the devnet end-to-end)
import { Connection } from "@solana/web3.js";
import { Chain } from "./chain";
import { loadConfig } from "./config";
import { Indexer } from "./indexer";
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
    const indexer = new Indexer(chain, cfg.databaseUrl);
    await indexer.init();
    while (!stopping) {
      try { await indexer.pass(); } catch (e) { log("indexer pass failed", { error: String((e as Error).message ?? e) }); }
      await sleep(cfg.pollMs);
    }
    await indexer.close();
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
