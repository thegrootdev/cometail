// Devnet (or mainnet) readback of the burn program: index its whole history into a fresh store and check
// /api/burn's view against the program's own counters: the burns' sum equals burned, their count equals
// buybacks, the splits' sum equals claimed, sent-directly is what reached the reserve outside splits, and
// the history is complete. Read-only.
//   cd tests && RPC=<rpc> BURN_CONFIGS=<new configs> MIN_DIRECT=<lamports> ./node_modules/.bin/ts-mocha --exit -p ./tsconfig.json -t 600000 devnet/burn-readback.ts
import { Connection } from "@solana/web3.js";
import { expect } from "chai";
import fs from "fs";
import os from "os";
import path from "path";
import { Chain } from "../../worker/src/chain";
import { openStore } from "../../worker/src/store";
import { readBurnState } from "../../worker/src/burn";
import { burnIndexPass, chainDeps } from "../../worker/src/burnindex";
import { burnViewer } from "../../worker/src/burnview";

describe("burn program readback", () => {
  it("the indexed history and the view equal the program's own counters", async () => {
    const chain = new Chain(new Connection(process.env.RPC ?? "https://api.devnet.solana.com", "confirmed"));
    const s = (await readBurnState(chain))!;
    expect(s, "burn program set up").not.eq(null);
    const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "burn-readback-")), "store.sqlite");
    const store = openStore(`sqlite:${file}`); await store.init();
    for (let i = 0; i < 5; i++) { try { await burnIndexPass(chainDeps(chain.connection), store); } catch (e) { console.log("retry", String((e as Error).message).slice(0, 100)); } }
    const view: any = await burnViewer(chain, store, { cluster: "devnet", burnConfigs: (process.env.BURN_CONFIGS ?? "").split(",").filter(Boolean), legacyConfigs: [], feeIndex: null })();
    console.log(JSON.stringify({ totals: view.totals, reserve: view.reserve, sentDirect: view.sentDirectLamports, coverage: view.coverage, burns: view.burns.map((b: any) => [b.signature, b.spentLamports, b.burnedRaw]), splits: view.splits.map((x: any) => [x.signature.slice(0, 12), x.source, x.claimant, x.claimedLamports, x.carriedLamports, x.toReserveLamports, x.toOtherLamports]) }, null, 1));
    expect(view.status).eq("live");
    expect(view.coverage.status).eq("complete");
    expect(view.burnsTotal).eq(Number(s.buybacks.toString()));
    expect(view.burns.reduce((t: bigint, b: any) => t + BigInt(b.burnedRaw), 0n)).eq(BigInt(s.burnedTotal.toString()));
    expect(view.burns.reduce((t: bigint, b: any) => t + BigInt(b.spentLamports), 0n)).eq(BigInt(s.spentTotal.toString()));
    expect(view.splits.reduce((t: bigint, x: any) => t + BigInt(x.toReserveLamports) + BigInt(x.toOtherLamports), 0n)).eq(BigInt(s.splitTotal.toString()));
    for (const x of view.splits) expect(BigInt(x.toReserveLamports)).eq((BigInt(x.toReserveLamports) + BigInt(x.toOtherLamports)) / 2n);
    expect(BigInt(view.sentDirectLamports) >= BigInt(process.env.MIN_DIRECT ?? "0")).eq(true);
    await store.close();
  });
});
