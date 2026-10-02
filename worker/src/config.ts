// Worker configuration, all from the environment. The keeper key is a bounded hot key: it can
// only call `route` and keeper-only `settle` on the program and pay rent for permissionless
// steps (migration, registration, harvests). It never holds vault funds.
import { Keypair } from "@solana/web3.js";
import fs from "fs";
import os from "os";
import path from "path";

export type Mode = "keeper" | "indexer" | "once";

export interface Config {
  rpcUrl: string;
  mode: Mode;
  pollMs: number;
  keeper: Keypair | null;
  /** Below this many lamports of gross income a harvest is not worth its fee. */
  dustLamports: bigint;
  /** Below this much idle income the keeper does not place a ladder. */
  minRouteLamports: bigint;
  /** Largest gross amount the keeper places in one ladder (the policy caps it again on-chain). */
  maxRouteLamports: bigint;
  ladderBins: number;
  ladderSpreadBps: number;
  ladderDecay: number;
  /** Resting bins older than this are cancelled so the income can be re-laddered near the market. */
  staleOrderSeconds: number;
  databaseUrl: string | null;
  dryRun: boolean;
  cuPriceMicroLamports: number;
}

function env(name: string, fallback?: string): string {
  const v = process.env[name];
  if (v !== undefined && v !== "") return v;
  if (fallback !== undefined) return fallback;
  throw new Error(`missing ${name}`);
}

function num(name: string, fallback: number): number {
  const v = Number(env(name, String(fallback)));
  if (!Number.isFinite(v)) throw new Error(`${name} is not a number`);
  return v;
}

export function loadKeypair(file: string): Keypair {
  const raw = JSON.parse(fs.readFileSync(file, "utf8")) as number[];
  return Keypair.fromSecretKey(Uint8Array.from(raw));
}

export function loadConfig(): Config {
  const mode = env("COMETAIL_MODE", "keeper") as Mode;
  if (!["keeper", "indexer", "once"].includes(mode)) throw new Error(`COMETAIL_MODE must be keeper, indexer or once (got ${mode})`);
  const keyPath = env("COMETAIL_KEEPER_KEYPAIR", path.join(os.homedir(), ".config", "cometail", "keeper.json"));
  const keeper = mode === "indexer" ? null : loadKeypair(keyPath);
  return {
    rpcUrl: env("COMETAIL_RPC_URL", "http://127.0.0.1:8899"),
    mode,
    pollMs: num("COMETAIL_POLL_MS", 15_000),
    keeper,
    dustLamports: BigInt(env("COMETAIL_DUST_LAMPORTS", "1000000")),
    minRouteLamports: BigInt(env("COMETAIL_MIN_ROUTE_LAMPORTS", "10000000")),
    maxRouteLamports: BigInt(env("COMETAIL_MAX_ROUTE_LAMPORTS", "5000000000")),
    ladderBins: Math.max(1, Math.min(50, num("COMETAIL_LADDER_BINS", 5))),
    ladderSpreadBps: num("COMETAIL_LADDER_SPREAD_BPS", 500),
    ladderDecay: num("COMETAIL_LADDER_DECAY", 0.85),
    staleOrderSeconds: num("COMETAIL_STALE_ORDER_SECONDS", 86_400),
    databaseUrl: process.env.DATABASE_URL || null,
    dryRun: env("COMETAIL_DRY_RUN", "0") === "1",
    cuPriceMicroLamports: num("COMETAIL_CU_PRICE", 0),
  };
}
