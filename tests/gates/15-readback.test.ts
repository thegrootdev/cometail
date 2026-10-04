// The mainnet readback cannot pass silently: every parameter group, every authority, the
// protocol pins and the state file's completeness each fail on their own when mutated.
import { expect } from "chai";
import { getAssociatedTokenAddressSync, NATIVE_MINT } from "@solana/spl-token";
import { PublicKey, Keypair } from "@solana/web3.js";
import { configParams } from "../harness/dbc";
import { CONFIG_NAMES, GENESIS, configAuthorities, authorityChecks, compareConfig, compareProtocol, fileChecks } from "../mainnet/readback";

const ADMIN = Keypair.generate().publicKey, KEEPER = Keypair.generate().publicKey, TREASURY = Keypair.generate().publicKey;
const WSOL = "So11111111111111111111111111111111111111112";
const bn = (v: any) => ({ toString: () => String(v?.toString?.() ?? v) });
const schedulerBytes = (s: any) => { const b = Buffer.alloc(16); b.writeUInt16LE(s.numberOfPeriod, 0); b.writeUInt16LE(s.sqrtPriceStepBps, 2); b.writeUInt32LE(s.schedulerExpirationDuration, 4); b.writeBigUInt64LE(BigInt(String(s.reductionFactor)), 8); return [...b]; };

/** What DBC's create_config writes for these parameters, in the IDL's snake_case layout. */
function onchainOf(p: any, admin: PublicKey, quote: string, is2022: boolean): any {
  const vest = (v: any) => ({ is_initialized: v.vestingPercentage ? 1 : 0, vesting_percentage: v.vestingPercentage, bps_per_period: v.bpsPerPeriod, number_of_periods: v.numberOfPeriods, frequency: v.frequency, cliff_duration_from_migration_time: v.cliffDurationFromMigrationTime });
  const curve = p.curve.map((s: any) => ({ sqrt_price: bn(s.sqrtPrice), liquidity: bn(s.liquidity) }));
  while (curve.length < 20) curve.push({ sqrt_price: bn(0), liquidity: bn(0) });
  return {
    quote_mint: new PublicKey(quote), fee_claimer: admin, leftover_receiver: admin, quote_token_flag: is2022 ? 1 : 0,
    pool_fees: { base_fee: { cliff_fee_numerator: bn(p.poolFees.baseFee.cliffFeeNumerator), first_factor: p.poolFees.baseFee.firstFactor, second_factor: bn(p.poolFees.baseFee.secondFactor), third_factor: bn(p.poolFees.baseFee.thirdFactor), base_fee_mode: p.poolFees.baseFee.baseFeeMode }, dynamic_fee: { initialized: p.poolFees.dynamicFee ? 1 : 0 } },
    collect_fee_mode: p.collectFeeMode, migration_option: p.migrationOption, activation_type: p.activationType, token_type: p.tokenType, token_decimal: p.tokenDecimal,
    partner_liquidity_percentage: p.partnerLiquidityPercentage, partner_permanent_locked_liquidity_percentage: p.partnerPermanentLockedLiquidityPercentage,
    creator_liquidity_percentage: p.creatorLiquidityPercentage, creator_permanent_locked_liquidity_percentage: p.creatorPermanentLockedLiquidityPercentage,
    migration_quote_threshold: bn(p.migrationQuoteThreshold), sqrt_start_price: bn(p.sqrtStartPrice), migration_fee_option: p.migrationFeeOption,
    creator_trading_fee_percentage: p.creatorTradingFeePercentage, token_update_authority: p.tokenUpdateAuthority, pool_creation_fee: bn(p.poolCreationFee), migrated_pool_base_fee_mode: p.migratedPoolBaseFeeMode,
    locked_vesting_config: { amount_per_period: bn(p.lockedVesting.amountPerPeriod), cliff_duration_from_migration_time: bn(p.lockedVesting.cliffDurationFromMigrationTime), frequency: bn(p.lockedVesting.frequency), number_of_period: bn(p.lockedVesting.numberOfPeriod), cliff_unlock_amount: bn(p.lockedVesting.cliffUnlockAmount) },
    fixed_token_supply_flag: p.tokenSupply ? 1 : 0, pre_migration_token_supply: bn(p.tokenSupply?.preMigrationTokenSupply ?? 0), post_migration_token_supply: bn(p.tokenSupply?.postMigrationTokenSupply ?? 0),
    migration_fee_percentage: p.migrationFee.feePercentage, creator_migration_fee_percentage: p.migrationFee.creatorFeePercentage,
    migrated_collect_fee_mode: p.migratedPoolFee.collectFeeMode, migrated_dynamic_fee: p.migratedPoolFee.dynamicFee, migrated_pool_fee_bps: p.migratedPoolFee.poolFeeBps,
    migrated_compounding_fee_bps: p.compoundingFeeBps, enable_first_swap_with_min_fee: p.enableFirstSwapWithMinFee ? 1 : 0, migrated_pool_base_fee_bytes: schedulerBytes(p.migratedPoolMarketCapFeeSchedulerParams),
    partner_liquidity_vesting_info: vest(p.partnerLiquidityVestingInfo), creator_liquidity_vesting_info: vest(p.creatorLiquidityVestingInfo), curve,
  };
}
const failures = (checks: { ok: boolean; what: string; detail: string }[]) => checks.filter((c) => !c.ok).map((c) => `${c.what} ${c.detail}`);

