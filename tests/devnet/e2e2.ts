// Devnet end-to-end, second vault (PLAN step 11): a tail from a plain launch deposited as a
// standalone position stream, with the keeper and the indexer running as the real worker
// processes (keeper loop, indexer loop with the API) rather than in-process passes, and the
// trades going through the app's own transaction helpers. The script only waits and checks.
//   cd tests && RPC=https://api.devnet.solana.com ./node_modules/.bin/ts-mocha --exit -p ./tsconfig.json -t 2000000 devnet/e2e2.ts
import { BN } from "@coral-xyz/anchor";
import { spawn, ChildProcess } from "child_process";
import { Connection, Keypair, PublicKey, Transaction } from "@solana/web3.js";
import { expect } from "chai";
import fs from "fs";
import path from "path";
import { VaultClientStep6, handPositionNftToVaultIx } from "@cometail/client";
import { createPoolIx } from "../harness/dbc";
import { Chain } from "../../worker/src/chain";
import { curveSwapTx, loadPool, curveQuote } from "../../web/src/lib/dbc";
import { dammSwapTx } from "../../web/src/lib/damm";
import { NATIVE_MINT, ata, ataIx, curveBuyIx, dbcConfig, dbcPool, derivePositionNftAccount, dlmmPair, dlmmSwapIx, deriveDammV2PoolAddress, DAMM_V2_MIGRATION_CONFIG, log, positionOwnedBy, send, tokenBalance, wrapSolIxs } from "./rpc";
import { dammPosition, retry } from "./rpc";

const ROOT = path.resolve(__dirname, "..", "..");
const KEYS = path.join(ROOT, "keys", "devnet");
const STATE = path.join(ROOT, "configs", "devnet.json");
const RPC = process.env.RPC ?? "https://api.devnet.solana.com";
const API = 8788;
const key = (name: string) => Keypair.fromSecretKey(Uint8Array.from(JSON.parse(fs.readFileSync(path.join(KEYS, `${name}.json`), "utf8"))));
const META = (name: string, symbol: string) => ({ name, symbol, uri: "https://cometail.fun/devnet/e2e.json" });
const policy = { maxSpendPerPeriod: new BN(5_000_000_000), periodSeconds: new BN(3600), maxOutstandingOrders: 4, maxBinsPerOrder: 20, maxPriceQ64: new BN(1).shln(64).muln(1_000_000) };
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Poll until `check` returns a value (or time runs out). */
async function waitFor<T>(what: string, check: () => Promise<T | null | undefined | false>, timeoutMs = 300_000, everyMs = 8_000): Promise<T> {
  const until = Date.now() + timeoutMs;
  for (;;) {
    const v = await check().catch(() => null);
    if (v) { log(`ready: ${what}`); return v as T; }
    if (Date.now() > until) throw new Error(`timed out waiting for ${what}`);
    await sleep(everyMs);
  }
}
function worker(mode: "keeper" | "indexer", env: Record<string, string>): ChildProcess {
  const p = spawn(path.join(ROOT, "worker", "node_modules", ".bin", "tsx"), ["src/index.ts"], { cwd: path.join(ROOT, "worker"), env: { ...process.env, COMETAIL_MODE: mode, COMETAIL_RPC_URL: RPC, COMETAIL_KEEPER_KEYPAIR: path.join(KEYS, "keeper.json"), COMETAIL_POLL_MS: "10000", ...env }, stdio: ["ignore", "pipe", "pipe"] });
  p.stdout?.on("data", (d) => process.stdout.write(`[${mode}] ${d}`));
  p.stderr?.on("data", (d) => { const s = String(d); if (!/429|ws error|Warning|trace-warnings/.test(s)) process.stderr.write(`[${mode}] ${s}`); });
  return p;
}
/** Sign a transaction built by the app's helpers with a keypair and send it. */
async function sendApp(connection: Connection, tx: Transaction, signers: Keypair[], label: string) {
  return send(connection, tx.instructions, signers, { cu: 400_000, label });
}

