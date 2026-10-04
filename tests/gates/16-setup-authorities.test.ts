// Execute the real setup entrypoint with real DBC builders and public-key-only fixtures.
// RPC, manifest writes and sends are intercepted; no live transaction or wallet file is used.
import { expect } from "chai";
import fs from "fs";
import path from "path";
import vm from "vm";
import { createRequire } from "module";
import ts from "typescript";
import * as web3 from "@solana/web3.js";
import * as spl from "@solana/spl-token";
import { BorshAccountsCoder } from "@coral-xyz/anchor";
import { VAULT_PROGRAM_ID, VaultClientStep6 } from "@cometail/client";
import { dbcProgram } from "../harness/programs";
import { configParams } from "../harness/dbc";
import * as readback from "../mainnet/readback";

const root = path.resolve(__dirname, "../..");
const admin = web3.Keypair.generate().publicKey;
const treasuryOwner = web3.Keypair.generate().publicKey;
const keeper = web3.Keypair.generate().publicKey;
const usdc = new web3.PublicKey("EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v");
const stock = new web3.PublicKey("Xsc9qvGR1efVDFGLrVsmkzv3qi45LTBjeUKSPmx9qEh");
const source = fs.readFileSync(path.join(root, "tests/mainnet/setup.ts"), "utf8");
const code = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, esModuleInterop: true } }).outputText;
const actualRequire = createRequire(path.join(root, "tests/mainnet/setup.ts"));
type Scenario = "fresh" | "missing-treasury" | "same-admin" | "same-keeper" | "changed-treasury" | "changed-protocol-treasury" | "legacy-manifest" | "bad-recorded-plain" | "bad-recorded-stream" | "good-recorded-plain";

async function run(scenario: Scenario) {
  const instructions: web3.TransactionInstruction[] = [], logs: string[] = [];
  let writes = 0, sends = 0, main: () => Promise<void>;
  const record: any = scenario.includes("manifest") || scenario.includes("recorded") || (scenario === "changed-treasury" || scenario === "changed-protocol-treasury") ? {
    cluster: "mainnet-beta", programId: VAULT_PROGRAM_ID.toBase58(), admin: admin.toBase58(), keeper: keeper.toBase58(), treasuryOwner: treasuryOwner.toBase58(), configs: {}, presets: {},
  } : null;
  if (scenario === "changed-treasury") record.treasuryOwner = keeper.toBase58();
  if (scenario === "changed-protocol-treasury") record.treasury = spl.getAssociatedTokenAddressSync(spl.NATIVE_MINT, treasuryOwner).toBase58();
  if (scenario === "legacy-manifest") delete record.treasuryOwner;
  const recordedKey = web3.Keypair.generate().publicKey;
  const recordedName = scenario === "bad-recorded-stream" ? "stream-25" : "plain";
  if (scenario.includes("recorded")) record.configs[recordedName] = recordedKey.toBase58();
  const mint = (decimals: number, owner: web3.PublicKey) => { const data = Buffer.alloc(82); data[44] = decimals; data[45] = 1; return { owner, data }; };
  class Connection {
    async getGenesisHash() { return readback.GENESIS["mainnet-beta"]; }
    async getBalance() { return 1_000_000_000; }
    async getMinimumBalanceForRentExemption() { return 2_000_000; }
    async getLatestBlockhash() { return { blockhash: web3.Keypair.generate().publicKey.toBase58() }; }
    async getAccountInfo(key: web3.PublicKey) {
      if (key.equals(usdc)) return mint(6, spl.TOKEN_PROGRAM_ID);
      if (key.equals(stock)) return mint(8, spl.TOKEN_2022_PROGRAM_ID);
      if (key.equals(readback.badgeOf(stock))) { const data = Buffer.alloc(48); stock.toBuffer().copy(data, 8); return { owner: readback.DBC_PROGRAM, data }; }
      if (key.equals(recordedKey) && scenario.includes("recorded")) return { owner: readback.DBC_PROGRAM, data: Buffer.from("recorded-fixture") };
      return null;
    }
    async simulateTransaction(tx: web3.Transaction) { instructions.push(...tx.instructions); return { value: { err: null, unitsConsumed: 1000 } }; }
  }
  // Decode only the marked fixture. All comparisons other than the deliberately varied authority
  // come from the normal comparator, exercised comprehensively in gate 15.
  class Coder extends BorshAccountsCoder {
    decode(name: string, data: Buffer): any {
      if (data.toString() !== "recorded-fixture") return super.decode(name, data);
      return { fixture: true, fee_claimer: scenario === "good-recorded-plain" || scenario === "bad-recorded-stream" ? treasuryOwner : admin, leftover_receiver: treasuryOwner };
    }
  }
  const deps: Record<string, any> = {
    "@solana/web3.js": { ...web3, Connection, sendAndConfirmTransaction: async () => { sends++; throw Error("unexpected live send"); } },
    "@coral-xyz/anchor": { ...actualRequire("@coral-xyz/anchor"), BorshAccountsCoder: Coder },
    "@cometail/client": { VAULT_PROGRAM_ID, VaultClientStep6 },
    "../harness/programs": { dbcProgram }, "../harness/dbc": { configParams },
    "./readback": { ...readback, compareConfig: (c: any, p: any, exp: any) => c.fixture ? [
      { what: "fee claimer", ok: c.fee_claimer.toBase58() === exp.feeClaimer, detail: "fixture authority" },
      { what: "leftover receiver", ok: c.leftover_receiver.toBase58() === exp.leftoverReceiver, detail: "fixture authority" },
    ] : readback.compareConfig(c, p, exp) },
    fs: {
      existsSync: (file: string) => file === path.join(root, "configs/mainnet.json") ? !!record : fs.existsSync(file),
      readFileSync: (file: string, ...args: any[]) => file === path.join(root, "configs/mainnet.json") ? JSON.stringify(record) : (fs.readFileSync as any)(file, ...args),
      writeFileSync: () => { writes++; throw Error("unexpected manifest write"); },
    },
  };
  const env: any = { RPC: "https://rpc.invalid", DRY_RUN: "1", ADMIN: admin.toBase58(), TREASURY: treasuryOwner.toBase58(), KEEPER: keeper.toBase58(), COMETAIL_QUOTE_USDC: usdc.toBase58(), COMETAIL_QUOTE_STOCK: stock.toBase58() };
  if (scenario === "missing-treasury") delete env.TREASURY;
  if (scenario === "same-admin") env.TREASURY = env.ADMIN;
  if (scenario === "same-keeper") env.TREASURY = env.KEEPER;
  vm.runInNewContext(code, {
    exports: {}, require: (name: string) => deps[name] ?? actualRequire(name), Buffer, __dirname: path.join(root, "tests/mainnet"), process: { env },
    console: { log: (...values: any[]) => logs.push(values.join(" ")) }, describe: (_: string, fn: () => void) => fn(), it: (_: string, fn: () => Promise<void>) => { main = fn; },
  });
  let error = "";
  try { await main!(); } catch (e: any) { error = String(e.message ?? e); }
  return { error, instructions, writes, sends, logs };
}

