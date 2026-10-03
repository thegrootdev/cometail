// Readback of a cluster's config set against the files it was built from, for the nine configs
// (configs/<cluster>.json "configs" and "presets"): quote mint and decimals, the migration
// threshold, the curve's sqrt prices and liquidity, the start price, the base fee, the liquidity
// split, migration options, creation fee, token decimals and supply flags; the stock preset's
// DBC token badge; the protocol account's admin, keeper, treasury and stream-config pins.
//   cd tests && RPC=<rpc> CLUSTER=mainnet ./node_modules/.bin/ts-mocha --exit -p ./tsconfig.json -t 600000 mainnet/verify-configs.ts
import fs from "fs";
import path from "path";
import { Connection, PublicKey } from "@solana/web3.js";
import { TOKEN_2022_PROGRAM_ID } from "@solana/spl-token";
import { BorshAccountsCoder, Idl } from "@coral-xyz/anchor";
import { expect } from "chai";
import { configParams, PresetName } from "../harness/dbc";

const ROOT = path.resolve(__dirname, "..", "..");
const RPC = process.env.RPC ?? "https://api.devnet.solana.com";
const CLUSTER = process.env.CLUSTER ?? "devnet";
const DBC_PROGRAM = new PublicKey("dbcij3LWUppWqq96dh6gJWwBifmcGfLSB5D4DuSMaqN");
const WSOL = "So11111111111111111111111111111111111111112";
const num = (v: any) => String(v?.toString?.() ?? v);
const get = (o: any, snake: string) => o?.[snake] ?? o?.[snake.replace(/_([a-z])/g, (_, c) => c.toUpperCase())];