describe("devnet end-to-end, second vault", () => {
  it("deposits a standalone position stream and lets the worker processes take it through its first fill", async () => {
    const connection = new Connection(RPC, "confirmed");
    const depositor = key("depositor"), buyer = key("buyer"), keeper = key("keeper");
    const client = new VaultClientStep6(connection);
    const chain = new Chain(connection);
    const state = JSON.parse(fs.readFileSync(STATE, "utf8"));
    const plainCfg = new PublicKey(state.e2e["plain"]);
    const streamCfgs = [state.e2e["stream-25"], state.e2e["stream-50"], state.e2e["stream-75"]].map((k: string) => new PublicKey(k));
    const record: any = { startedAt: new Date().toISOString(), rpc: RPC, steps: [] as any[] };
    const file = path.join(ROOT, ".local", `e2e2-${record.startedAt.replace(/[:.]/g, "-")}.json`);
    const step = (name: string, data: Record<string, unknown>) => { record.steps.push({ name, ...data }); fs.writeFileSync(file, JSON.stringify(record, null, 2)); log(name, data); };
    const dbFile = path.join(ROOT, ".local", "e2e2.sqlite");
    const procs: ChildProcess[] = [];
    try {
      // the worker, as deployed: keeper loop and indexer loop with the API
      // devnet scope: half-SOL curves, so the routing threshold is 0.001 SOL here instead of the planned 0.1 SOL
      procs.push(worker("keeper", { COMETAIL_MIGRATE_CONFIGS: plainCfg.toBase58(), COMETAIL_DUST_LAMPORTS: "100000", COMETAIL_MIN_ROUTE_LAMPORTS: "1000000", COMETAIL_LADDER_BINS: "3", COMETAIL_LADDER_FAR_BPS: "6000" }));
      procs.push(worker("indexer", { DATABASE_URL: `sqlite:${dbFile}`, COMETAIL_API_PORT: String(API), COMETAIL_API_RATE_PER_MINUTE: "6000", COMETAIL_SKY_CONFIGS: [plainCfg, ...streamCfgs].map((k) => k.toBase58()).join(","), COMETAIL_SKY_EVERY_PASSES: "3", COMETAIL_POLL_MS: "20000" }));
      await waitFor("api", async () => (await fetch(`http://127.0.0.1:${API}/api/health`)).ok, 60_000, 2_000);

      let resumed: { vault: PublicKey; stMint: PublicKey; pair: PublicKey; mintC: PublicKey; dammC: PublicKey } | null = null;
      if (process.env.RESUME2) {
        const prior = JSON.parse(fs.readFileSync(process.env.RESUME2, "utf8"));
        const find = (n: string) => prior.steps.find((x: any) => x.name === n);
        resumed = { vault: new PublicKey(find("vault 2").vault), stMint: new PublicKey(find("vault 2").stMint), pair: new PublicKey(find("vault 2 live").pair), mintC: new PublicKey(find("launch C").mint), dammC: new PublicKey(find("launch C").dammPool) };
        record.resumedFrom = process.env.RESUME2; record.steps = prior.steps;
      }
      const R: BN = (await dbcConfig(connection, plainCfg)).migrationQuoteThreshold;
      const R25: BN = (await dbcConfig(connection, streamCfgs[0])).migrationQuoteThreshold;
      const haveWsol = await tokenBalance(connection, ata(NATIVE_MINT, buyer.publicKey));
      if (haveWsol.lt(new BN(2_000_000_000))) await send(connection, wrapSolIxs(buyer.publicKey, new BN(2_500_000_000).sub(haveWsol)), [buyer], { label: "buyer tops WSOL up to 2.5 SOL" });

      // 1. plain launch C; the buyer fills it through the app's curve helper; the keeper loop migrates it
      let mintCKey = resumed?.mintC ?? PublicKey.default, dammC = resumed?.dammC ?? PublicKey.default;
      let vaultKey = resumed?.vault ?? PublicKey.default, stMintKey = resumed?.stMint ?? PublicKey.default;
      if (!resumed) {
      const mintC = Keypair.generate();
      const C = await createPoolIx({ config: plainCfg, baseMint: mintC.publicKey, quoteMint: NATIVE_MINT, creator: depositor.publicKey, payer: depositor.publicKey, ...META("Comet C", "CMTC") });
      await send(connection, [C.ix], [depositor, mintC], { cu: 600_000, label: "plain launch C" });
      const viewC = (await retry("loadPool C", () => loadPool(connection, C.pool)))!;
      const quote: any = await retry("quote C", () => curveQuote(connection, viewC, R.muln(6).divn(5), false));
      await sendApp(connection, await retry("swap tx C", () => curveSwapTx(connection, C.pool, buyer.publicKey, R.muln(6).divn(5), quote.minimumAmountOut, false)), [buyer], "buyer fills C through the app helper");
      const migratedC = await waitFor("keeper migrates C", async () => { const p = await dbcPool(connection, C.pool); return Number(p.migrationProgress) === 3 ? p : null; });
      dammC = deriveDammV2PoolAddress(DAMM_V2_MIGRATION_CONFIG.customizable, mintC.publicKey, NATIVE_MINT);
      mintCKey = mintC.publicKey;
      // the migration's two positions: find the depositor's through the pool's positions (no keypairs here: the keeper made them)
      const posC = await waitFor("creator position of C", async () => (await chain.positionsOwnedBy(dammC, depositor.publicKey))[0] ?? null, 120_000);
      step("launch C", { mint: mintC.publicKey.toBase58(), pool: C.pool.toBase58(), dammPool: dammC.toBase58(), creatorPosition: posC.position.toBase58(), migratedBy: "keeper" });
      void migratedC;

      // 2. vault 2: the position alone, on the 25% preset
      const stMint = Keypair.generate();
      const cv = await client.createVault({ depositor: depositor.publicKey, stMint: stMint.publicKey, policy });
      await send(connection, [cv.ix], [depositor, cv.placeholder, stMint], { label: "create_vault 2" });
      const posState = await dammPosition(connection, posC.position);
      await send(connection, [handPositionNftToVaultIx(posState.nftMint, depositor.publicKey, cv.vault), await client.depositPosition({ vault: cv.vault, depositor: depositor.publicKey, streamIndex: 0, dammPool: dammC, position: posC.position, nftMint: posState.nftMint, nftAccount: derivePositionNftAccount(posState.nftMint), baseMint: mintC.publicKey })], [depositor], { cu: 400_000, label: "deposit_position (standalone)" });
      const L = await client.launch({ vault: cv.vault, depositor: depositor.publicKey, stMint: stMint.publicKey, config: streamCfgs[0], preset: 0, streamIndex: 1, metadata: META("Comet C tail", "tCMTC") });
      await send(connection, [L.ix], [depositor, stMint], { cu: 800_000, label: "launch (stream token 2)" });
      step("vault 2", { vault: cv.vault.toBase58(), stMint: stMint.publicKey.toBase58(), stPool: L.pool.toBase58() });
      vaultKey = cv.vault; stMintKey = stMint.publicKey;

      // 3. the buyer fills the stream token's curve through the app helper; the keeper loop does the rest
      const viewSt = (await retry("loadPool ST2", () => loadPool(connection, L.pool)))!;
      const q2: any = await retry("quote ST2", () => curveQuote(connection, viewSt, R25.muln(6).divn(5), false));
      await sendApp(connection, await retry("swap tx ST2", () => curveSwapTx(connection, L.pool, buyer.publicKey, R25.muln(6).divn(5), q2.minimumAmountOut, false)), [buyer], "buyer fills the stream token 2 curve through the app helper");
      const live0 = await waitFor("vault 2 Live with a registered pair", async () => { const v = await chain.vault(cv.vault); return v && Object.keys(v.status)[0] === "live" && !v.dlmmPair.equals(PublicKey.default) ? v : null; }, 420_000);
      const expectedCashout = R25.sub(R25.muln(75).addn(99).divn(100)); // 25% preset: R - ceil(R x 75%)
      step("vault 2 live", { cashedOut: live0.accounting.cashedOut.toString(), expectedCashout: expectedCashout.toString(), pair: live0.dlmmPair.toBase58(), ownPosition: live0.ownPosition.toBase58() });
      expect(live0.accounting.cashedOut.toString()).eq(expectedCashout.toString());
      }
      const cv = { vault: vaultKey };
      const stMint = { publicKey: stMintKey };
      const mintC = { publicKey: mintCKey };
      const live = await chain.vault(cv.vault);
      const alreadySettled = live.accounting.burnedSt.gtn(0); // a resumed run that already settled goes straight to the indexer check

      // 4. trades on C's pool and the stream token's pool through the app helper, then the ladder
      const stDamm = deriveDammV2PoolAddress(DAMM_V2_MIGRATION_CONFIG.customizable, stMint.publicKey, NATIVE_MINT);
      if (!alreadySettled) {
      for (const [pool, label] of [[dammC, "C"], [stDamm, "stream token 2"]] as const) {
        if (resumed) break; // the trades already happened
        const r = await retry(`damm swap tx ${label}`, () => dammSwapTx(connection, pool, buyer.publicKey, NATIVE_MINT, new BN(200_000_000), { a: 6, b: 9 }));
        await sendApp(connection, r.tx, [buyer], `buyer swaps on ${label}'s DAMM v2 pool through the app helper`);
      }
      const routed = await waitFor("first ladder", async () => { const v = await chain.vault(cv.vault); return v && v.routing.outstandingOrders > 0 ? v : null; }, 420_000);
      const records = await waitFor("order record", async () => { const r = await chain.orderRecords(cv.vault); return r.length ? r : null; }, 120_000);
      step("ladder", { routedGross: routed.accounting.routedGross.toString(), income: routed.accounting.income.toString(), harvestedGross: routed.accounting.harvestedGross.toString(), order: records[0].account.limitOrder.toBase58() });

      // 5. the market crosses the bids; the keeper loop settles and burns
      const pairState = await dlmmPair(connection, live.dlmmPair);
      const order = await chain.limitOrder(records[0].account.limitOrder);
      const bidIds = (order?.bins ?? []).map((b) => b.id);
      const lowest = Math.min(...bidIds, pairState.activeId);
      const touched = Array.from({ length: pairState.activeId - lowest + 2 }, (_, i) => lowest - 1 + i);
      const ladderWsol = (order?.bins ?? []).reduce((acc, b) => acc + b.amount, 0n);
      const amountIn = new BN(Math.floor((Number(ladderWsol) * 0.6) / Math.pow(1.01, pairState.activeId)).toString());
      await send(connection, [ataIx(buyer.publicKey, stMint.publicKey, buyer.publicKey), await dlmmSwapIx(connection, { pair: live.dlmmPair, user: buyer.publicKey, amountIn, binIds: touched })], [buyer], { cu: 800_000, label: "buyer sells stream token 2 into the ladder" });
      const settled = await waitFor("settlement", async () => { const v = await chain.vault(cv.vault); return v && v.accounting.burnedSt.gtn(0) ? v : null; }, 300_000);
      step("settled", { burnedSt: settled.accounting.burnedSt.toString(), orderFeesWsol: settled.accounting.orderFeesWsol.toString(), refundedPrincipal: settled.accounting.refundedPrincipal.toString() });
      }

      // 5b. a second ladder after the market moved: its far bins sit in a bin array that did not exist
      // when the pair was prepared, so the keeper must create it before routing
      const pairNow = await dlmmPair(connection, live.dlmmPair);
      const farBin = pairNow.activeId - 65;
      const farArray = Math.floor(farBin / 70);
      const arrayKey = PublicKey.findProgramAddressSync([Buffer.from("bin_array"), live.dlmmPair.toBuffer(), (() => { const b = Buffer.alloc(8); b.writeBigInt64LE(BigInt(farArray)); return b; })()], new PublicKey("LBUZKhRxPF3XUpBCjp4YzTKgLccjZhTSDM9YuVaPwxo"))[0];
      const arrayBefore = await connection.getAccountInfo(arrayKey);
      const routedBefore = BigInt((await chain.vault(cv.vault)).accounting.routedGross.toString());
      // income for the second ladder: trades on both pools through the app helper
      for (const [pool, label] of [[dammC, "C"], [stDamm, "stream token 2"]] as const) {
        const r = await retry(`damm swap tx ${label} (2)`, () => dammSwapTx(connection, pool, buyer.publicKey, NATIVE_MINT, new BN(300_000_000), { a: 6, b: 9 }));
        await sendApp(connection, r.tx, [buyer], `buyer swaps again on ${label}'s DAMM v2 pool through the app helper`);
      }
      const second = await waitFor("second ladder", async () => { const v = await chain.vault(cv.vault); return BigInt(v.accounting.routedGross.toString()) > routedBefore ? v : null; }, 420_000);
      const arrayAfter = await connection.getAccountInfo(arrayKey);
      step("second ladder", { routedGross: second.accounting.routedGross.toString(), outstanding: second.routing.outstandingOrders, farArray, arrayExistedBefore: !!arrayBefore, arrayExistsAfter: !!arrayAfter });
      expect(!!arrayAfter).true;
      if (!resumed) expect(!!arrayBefore, "the far array must not exist before the keeper prepares it").false; // a resumed run finds it from the earlier pass

      // 6. the indexer's view: events present, accounting reconciled against them, the Sky knows C
      const indexed = await waitFor("indexer reconciles vault 2", async () => {
        const r = await fetch(`http://127.0.0.1:${API}/api/vaults/${cv.vault.toBase58()}?limit=100`);
        if (!r.ok) return null;
        const j = await r.json();
        const names = new Set((j.events ?? []).map((e: any) => e.name));
        return ["launched", "live", "cashedOut", "harvested", "routed", "settled"].every((n) => names.has(n)) && j.data?.reconciliation?.matches ? j : null;
      }, 240_000, 10_000);
      const streamC0 = (indexed.streams ?? []).find((x: any) => String(x.data.pool) === dammC.toBase58());
      const harvestedC0 = (indexed.events ?? []).filter((e: any) => (e.name === "harvested" || e.name === "oneTimeHarvested") && e.data.stream === streamC0?.stream).reduce((a: bigint, e: any) => a + BigInt(e.data.gross), 0n);
      // the Sky refreshes after new events; wait for the row to carry every harvest the indexer holds
      const cRow = await waitFor("Sky attribution of C", async () => { const sky = await (await fetch(`http://127.0.0.1:${API}/api/sky`)).json(); const row = sky.streams.find((s: any) => s.baseMint === mintC.publicKey.toBase58() && (s.kind ?? "curve") === "curve"); return row && row.realized30dLamports === harvestedC0.toString() ? row : null; }, 180_000, 10_000);
      step("indexer", { events: [...new Set(indexed.events.map((e: any) => e.name))], reconciliation: indexed.data.reconciliation, skyC: cRow ? { custody: cRow.custody, eligible: cRow.eligible, realized30d: cRow.realized30dLamports, vault: cRow.vault } : null });
      expect(indexed.data.reconciliation.matches).true;
      expect(cRow?.vault).eq(cv.vault.toBase58());
      const streamC = (indexed.streams ?? []).find((x: any) => String(x.data.pool) === dammC.toBase58());
      const harvestedC = (indexed.events ?? []).filter((e: any) => (e.name === "harvested" || e.name === "oneTimeHarvested") && e.data.stream === streamC?.stream).reduce((a: bigint, e: any) => a + BigInt(e.data.gross), 0n);
      expect(cRow.realized30dLamports).eq(harvestedC.toString());
      expect(harvestedC > 0n).true;
      expect(Number(await tokenBalance(connection, ata(stMint.publicKey, keeper.publicKey)))).gte(0);
      record.finishedAt = new Date().toISOString();
      fs.writeFileSync(file, JSON.stringify(record, null, 2));
    } finally {
      for (const p of procs) p.kill("SIGTERM");
    }
  });
});
