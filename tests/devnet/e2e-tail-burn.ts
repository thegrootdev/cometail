// Devnet follow-up to e2e-tail.ts: buybacks (one every ten minutes, the program's cooldown) until the SOL the
// recorded tail claims sent to the reserve has been spent, first in, first out; then the worker's tail index reads
// the reserve ledger again and the record gets what each claim burned, with the buyback transactions.
//   cd tests && RECORD=../.local/e2e-tail-<time>.json ./node_modules/.bin/ts-mocha --exit -p ./tsconfig.json -t 6000000 devnet/e2e-tail-burn.ts
import { Connection, Keypair, PublicKey } from "@solana/web3.js";
import { expect } from "chai";
import fs from "fs";
import path from "path";
import { BurnClient } from "@cometail/client";
import { Chain } from "../../worker/src/chain";
import { readBurnState, nextBuyback } from "../../worker/src/burn";
import { openStore } from "../../worker/src/store";
import { chainWalkDeps, parseTails, refreshSources, tailIndexPass, tailView } from "../../worker/src/tails";
import { dammPool, log, send, tokenBalance } from "./rpc";

const ROOT = path.resolve(__dirname, "..", "..");
const RPC = process.env.RPC ?? "https://api.devnet.solana.com";
const key = (name: string) => Keypair.fromSecretKey(Uint8Array.from(JSON.parse(fs.readFileSync(path.join(ROOT, "keys", "devnet", `${name}.json`), "utf8"))));
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe("devnet: the tail claims' SOL, bought back and burned", () => {
  it("buybacks until the claims are spent; the index attributes the burn to each claim", async () => {
    const file = process.env.RECORD!;
    const record = JSON.parse(fs.readFileSync(file, "utf8"));
    const s = (n: string) => record.steps.find((x: any) => x.name === n);
    const connection = new Connection(RPC, "confirmed");
    if ((await connection.getGenesisHash()) !== "EtWTRABZaYq6iMfeYKouRu166VU2xqa1wcaWoxPkrZBG") throw new Error("not devnet");
    const chain = new Chain(connection), client = new BurnClient(connection), keeper = key("keeper");
    const launched = s("tail launched"), pos = s("locked position"), st0 = s("burn program and its stand-in $COMETAIL pool");
    const tails = parseTails(`${launched.mint}:${launched.config}:${st0.pool}`);
    void pos;
    const store = openStore(`sqlite:${path.join(ROOT, ".local", `e2e-tail-burn-store-${Date.now()}.sqlite`)}`); await store.init();
    const view = async () => { for (let i = 0; i < 8; i++) { { const deps = chainWalkDeps(connection); await tailIndexPass(deps, store, tails, new PublicKey(st0.reserve), (t) => refreshSources(chain, deps, store, t)); } const v: any = (await tailView(store, tails, null)).tails[0]; if (v.coverage.reserve.status === "complete" && v.coverage.claims.status === "complete") return v; await sleep(5_000); } return (await tailView(store, tails, null)).tails[0] as any; };
    const buybacks: string[] = [], topUps: string[] = [];
    for (let round = 0; round < 10; round++) {
      const v = await view();
      if (v.claims.filter((c: any) => c.toBurnLamports !== null).every((c: any) => c.burn && BigInt(c.burn.waitingLamports) === 0n)) break;
      const st = (await readBurnState(chain, client))!;
      const p = await dammPool(connection, st.pool);
      const reserve = BigInt((await tokenBalance(connection, st.reserve)).toString());
      const next = nextBuyback(st, reserve, BigInt(p.tokenBAmount.toString()), Math.floor(Date.now() / 1000));
      if (!next.due && next.amount < 1_000_000n) {
        // below the program's 0.001 SOL minimum buy, the reserve waits for more: on devnet a later inflow is sent
        // (after the claims, so first in, first out spends the claims' SOL first)
        const { SystemProgram } = await import("@solana/web3.js");
        const { createSyncNativeInstruction, getAssociatedTokenAddressSync, createAssociatedTokenAccountIdempotentInstruction, createTransferInstruction, NATIVE_MINT } = await import("@solana/spl-token");
        const authority = key("authority"), src = getAssociatedTokenAddressSync(NATIVE_MINT, authority.publicKey);
        const top = 1_200_000n;
        topUps.push(await send(connection, [createAssociatedTokenAccountIdempotentInstruction(authority.publicKey, src, authority.publicKey, NATIVE_MINT), SystemProgram.transfer({ fromPubkey: authority.publicKey, toPubkey: src, lamports: Number(top) }), createSyncNativeInstruction(src), createTransferInstruction(src, st.reserve, authority.publicKey, top)], [authority], { label: "devnet: a later inflow to the reserve, above the buy minimum" }));
        continue;
      }
      if (!next.due) { const wait = Math.max(5, next.dueAtSec - Math.floor(Date.now() / 1000) + 5); log("waiting for the cooldown", { seconds: wait }); await sleep(wait * 1000); continue; }
      buybacks.push(await send(connection, [await client.buyback({ state: st, tokenAVault: p.tokenAVault, tokenBVault: p.tokenBVault })], [keeper], { cu: 400_000, label: `buyback ${buybacks.length + 1}` }));
    }
    const v = await view();
    for (const c of v.claims.filter((x: any) => x.toBurnLamports !== null)) { expect(c.burn, "traced").not.null; expect(BigInt(c.burn.waitingLamports)).eq(0n); expect(BigInt(c.burn.boughtRaw) > 0n).true; }
    expect(v.coverage.reserveVerified).eq(true);
    record.steps.push({ name: "claims bought back and burned", buybacks, topUps, totals: v.totals, claims: v.claims.map((c: any) => ({ signature: c.signature, source: c.source, status: c.status, toBurn: c.toBurnLamports, burn: c.burn })) });
    fs.writeFileSync(file, JSON.stringify(record, null, 2));
    log("claims bought back and burned", { totals: v.totals });
    await store.close();
  });
});
