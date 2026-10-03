// Shared readback checks for a cluster's config set: every ConfigParameters field a preset file
// produces, compared with the decoded PoolConfig account, plus the authorities, the quote mint
// and the protocol pins. Used by verify-configs.ts (any cluster) and setup.ts (mainnet).
import { Connection, PublicKey } from "@solana/web3.js";
import { TOKEN_2022_PROGRAM_ID, TOKEN_PROGRAM_ID } from "@solana/spl-token";
import { PresetName } from "../harness/dbc";

export type Check = { what: string; ok: boolean; detail: string };
export const PROTOCOL_SET: PresetName[] = ["stream-25", "stream-50", "stream-75", "plain"];
export const PUBLIC_SET: PresetName[] = ["long", "flat", "exp", "stock-usdc", "stock-xstock"];
export const CONFIG_NAMES: PresetName[] = [...PROTOCOL_SET, ...PUBLIC_SET];
export const DBC_PROGRAM = new PublicKey("dbcij3LWUppWqq96dh6gJWwBifmcGfLSB5D4DuSMaqN");
export const WSOL = "So11111111111111111111111111111111111111112";
export const GENESIS: Record<string, string> = { devnet: "EtWTRABZaYq6iMfeYKouRu166VU2xqa1wcaWoxPkrZBG", "mainnet-beta": "5eykt4UsFv8P8NJdTREpY1vzqKqZKvdpKuc147dw2N9d" };

const num = (v: any) => (v === undefined || v === null ? "undefined" : String(v?.toString?.() ?? v));
/** Anchor decodes with the IDL's field names (snake_case); the SDK's parameters are camelCase. */
export const get = (o: any, snake: string) => o?.[snake] ?? o?.[snake.replace(/_([a-z])/g, (_, c) => c.toUpperCase())];
const key = (v: any) => (v ? new PublicKey(v).toBase58() : "undefined");

export function badgeOf(quoteMint: PublicKey): PublicKey {
  return PublicKey.findProgramAddressSync([Buffer.from("token_badge"), quoteMint.toBuffer()], DBC_PROGRAM)[0];
}

/** The mint account layout shared by both token programs: decimals at 44, is_initialized at 45. */
export async function readMint(conn: Connection, mint: PublicKey): Promise<{ ok: boolean; is2022: boolean; decimals: number; detail: string }> {
  const info = await conn.getAccountInfo(mint);
  if (!info) return { ok: false, is2022: false, decimals: -1, detail: "absent" };
  const is2022 = info.owner.equals(TOKEN_2022_PROGRAM_ID), spl = info.owner.equals(TOKEN_PROGRAM_ID);
  if (!is2022 && !spl) return { ok: false, is2022, decimals: -1, detail: `owner ${info.owner.toBase58()} is not a token program` };
  if (info.data.length < 82 || info.data[45] !== 1) return { ok: false, is2022, decimals: -1, detail: `not an initialized mint (${info.data.length} bytes)` };
  return { ok: true, is2022, decimals: info.data[44], detail: `decimals ${info.data[44]}, ${is2022 ? "Token-2022" : "SPL"}` };
}

/** The DBC token badge for a quote mint: must be owned by DBC and name that mint. */
export async function readBadge(conn: Connection, quoteMint: PublicKey): Promise<{ ok: boolean; detail: string }> {
  const badge = badgeOf(quoteMint);
  const info = await conn.getAccountInfo(badge);
  if (!info) return { ok: false, detail: `no badge at ${badge.toBase58()}` };
  if (!info.owner.equals(DBC_PROGRAM)) return { ok: false, detail: `badge owner ${info.owner.toBase58()} is not DBC` };
  const named = new PublicKey(info.data.subarray(8, 40));
  if (!named.equals(quoteMint)) return { ok: false, detail: `badge names ${named.toBase58()}, not the quote` };
  return { ok: true, detail: badge.toBase58() };
}

function schedulerBytes(s: any): string {
  // MigratedPoolMarketCapFeeSchedulerParams packed into migrated_pool_base_fee_bytes (16 bytes, little endian).
  const b = Buffer.alloc(16);
  b.writeUInt16LE(Number(num(s?.numberOfPeriod)) || 0, 0);
  b.writeUInt16LE(Number(num(s?.sqrtPriceStepBps)) || 0, 2);
  b.writeUInt32LE(Number(num(s?.schedulerExpirationDuration)) || 0, 4);
  b.writeBigUInt64LE(BigInt(num(s?.reductionFactor) === "undefined" ? 0 : num(s.reductionFactor)), 8);
  return b.toString("hex");
}