describe("mainnet setup authority split", () => {
  it("builds exactly three admin and six treasury config instructions with admin as payer", async () => {
    const result = await run("fresh");
    expect(result.error).to.equal("");
    expect(result.writes).to.equal(0); expect(result.sends).to.equal(0);
    const configs = result.instructions.filter(ix => ix.programId.equals(readback.DBC_PROGRAM));
    expect(configs).to.have.length(9);
    const def: any = dbcProgram.idl.instructions.find((ix: any) => ix.name.replaceAll("_", "").toLowerCase() === "createconfig");
    const index = (name: string) => def.accounts.findIndex((a: any) => a.name.replaceAll("_", "").toLowerCase() === name);
    configs.forEach((ix, i) => {
      // Deliberately explicit: plain is fourth in CONFIG_NAMES but must use treasury.
      const expected = i < 3 ? admin : treasuryOwner;
      expect(ix.keys[index("feeclaimer")].pubkey.equals(expected), readback.CONFIG_NAMES[i]).to.equal(true);
      expect(ix.keys[index("leftoverreceiver")].pubkey.equals(expected)).to.equal(true);
      expect(ix.keys[index("payer")].pubkey.equals(admin)).to.equal(true);
      expect(ix.keys[index("feeclaimer")].isSigner).to.equal(false);
      expect(ix.keys[index("leftoverreceiver")].isSigner).to.equal(false);
    });
    const ata = result.instructions.find(ix => ix.programId.equals(spl.ASSOCIATED_TOKEN_PROGRAM_ID))!;
    expect(ata.keys[1].pubkey.equals(spl.getAssociatedTokenAddressSync(spl.NATIVE_MINT, admin))).to.equal(true);
    expect(ata.keys[2].pubkey.equals(admin)).to.equal(true);
  });
  for (const scenario of ["missing-treasury", "same-admin", "same-keeper", "changed-treasury", "changed-protocol-treasury", "legacy-manifest", "bad-recorded-plain", "bad-recorded-stream"] as Scenario[]) {
    it(`rejects ${scenario} before simulation or writes`, async () => {
      const result = await run(scenario);
      expect(result.error).not.to.equal("");
      expect(result.instructions).to.have.length(0);
      expect(result.writes).to.equal(0); expect(result.sends).to.equal(0);
    });
  }
  it("resumes a treasury-owned plain config in the historical configs bucket", async () => {
    const result = await run("good-recorded-plain");
    expect(result.error).to.equal("");
    expect(result.instructions.filter(ix => ix.programId.equals(readback.DBC_PROGRAM))).to.have.length(8);
    expect(result.writes).to.equal(0); expect(result.sends).to.equal(0);
    expect(result.logs.some(line => line.includes("config plain") && line.startsWith("EXISTS"))).to.equal(true);
  });
});
