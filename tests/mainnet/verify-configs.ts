// Readback of a cluster's config set against the files it was built from. Fails unless the
// state file names exactly the nine configs and the protocol, the RPC is the file's cluster, the
// program id matches, every config decodes and matches every parameter (readback.ts), the quote
// mints are initialized mints of the recorded decimals, a Token-2022 quote has its DBC badge
// (required on mainnet), and the protocol pins the file's admin, keeper, treasury and streams.
//   cd tests && RPC=<rpc> CLUSTER=devnet|mainnet ./node_modules/.bin/ts-mocha --exit -p ./tsconfig.json -t 600000 mainnet/verify-configs.ts
import fs from "fs";
import path from "path";
import { Connection, PublicKey } from "@solana/web3.js";
import { BorshAccountsCoder, Idl } from "@coral-xyz/anchor";
import { expect } from "chai";
import { VAULT_PROGRAM_ID } from "@cometail/client";
import { configParams } from "../harness/dbc";
import { CONFIG_NAMES, DBC_PROGRAM, WSOL, Check, compareConfig, compareProtocol, fileChecks, readBadge, readMint } from "./readback";

const ROOT = path.resolve(__dirname, "..", "..");
const RPC = process.env.RPC ?? "https://api.devnet.solana.com";
const CLUSTER = process.env.CLUSTER ?? "devnet";
const CLUSTER_NAME = CLUSTER === "mainnet" ? "mainnet-beta" : CLUSTER;

async function main() {
  const file = JSON.parse(fs.readFileSync(path.join(ROOT, "configs", `${CLUSTER}.json`), "utf8"));
  const conn = new Connection(RPC, "confirmed");
  const dbcIdl = JSON.parse(fs.readFileSync(path.join(ROOT, "idls", "dynamic_bonding_curve.json"), "utf8")) as Idl;
  const vaultIdl = JSON.parse(fs.readFileSync(path.join(ROOT, "packages", "client", "idl", "cometail_vault.json"), "utf8")) as Idl;
  const dbc = new BorshAccountsCoder(dbcIdl), vault = new BorshAccountsCoder(vaultIdl);
  const nameOf = (idl: Idl, re: RegExp) => (idl.accounts ?? []).find((a) => re.test(a.name))?.name ?? "";
  const POOL_CONFIG = nameOf(dbcIdl, /^poolconfig$/i), PROTOCOL = nameOf(vaultIdl, /^protocol$/i);
  const failures: string[] = [];
  const report = (scope: string, checks: Check[]) => { for (const c of checks) { console.log(`${c.ok ? "PASS" : "FAIL"} ${scope}: ${c.what} ${c.detail}`); if (!c.ok) failures.push(`${scope}: ${c.what} ${c.detail}`); } };

  // the file and the cluster
  report("file", fileChecks(file, { clusterName: CLUSTER_NAME, genesis: await conn.getGenesisHash(), programId: VAULT_PROGRAM_ID.toBase58() }));
  process.env.COMETAIL_QUOTE_USDC = file.quoteMints?.usdc ?? ""; process.env.COMETAIL_QUOTE_STOCK = file.quoteMints?.stock ?? "";
  const quoteOf = (name: string) => (name === "stock-usdc" ? file.quoteMints?.usdc : name === "stock-xstock" ? file.quoteMints?.stock : WSOL) as string | undefined;
  const recorded: Record<string, string> = { ...(file.configs ?? {}), ...(file.presets ?? {}) };

  for (const name of CONFIG_NAMES) {
    const key = recorded[name];
    if (!key) continue;
    const info = await conn.getAccountInfo(new PublicKey(key));
    if (!info) { report(name, [{ what: "exists", ok: false, detail: key }]); continue; }
    report(name, [{ what: "owner is DBC", ok: info.owner.equals(DBC_PROGRAM), detail: info.owner.toBase58() }]);
    if (!info.owner.equals(DBC_PROGRAM)) continue;
    const quote = quoteOf(name);
    if (!quote) { report(name, [{ what: "quote mint recorded", ok: false, detail: "missing from quoteMints" }]); continue; }
    const mint = await readMint(conn, new PublicKey(quote));
    const fileDecimals = JSON.parse(fs.readFileSync(path.join(ROOT, "configs", `${name}.json`), "utf8")).token.tokenQuoteDecimal;
    report(name, [
      { what: "quote mint account", ok: mint.ok, detail: mint.detail },
      { what: "quote decimals", ok: mint.decimals === fileDecimals, detail: `${mint.decimals} vs file ${fileDecimals}` },
    ]);
    if (mint.is2022 && quote !== WSOL) {
      const badge = await readBadge(conn, new PublicKey(quote));
      report(name, [{ what: "quote token badge", ok: badge.ok || CLUSTER_NAME !== "mainnet-beta", detail: badge.ok ? badge.detail : `${badge.detail} (devnet stand-ins are permissionless; mainnet needs the badge)` }]);
    }
    const c: any = dbc.decode(POOL_CONFIG, info.data);
    report(name, compareConfig(c, configParams(name), { quoteMint: quote, quoteIs2022: mint.is2022, admin: file.admin }));
  }

  if (file.protocol) {
    const info = await conn.getAccountInfo(new PublicKey(file.protocol));
    if (!info) report("protocol", [{ what: "exists", ok: false, detail: file.protocol }]);
    else report("protocol", compareProtocol(info.owner, vault.decode(PROTOCOL, info.data), file, VAULT_PROGRAM_ID, CLUSTER_NAME !== "mainnet-beta"));
  }
  console.log(`${failures.length === 0 ? "VERIFY: PASS" : "VERIFY: FAIL"} (${CONFIG_NAMES.length} configs required, ${failures.length} failures)`);
  expect(failures, failures.join("\n")).to.have.length(0);
}
describe(`config readback on ${CLUSTER}`, () => { it("matches every file and the protocol pins", main); });