/**
 * Every field of a decoded PoolConfig against the parameters its file produces. The last check
 * fails when the parameters carry a key this list does not cover, so a new SDK field cannot go
 * unverified.
 */
export function compareConfig(c: any, p: any, exp: { quoteMint: string; quoteIs2022: boolean; admin: string }): Check[] {
  const out: Check[] = [];
  const eq = (what: string, onchain: any, expected: any) => out.push({ what, ok: num(onchain) === num(expected), detail: `${num(onchain)} vs ${num(expected)}` });
  const fees = get(c, "pool_fees"), base = get(fees, "base_fee"), dyn = get(fees, "dynamic_fee");
  eq("quote mint", key(get(c, "quote_mint")), exp.quoteMint);
  eq("quote token flag", get(c, "quote_token_flag"), exp.quoteIs2022 ? 1 : 0);
  eq("fee claimer", key(get(c, "fee_claimer")), exp.admin);
  eq("leftover receiver", key(get(c, "leftover_receiver")), exp.admin);
  eq("base fee cliff numerator", get(base, "cliff_fee_numerator"), p.poolFees.baseFee.cliffFeeNumerator);
  eq("base fee first factor", get(base, "first_factor"), p.poolFees.baseFee.firstFactor);
  eq("base fee second factor", get(base, "second_factor"), p.poolFees.baseFee.secondFactor);
  eq("base fee third factor", get(base, "third_factor"), p.poolFees.baseFee.thirdFactor);
  eq("base fee mode", get(base, "base_fee_mode"), p.poolFees.baseFee.baseFeeMode);
  if (p.poolFees.dynamicFee) {
    eq("dynamic fee initialized", get(dyn, "initialized"), 1);
    for (const f of ["bin_step", "bin_step_u128", "filter_period", "decay_period", "reduction_factor", "max_volatility_accumulator", "variable_fee_control"]) eq(`dynamic fee ${f}`, get(dyn, f), get(p.poolFees.dynamicFee, f));
  } else eq("dynamic fee initialized", get(dyn, "initialized"), 0);
  for (const f of ["collect_fee_mode", "migration_option", "activation_type", "token_type", "token_decimal", "partner_liquidity_percentage", "partner_permanent_locked_liquidity_percentage", "creator_liquidity_percentage", "creator_permanent_locked_liquidity_percentage", "migration_quote_threshold", "sqrt_start_price", "migration_fee_option", "creator_trading_fee_percentage", "token_update_authority", "pool_creation_fee", "migrated_pool_base_fee_mode"]) eq(f.replace(/_/g, " "), get(c, f), get(p, f));
  const lv = get(c, "locked_vesting_config");
  for (const f of ["amount_per_period", "cliff_duration_from_migration_time", "frequency", "number_of_period", "cliff_unlock_amount"]) eq(`locked vesting ${f}`, get(lv, f), get(p.lockedVesting, f));
  if (p.tokenSupply) {
    eq("fixed token supply flag", get(c, "fixed_token_supply_flag"), 1);
    eq("pre migration token supply", get(c, "pre_migration_token_supply"), p.tokenSupply.preMigrationTokenSupply);
    eq("post migration token supply", get(c, "post_migration_token_supply"), p.tokenSupply.postMigrationTokenSupply);
  } else eq("fixed token supply flag", get(c, "fixed_token_supply_flag"), 0);
  eq("migration fee percentage", get(c, "migration_fee_percentage"), p.migrationFee.feePercentage);
  eq("creator migration fee percentage", get(c, "creator_migration_fee_percentage"), p.migrationFee.creatorFeePercentage);
  eq("migrated collect fee mode", get(c, "migrated_collect_fee_mode"), p.migratedPoolFee.collectFeeMode);
  eq("migrated dynamic fee", get(c, "migrated_dynamic_fee"), p.migratedPoolFee.dynamicFee);
  eq("migrated pool fee bps", get(c, "migrated_pool_fee_bps"), p.migratedPoolFee.poolFeeBps);
  eq("migrated compounding fee bps", get(c, "migrated_compounding_fee_bps"), p.compoundingFeeBps);
  eq("enable first swap with min fee", get(c, "enable_first_swap_with_min_fee"), p.enableFirstSwapWithMinFee ? 1 : 0);
  eq("migrated pool fee scheduler bytes", Buffer.from(get(c, "migrated_pool_base_fee_bytes") ?? []).toString("hex"), schedulerBytes(p.migratedPoolMarketCapFeeSchedulerParams));
  for (const side of ["partner", "creator"]) {
    const on = get(c, `${side}_liquidity_vesting_info`), ex = p[`${side}LiquidityVestingInfo`];
    for (const f of ["vesting_percentage", "bps_per_period", "number_of_periods", "cliff_duration_from_migration_time", "frequency"]) eq(`${side} liquidity vesting ${f}`, get(on, f), get(ex, f));
  }
  const curve = (get(c, "curve") ?? []).filter((x: any) => num(get(x, "liquidity")) !== "0");
  eq("curve points", curve.length, p.curve.length);
  p.curve.forEach((seg: any, i: number) => {
    const on = curve[i];
    out.push({ what: `curve segment ${i + 1}`, ok: !!on && num(get(on, "sqrt_price")) === num(seg.sqrtPrice) && num(get(on, "liquidity")) === num(seg.liquidity), detail: on ? `${num(get(on, "sqrt_price"))}/${num(get(on, "liquidity"))}` : "missing" });
  });
  const covered = new Set(["poolFees", "collectFeeMode", "migrationOption", "activationType", "tokenType", "tokenDecimal", "partnerLiquidityPercentage", "partnerPermanentLockedLiquidityPercentage", "creatorLiquidityPercentage", "creatorPermanentLockedLiquidityPercentage", "migrationQuoteThreshold", "sqrtStartPrice", "lockedVesting", "migrationFeeOption", "tokenSupply", "creatorTradingFeePercentage", "tokenUpdateAuthority", "migrationFee", "migratedPoolFee", "poolCreationFee", "partnerLiquidityVestingInfo", "creatorLiquidityVestingInfo", "migratedPoolBaseFeeMode", "migratedPoolMarketCapFeeSchedulerParams", "enableFirstSwapWithMinFee", "compoundingFeeBps", "padding", "curve"]);
  const uncovered = Object.keys(p).filter((k) => !covered.has(k));
  out.push({ what: "every parameter compared", ok: uncovered.length === 0, detail: uncovered.length ? `uncompared: ${uncovered.join(", ")}` : `${covered.size - 1} parameter groups` });
  return out;
}