describe("mainnet readback", () => {
  before(() => { process.env.COMETAIL_QUOTE_USDC = Keypair.generate().publicKey.toBase58(); process.env.COMETAIL_QUOTE_STOCK = Keypair.generate().publicKey.toBase58(); });

  it("passes a faithful account for every preset and fails each mutated field on its own", () => {
    const mutations: [string, (c: any) => void][] = [
      ["fee claimer", (c) => { c.fee_claimer = KEEPER; }],
      ["leftover receiver", (c) => { c.leftover_receiver = KEEPER; }],
      ["quote token flag", (c) => { c.quote_token_flag = 1 - c.quote_token_flag; }],
      ["base fee cliff numerator", (c) => { c.pool_fees.base_fee.cliff_fee_numerator = bn(1); }],
      ["dynamic fee initialized", (c) => { c.pool_fees.dynamic_fee.initialized = 1 - c.pool_fees.dynamic_fee.initialized; }],
      ["migration quote threshold", (c) => { c.migration_quote_threshold = bn(1); }],
      ["token update authority", (c) => { c.token_update_authority = 9; }],
      ["fixed token supply flag", (c) => { c.fixed_token_supply_flag = 1 - c.fixed_token_supply_flag; }],
      ["pre migration token supply", (c) => { c.pre_migration_token_supply = bn(1); }],
      ["post migration token supply", (c) => { c.post_migration_token_supply = bn(1); }],
      ["migrated collect fee mode", (c) => { c.migrated_collect_fee_mode = 9; }],
      ["migrated pool fee bps", (c) => { c.migrated_pool_fee_bps = 1; }],
      ["migrated compounding fee bps", (c) => { c.migrated_compounding_fee_bps = 1; }],
      ["migrated dynamic fee", (c) => { c.migrated_dynamic_fee = 9; }],
      ["locked vesting amount_per_period", (c) => { c.locked_vesting_config.amount_per_period = bn(1); }],
      ["partner liquidity percentage", (c) => { c.partner_liquidity_percentage = (c.partner_liquidity_percentage + 1) % 100; }],
      ["creator permanent locked liquidity percentage", (c) => { c.creator_permanent_locked_liquidity_percentage = (c.creator_permanent_locked_liquidity_percentage + 1) % 100; }],
      ["partner liquidity vesting vesting_percentage", (c) => { c.partner_liquidity_vesting_info.vesting_percentage = (c.partner_liquidity_vesting_info.vesting_percentage + 1) % 100; }],
      ["enable first swap with min fee", (c) => { c.enable_first_swap_with_min_fee = 1 - c.enable_first_swap_with_min_fee; }],
      ["migrated pool fee scheduler bytes", (c) => { c.migrated_pool_base_fee_bytes[0] = 7; }],
      ["migration fee percentage", (c) => { c.migration_fee_percentage = (c.migration_fee_percentage + 1) % 100; }],
      ["activation type", (c) => { c.activation_type = 1 - c.activation_type; }],
      ["curve segment 1", (c) => { c.curve[0].liquidity = bn(1); }],
      ["curve points", (c) => { c.curve[c.curve.findIndex((s: any) => s.liquidity.toString() === "0")] = { sqrt_price: bn(5), liquidity: bn(5) }; }],
    ];
    for (const name of CONFIG_NAMES) {
      const p = configParams(name);
      const quote = name === "stock-usdc" ? process.env.COMETAIL_QUOTE_USDC! : name === "stock-xstock" ? process.env.COMETAIL_QUOTE_STOCK! : WSOL;
      const owner = new PublicKey(configAuthorities(name, ADMIN.toBase58(), TREASURY.toBase58()).feeClaimer);
      const exp = { quoteMint: quote, quoteIs2022: name === "stock-xstock", ...configAuthorities(name, ADMIN.toBase58(), TREASURY.toBase58()) };
      expect(failures(compareConfig(onchainOf(p, owner, quote, name === "stock-xstock"), p, exp)), name).to.deep.equal([]);
      for (const [what, mutate] of mutations) {
        const c = onchainOf(p, owner, quote, name === "stock-xstock");
        mutate(c);
        const bad = failures(compareConfig(c, p, exp));
        expect(bad.some((f) => f.startsWith(what)), `${name}: mutating ${what} must fail that check, got ${bad.join("; ") || "nothing"}`).to.equal(true);
      }
      expect(failures(compareConfig(onchainOf(p, owner, quote, name === "stock-xstock"), p, { ...exp, quoteMint: KEEPER.toBase58() }))[0]).to.match(/^quote mint/);
      const extra = { ...p, newSdkField: 1 };
      expect(failures(compareConfig(onchainOf(p, owner, quote, name === "stock-xstock"), extra, exp))).to.deep.equal(["every parameter compared uncompared: newSdkField"]);
    }
  });

  it("assigns only the three stream configs to admin, including plain among the six treasury configs", () => {
    const streams = ["stream-25", "stream-50", "stream-75"];
    for (const name of CONFIG_NAMES) {
      const expected = (streams.includes(name) ? ADMIN : TREASURY).toBase58();
      expect(configAuthorities(name, ADMIN.toBase58(), TREASURY.toBase58())).to.deep.equal({ feeClaimer: expected, leftoverReceiver: expected });
    }
    const layout = { admin: ADMIN.toBase58(), treasuryOwner: TREASURY.toBase58(), keeper: KEEPER.toBase58() };
    expect(failures(authorityChecks(layout))).to.deep.equal([]);
    expect(failures(authorityChecks({ ...layout, treasuryOwner: layout.admin }))).to.have.length(1);
    expect(failures(authorityChecks({ ...layout, keeper: layout.treasuryOwner }))).to.have.length(1);
    expect(failures(authorityChecks({ ...layout, treasuryOwner: "" }))).not.to.have.length(0);
    expect(failures(authorityChecks({ ...layout, treasuryOwner: "11111111111111111111111111111111" }))).not.to.have.length(0);
  });

  it("requires the exact nine names, the protocol, the cluster and the program id in the state file", () => {
    const programId = Keypair.generate().publicKey.toBase58();
    const full: any = { cluster: "mainnet-beta", programId, admin: ADMIN.toBase58(), keeper: KEEPER.toBase58(), treasuryOwner: TREASURY.toBase58(), treasury: getAssociatedTokenAddressSync(NATIVE_MINT, ADMIN).toBase58(), protocol: Keypair.generate().publicKey.toBase58(), configs: {}, presets: {} };
    for (const n of CONFIG_NAMES) (["stream-25", "stream-50", "stream-75", "plain"].includes(n) ? full.configs : full.presets)[n] = Keypair.generate().publicKey.toBase58();
    const exp = { clusterName: "mainnet-beta", genesis: GENESIS["mainnet-beta"], programId, admin: ADMIN.toBase58(), treasuryOwner: TREASURY.toBase58() };
    expect(failures(fileChecks(full, exp))).to.deep.equal([]);
    expect(failures(fileChecks({ cluster: "mainnet-beta", configs: {}, presets: {} }, exp)).length).to.be.greaterThan(12);
    expect(failures(fileChecks({ ...full, treasuryOwner: undefined }, exp)).some((x) => x.startsWith("recorded treasury owner"))).to.equal(true);
    expect(failures(fileChecks({ ...full, treasuryOwner: full.admin }, exp)).some((x) => x.startsWith("recorded treasury owner"))).to.equal(true);
    expect(failures(fileChecks(full, { ...exp, treasuryOwner: undefined })).length).to.be.greaterThan(0);
    expect(failures(fileChecks({ ...full, treasury: getAssociatedTokenAddressSync(NATIVE_MINT, TREASURY).toBase58() }, exp)).some((x) => x.startsWith("protocol treasury ATA"))).to.equal(true);
    expect(failures(fileChecks({ ...full, cluster: "devnet", treasuryOwner: undefined }, { clusterName: "devnet", genesis: GENESIS.devnet, programId }))).to.deep.equal([]);
    const noStock = JSON.parse(JSON.stringify(full)); delete noStock.presets["stock-xstock"];
    expect(failures(fileChecks(noStock, exp))).to.deep.equal(["names stock-xstock missing"]);
    const noProtocol = { ...full, protocol: undefined };
    expect(failures(fileChecks(noProtocol, exp))).to.deep.equal(["protocol undefined"]);
    expect(failures(fileChecks(full, { ...exp, genesis: GENESIS.devnet }))[0]).to.match(/^rpc genesis/);
    expect(failures(fileChecks({ ...full, cluster: "devnet" }, exp))[0]).to.match(/^cluster/);
    expect(failures(fileChecks({ ...full, programId: KEEPER.toBase58() }, exp))[0]).to.match(/^program id/);
    expect(failures(fileChecks({ ...full, presets: { ...full.presets, "stock-xstock-old": full.presets.plain } }, exp))[0]).to.match(/^no unknown config names/);
  });

  it("checks the protocol's owner, authorities and pins, and accepts the e2e set only off mainnet", () => {
    const programId = Keypair.generate().publicKey;
    const pins = [1, 2, 3].map(() => Keypair.generate().publicKey);
    const e2e = [1, 2, 3].map(() => Keypair.generate().publicKey);
    const file = { admin: ADMIN.toBase58(), keeper: KEEPER.toBase58(), treasury: TREASURY.toBase58(), configs: { "stream-25": pins[0].toBase58(), "stream-50": pins[1].toBase58(), "stream-75": pins[2].toBase58() }, e2e: { "stream-25": e2e[0].toBase58(), "stream-50": e2e[1].toBase58(), "stream-75": e2e[2].toBase58() } };
    const pr = { admin: ADMIN, keeper: KEEPER, treasury: TREASURY, stream_configs: pins };
    expect(failures(compareProtocol(programId, pr, file, programId, false))).to.deep.equal([]);
    expect(failures(compareProtocol(KEEPER, pr, file, programId, false))[0]).to.match(/^protocol owner/);
    expect(failures(compareProtocol(programId, { ...pr, keeper: ADMIN }, file, programId, false))[0]).to.match(/^protocol keeper/);
    expect(failures(compareProtocol(programId, { ...pr, treasury: ADMIN }, file, programId, false))[0]).to.match(/^protocol treasury/);
    expect(failures(compareProtocol(programId, { ...pr, stream_configs: e2e }, file, programId, true))).to.deep.equal([]);
    expect(failures(compareProtocol(programId, { ...pr, stream_configs: e2e }, file, programId, false))[0]).to.match(/^protocol stream pins/);
  });
});
