// Field names are the IDL's snake_case (BorshAccountsCoder keeps them).
// Verifies a cluster's DBC configs and the protocol account against the program's own pins
// (protocol.rs check_stream_config for the three stream presets; eligibility.rs check_dbc_config
// for the plain config), so a mainnet set is checked before anything launches on it.
//   cd tests && RPC=<rpc> CLUSTER=devnet SET=configs ./node_modules/.bin/ts-node devnet/verify-configs.ts
// SET is "configs" (full size) or "e2e" (small thresholds) in configs/<cluster>.json.
import fs from "fs";
import path from "path";
import { Connection, PublicKey } from "@solana/web3.js";
import { BorshAccountsCoder, Idl } from "@coral-xyz/anchor";

const ROOT = path.resolve(__dirname, "..", "..");
const RPC = process.env.RPC ?? "https://api.devnet.solana.com";
const CLUSTER = process.env.CLUSTER ?? "devnet";
const SET = (process.env.SET ?? "configs") as "configs" | "e2e";
const WSOL = "So11111111111111111111111111111111111111112";
const DBC_PROGRAM = "dbcij3LWUppWqq96dh6gJWwBifmcGfLSB5D4DuSMaqN";
const STREAM_MIGRATION_FEE_OPTION = 6;

type Check = { name: string; ok: boolean; detail: string };
const checks: Check[] = [];
const expect = (name: string, ok: boolean, detail: string) => checks.push({ name, ok, detail });
const num = (v: any) => Number(v?.toString?.() ?? v);

(async () => {
  const file = JSON.parse(fs.readFileSync(path.join(ROOT, "configs", `${CLUSTER}.json`), "utf8"));
  const set: Record<string, string> = file[SET];
  if (!set) throw new Error(`no "${SET}" set in configs/${CLUSTER}.json`);
  const conn = new Connection(RPC, "confirmed");
  const dbcIdl = JSON.parse(fs.readFileSync(path.join(ROOT, "idls", "dynamic_bonding_curve.json"), "utf8")) as Idl;
  const vaultIdl = JSON.parse(fs.readFileSync(path.join(ROOT, "target", "idl", "cometail_vault.json"), "utf8")) as Idl;
  const dbc = new BorshAccountsCoder(dbcIdl), vault = new BorshAccountsCoder(vaultIdl);
  // IDL account names as the IDL spells them, whatever the case
  const nameOf = (idl: Idl, re: RegExp) => (idl.accounts ?? []).find((a) => re.test(a.name))?.name ?? "";
  const PROTOCOL = nameOf(vaultIdl, /^protocol$/i), POOL_CONFIG = nameOf(dbcIdl, /^poolconfig$/i);
  const protocolInfo = await conn.getAccountInfo(new PublicKey(file.protocol));
  const protocol: any = protocolInfo ? vault.decode(PROTOCOL, protocolInfo.data) : null;
  expect("protocol account exists", !!protocol, file.protocol);
  const admin = protocol ? new PublicKey(protocol.admin).toBase58() : file.admin;
  expect("protocol admin matches configs file", admin === file.admin, `${admin} vs ${file.admin}`);
  for (const [name, key] of Object.entries(set)) {
    const info = await conn.getAccountInfo(new PublicKey(key));
    if (!info) { expect(`${name} config exists`, false, key); continue; }
    expect(`${name} owned by DBC`, info.owner.toBase58() === DBC_PROGRAM, info.owner.toBase58());
    const c: any = dbc.decode(POOL_CONFIG, info.data);
    const shared = [
      ["quote mint is WSOL", new PublicKey(c.quote_mint).toBase58() === WSOL],
      ["fees collected in quote only (collect_fee_mode 0)", num(c.collect_fee_mode) === 0],
      ["migration to DAMM v2 (migration_option 1)", num(c.migration_option) === 1],
      ["creator liquidity migrates permanently locked only (creator_liquidity_percentage 0)", num(c.creator_liquidity_percentage) === 0],
      ["creator permanent locked liquidity > 0", num(c.creator_permanent_locked_liquidity_percentage) > 0],
      ["no creator liquidity vesting", num(c.creator_liquidity_vesting_info?.vestingPercentage ?? 0) === 0],
      ["migration fee option within the known configs (< 7)", num(c.migration_fee_option) < 7],
      ["token type SPL (token_type 0)", num(c.token_type) === 0],
    ] as [string, boolean][];
    for (const [n, ok] of shared) expect(`${name}: ${n}`, ok, "");
    const preset = ["stream-25", "stream-50", "stream-75"].indexOf(name);
    if (preset >= 0) {
      const lv = c.locked_vesting_config ?? {};
      const stream = [
        ["fee claimer is the protocol admin", new PublicKey(c.fee_claimer).toBase58() === admin],
        ["migrated pool compounds (migrated_collect_fee_mode 2)", num(c.migrated_collect_fee_mode) === 2],
        ["creator trading fee 75%", num(c.creator_trading_fee_percentage) === 75],
        ["creator 80% / partner 20% permanently locked", num(c.creator_permanent_locked_liquidity_percentage) === 80 && num(c.partner_permanent_locked_liquidity_percentage) === 20],
        ["partner liquidity percentage 0", num(c.partner_liquidity_percentage) === 0],
        [`migration fee ${[25, 50, 75][preset]}% with creator share 100%`, num(c.migration_fee_percentage) === [25, 50, 75][preset] && num(c.creator_migration_fee_percentage) === 100],
        [`migration fee option ${STREAM_MIGRATION_FEE_OPTION} (customizable)`, num(c.migration_fee_option) === STREAM_MIGRATION_FEE_OPTION],
        ["no locked vesting schedule", [lv.amount_per_period, lv.cliff_duration_from_migration_time, lv.frequency, lv.number_of_period, lv.cliff_unlock_amount].every((v) => num(v ?? 0) === 0)],
        ["no partner liquidity vesting", num(c.partner_liquidity_vesting_info?.vestingPercentage ?? 0) === 0],
        ["pinned in the protocol account at this preset", !!protocol && new PublicKey(protocol.stream_configs[preset]).toBase58() === key],
      ] as [string, boolean][];
      for (const [n, ok] of stream) expect(`${name}: ${n}`, ok, "");
    } else {
      expect(`${name}: migrated pool collects in quote or compounds (0 or 2)`, [0, 2].includes(num(c.migrated_collect_fee_mode)), String(num(c.migrated_collect_fee_mode)));
    }
    expect(`${name}: migration quote threshold`, num(c.migration_quote_threshold) > 0, `${(num(c.migration_quote_threshold) / 1e9).toFixed(3)} SOL`);
  }
  const failed = checks.filter((c) => !c.ok);
  for (const c of checks) console.log(`${c.ok ? "PASS" : "FAIL"}  ${c.name}${c.detail ? "  (" + c.detail + ")" : ""}`);
  console.log(`\n${CLUSTER} ${SET}: ${checks.length - failed.length}/${checks.length} checks pass`);
  process.exit(failed.length ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(2); });