/** The state file itself: cluster, genesis, program id, the authorities and exactly the nine config names. */
export function fileChecks(file: any, exp: { clusterName: string; genesis: string; programId: string }): Check[] {
  const recorded: Record<string, string> = { ...(file.configs ?? {}), ...(file.presets ?? {}) };
  const unknown = Object.keys(recorded).filter((n) => !CONFIG_NAMES.includes(n as PresetName));
  return [
    { what: "cluster", ok: file.cluster === exp.clusterName, detail: `${file.cluster} vs ${exp.clusterName}` },
    { what: "rpc genesis", ok: exp.genesis === GENESIS[exp.clusterName], detail: exp.genesis },
    { what: "program id", ok: file.programId === exp.programId, detail: String(file.programId) },
    ...["admin", "keeper", "treasury", "protocol"].map((f) => ({ what: f, ok: typeof file[f] === "string" && file[f].length > 0, detail: String(file[f]) })),
    ...CONFIG_NAMES.map((n) => ({ what: `names ${n}`, ok: typeof recorded[n] === "string" && recorded[n].length > 0, detail: recorded[n] ?? "missing" })),
    { what: "no unknown config names", ok: unknown.length === 0, detail: unknown.join(",") || `${CONFIG_NAMES.length} names` },
  ];
}

/** The protocol account against the file: owner, admin, keeper, treasury and the stream pins. */
export function compareProtocol(owner: PublicKey, pr: any, file: any, programId: PublicKey, allowE2e: boolean): Check[] {
  const out: Check[] = [];
  out.push({ what: "protocol owner", ok: owner.equals(programId), detail: owner.toBase58() });
  for (const f of ["admin", "keeper", "treasury"]) out.push({ what: `protocol ${f}`, ok: key(pr[f]) === file[f], detail: `${key(pr[f])} vs ${file[f]}` });
  const pins = (get(pr, "stream_configs") ?? []).map(key);
  const sets: [string, any][] = [["configs", file.configs], ...(allowE2e ? [["e2e", file.e2e]] as [string, any][] : [])];
  const pinned = sets.find(([, set]) => ["stream-25", "stream-50", "stream-75"].every((n, i) => set?.[n] === pins[i]));
  out.push({ what: "protocol stream pins", ok: !!pinned, detail: pinned ? `the "${pinned[0]}" set` : `${pins.join(",")} match no set in the file` });
  return out;
}