async function main() {
  const file = JSON.parse(fs.readFileSync(path.join(ROOT, "configs", `${CLUSTER}.json`), "utf8"));
  const conn = new Connection(RPC, "confirmed");
  const dbcIdl = JSON.parse(fs.readFileSync(path.join(ROOT, "idls", "dynamic_bonding_curve.json"), "utf8")) as Idl;
  const vaultIdl = JSON.parse(fs.readFileSync(path.join(ROOT, "packages", "client", "idl", "cometail_vault.json"), "utf8")) as Idl;
  const dbc = new BorshAccountsCoder(dbcIdl), vault = new BorshAccountsCoder(vaultIdl);
  const nameOf = (idl: Idl, re: RegExp) => (idl.accounts ?? []).find((a) => re.test(a.name))?.name ?? "";
  const POOL_CONFIG = nameOf(dbcIdl, /^poolconfig$/i), PROTOCOL = nameOf(vaultIdl, /^protocol$/i);
  process.env.COMETAIL_QUOTE_USDC = file.quoteMints?.usdc ?? ""; process.env.COMETAIL_QUOTE_STOCK = file.quoteMints?.stock ?? "";
  const quoteOf = (name: string) => name === "stock-usdc" ? file.quoteMints?.usdc : name === "stock-xstock" ? file.quoteMints?.stock : WSOL;
  const entries: [string, string][] = [...Object.entries(file.configs ?? {}), ...Object.entries(file.presets ?? {})] as [string, string][];
  const failures: string[] = [];
  const check = (name: string, what: string, ok: boolean, detail: string) => { console.log(`${ok ? "PASS" : "FAIL"} ${name}: ${what} ${detail}`); if (!ok) failures.push(`${name}: ${what} ${detail}`); };
  for (const [name, key] of entries) {
    const info = await conn.getAccountInfo(new PublicKey(key));
    if (!info) { check(name, "exists", false, key); continue; }
    check(name, "owner is DBC", info.owner.equals(DBC_PROGRAM), info.owner.toBase58());
    const c: any = dbc.decode(POOL_CONFIG, info.data);
    const p: any = configParams(name as PresetName);
    const quote = new PublicKey(get(c, "quote_mint")).toBase58();
    check(name, "quote mint", quote === quoteOf(name), `${quote.slice(0, 8)} vs ${String(quoteOf(name)).slice(0, 8)}`);
    const mintInfo = await conn.getAccountInfo(new PublicKey(quote));
    const quoteDecimals = mintInfo ? mintInfo.data[44] : -1;
    const fileQuoteDecimals = JSON.parse(fs.readFileSync(path.join(ROOT, "configs", `${name}.json`), "utf8")).token.tokenQuoteDecimal;
    check(name, "quote decimals", quoteDecimals === fileQuoteDecimals, `${quoteDecimals} vs file ${fileQuoteDecimals}`);
    if (mintInfo && mintInfo.owner.equals(TOKEN_2022_PROGRAM_ID) && quote !== WSOL) {
      const badge = PublicKey.findProgramAddressSync([Buffer.from("token_badge"), new PublicKey(quote).toBuffer()], DBC_PROGRAM)[0];
      const b = await conn.getAccountInfo(badge);
      check(name, "quote token badge (Token-2022 quote)", !!b || CLUSTER !== "mainnet", b ? badge.toBase58() : "absent (devnet stand-ins are permissionless; mainnet needs the badge)");
    }
    const pairs: [string, string, string][] = [
      ["migration threshold", num(get(c, "migration_quote_threshold")), num(p.migrationQuoteThreshold)],
      ["sqrt start price", num(get(c, "sqrt_start_price")), num(p.sqrtStartPrice)],
      ["token decimals", num(get(c, "token_decimal")), num(p.tokenDecimal)],
      ["token type", num(get(c, "token_type")), num(p.tokenType)],
      ["migration option", num(get(c, "migration_option")), num(p.migrationOption)],
      ["migration fee option", num(get(c, "migration_fee_option")), num(p.migrationFeeOption)],
      ["collect fee mode", num(get(c, "collect_fee_mode")), num(p.collectFeeMode)],
      ["creator trading fee %", num(get(c, "creator_trading_fee_percentage")), num(p.creatorTradingFeePercentage)],
      ["migration fee %", num(get(c, "migration_fee_percentage")), num(p.migrationFee?.feePercentage)],
      ["creator migration fee %", num(get(c, "creator_migration_fee_percentage")), num(p.migrationFee?.creatorFeePercentage)],
      ["partner permanent locked lp %", num(get(c, "partner_permanent_locked_liquidity_percentage")), num(p.partnerPermanentLockedLiquidityPercentage ?? p.partnerLockedLpPercentage)],
      ["creator permanent locked lp %", num(get(c, "creator_permanent_locked_liquidity_percentage")), num(p.creatorPermanentLockedLiquidityPercentage ?? p.creatorLockedLpPercentage)],
      ["pool creation fee", num(get(c, "pool_creation_fee")), num(p.poolCreationFee)],
      ["base fee cliff numerator", num(get(get(get(c, "pool_fees"), "base_fee"), "cliff_fee_numerator")), num(p.poolFees?.baseFee?.cliffFeeNumerator)],
      ["curve points", String((get(c, "curve") ?? []).filter((x: any) => num(get(x, "liquidity")) !== "0").length), String((p.curve ?? []).length)],
    ];
    for (const [what, onchain, expected] of pairs) check(name, what, onchain === expected, expected === "undefined" ? `(file has no ${what}; on chain ${onchain})` : `${onchain} vs ${expected}`);
    const curve = (get(c, "curve") ?? []).filter((x: any) => num(get(x, "liquidity")) !== "0");
    (p.curve ?? []).forEach((seg: any, i: number) => {
      const on = curve[i];
      check(name, `curve segment ${i + 1}`, !!on && num(get(on, "sqrt_price")) === num(seg.sqrtPrice) && num(get(on, "liquidity")) === num(seg.liquidity), on ? `${num(get(on, "sqrt_price")).slice(0, 10)}/${num(get(on, "liquidity")).slice(0, 10)}` : "missing");
    });
  }
  // the protocol
  if (file.protocol) {
    const info = await conn.getAccountInfo(new PublicKey(file.protocol));
    if (!info) check("protocol", "exists", false, file.protocol);
    else {
      const pr: any = vault.decode(PROTOCOL, info.data);
      check("protocol", "admin", new PublicKey(pr.admin).toBase58() === file.admin, file.admin);
      check("protocol", "keeper", new PublicKey(pr.keeper).toBase58() === file.keeper, file.keeper);
      check("protocol", "treasury", new PublicKey(pr.treasury).toBase58() === file.treasury, file.treasury);
      const pins = (pr.streamConfigs ?? pr.stream_configs ?? []).map((k: any) => new PublicKey(k).toBase58());
      // devnet's protocol pins the small-threshold "e2e" set the loop runs on; mainnet has one set.
      const sets: [string, any][] = [["configs", file.configs], ...(CLUSTER === "mainnet" ? [] : [["e2e", file.e2e]] as [string, any][])];
      const pinned = sets.find(([, set]) => ["stream-25", "stream-50", "stream-75"].every((n, i) => set?.[n] === pins[i]));
      check("protocol", "stream pins", !!pinned, pinned ? `the "${pinned[0]}" set` : `${pins.map((k: string) => k.slice(0, 8)).join(",")} match no set in the file`);
    }
  }
  console.log(`${failures.length === 0 ? "VERIFY: PASS" : "VERIFY: FAIL"} (${entries.length} configs)`);
  expect(failures, failures.join("\n")).to.have.length(0);
}
describe(`config readback on ${CLUSTER}`, () => { it("matches every file and the protocol pins", main); });
