// Protocol fee claims for the owner's wallets, read from the chain and built for the wallet to sign:
// partner trading fees on our configs' DBC pools (the config's fee claimer signs), the partner's share
// of a finished curve's surplus, and the fees on the fee claimers' DAMM v2 positions (the
// position's holder signs). Every claim lands in the claimer's token account for the quote (the
// wrapped-SOL account for SOL quotes); nothing here ever closes a token account: the SDKs' builders
// append an unwrap (a close of the wrapped-SOL account) and that instruction is removed, since the
// admin's wrapped-SOL account is the protocol treasury the vault program pays into.
import { Connection, Keypair, PublicKey, SystemProgram, Transaction, TransactionInstruction } from "@solana/web3.js";
import BN from "bn.js";
import { ACCOUNT_SIZE, createAssociatedTokenAccountIdempotentInstruction, createBurnCheckedInstruction, createCloseAccountInstruction, createInitializeAccount3Instruction, createTransferCheckedInstruction, createTransferInstruction, getAssociatedTokenAddressSync, NATIVE_MINT, TOKEN_PROGRAM_ID, TOKEN_2022_PROGRAM_ID } from "@solana/spl-token";
import { BurnClient, type BurnState } from "@cometail/client";
import { CpAmm, getUnClaimLpFee, getTokenProgram } from "@meteora-ag/cp-amm-sdk";
import { ADDRESSES, LEGACY_CONFIGS } from "./addresses";
import { dbcClient, mintDecimals, MigrationProgress } from "./dbc";
import { isPairedQuote, PAIRED_DECIMALS } from "./paired";

export type ClaimKind = "dbc-partner-fee" | "dbc-partner-surplus" | "dbc-partner-creation-fee" | "damm-position-fee";

export interface ProtocolClaim {
  id: string;
  kind: ClaimKind;
  /** Which config or pool this belongs to, for the list. */
  configLabel: string;
  /** The DBC config (curve claims). */
  config?: PublicKey;
  pool: PublicKey;
  baseMint: PublicKey;
  /** DAMM position claims only. */
  position?: PublicKey;
  positionNftAccount?: PublicKey;
  /** The wallet that must sign: the config's fee claimer, or the position NFT's holder. */
  claimer: PublicKey;
  quoteMint: PublicKey;
  quoteDecimals: number;
  /** Claimable now, in the quote's raw units; null when only the program can tell (surplus). */
  amountQuote: bigint | null;
  /** Claimable base tokens (fees collected in the base token), raw units. */
  amountBase: bigint;
  /** Where the quote lands: the claimer's token account for the quote mint. */
  destination: PublicKey;
  destinationExists: boolean;
  note?: string;
}

export interface ProtocolScan {
  claims: ProtocolClaim[];
  /** Every fee claimer found on our configs, so the page can say which wallet to connect. */
  claimers: PublicKey[];
  /** Each claimer's SOL balance in lamports: a claimer pays the fee and any new token account's rent, so an empty wallet cannot claim. */
  claimerLamports: Record<string, bigint>;
  /** The protocol treasury token account the vault program pays into: owner and balance. */
  treasury: { address: PublicKey; owner: PublicKey | null; lamports: bigint | null; exists: boolean };
  /** The burn program: live (SOL claims go through it and it splits half of what each pays to its reserve),
   *  absent (not set up: claims as before), or unavailable (its state could not be read: SOL claims are blocked). */
  burn: BurnStatus;
  warnings: string[];
}

export type BurnStatus = { status: "live"; reserve: PublicKey; claimer: PublicKey; state: BurnState } | { status: "absent" } | { status: "unavailable"; error: string };
/** The burn program's state: live, absent (no state account: not set up), or unavailable (the read failed). Never guessed. */
export async function readBurn(connection: Connection): Promise<BurnStatus> {
  const client = new BurnClient(connection);
  try {
    const info = await connection.getAccountInfo(client.a.burnState, "confirmed");
    if (!info) return { status: "absent" };
    const state = client.decodeState(info.data);
    return { status: "live", reserve: state.reserve, claimer: client.a.claimer, state };
  } catch (e) { return { status: "unavailable", error: String((e as Error).message ?? e) }; }
}

const U64_MAX = new BN("18446744073709551615");

/** Our configs by label, from the addresses the site carries. */
export function ourConfigs(): { label: string; config: PublicKey }[] {
  const out: { label: string; config: PublicKey }[] = [{ label: "Standard", config: ADDRESSES.plainConfig }];
  for (const [label, key] of Object.entries(ADDRESSES.presets)) if (key) out.push({ label, config: key });
  ADDRESSES.streamConfigs.forEach((config, i) => out.push({ label: ["stream-25", "stream-50", "stream-75"][i], config }));
  out.push(...LEGACY_CONFIGS);
  const seen = new Set<string>();
  return out.filter((c) => { const k = c.config.toBase58(); if (seen.has(k)) return false; seen.add(k); return true; });
}

/** The token program a mint lives under, from its account owner. */
async function tokenProgramOf(connection: Connection, mint: PublicKey): Promise<PublicKey> {
  if (mint.equals(NATIVE_MINT)) return TOKEN_PROGRAM_ID;
  const info = await connection.getAccountInfo(mint);
  return info && info.owner.equals(TOKEN_2022_PROGRAM_ID) ? TOKEN_2022_PROGRAM_ID : TOKEN_PROGRAM_ID;
}

export async function scanProtocolClaims(connection: Connection): Promise<ProtocolScan> {
  const warnings: string[] = [];
  const claims: ProtocolClaim[] = [];
  const claimers = new Map<string, PublicKey>();
  const decimalsCache = new Map<string, number>();
  const decimalsOf = async (mint: PublicKey) => {
    const k = mint.toBase58();
    if (mint.equals(NATIVE_MINT)) return 9;
    if (!decimalsCache.has(k)) decimalsCache.set(k, await mintDecimals(connection, mint));
    return decimalsCache.get(k)!;
  };
  const dbc = dbcClient(connection);
  const burn = await readBurn(connection);
  const burnClaimer = new BurnClient(connection).a.claimer;
  for (const { label, config } of ourConfigs()) {
    let cfg: any;
    try { cfg = await dbc.state.getPoolConfig(config); } catch (e) { warnings.push(`${label}: config unreadable (${String((e as Error).message ?? e)})`); continue; }
    if (!cfg) { warnings.push(`${label}: config ${config.toBase58()} not found on this cluster`); continue; }
    const feeClaimer: PublicKey = cfg.feeClaimer;
    // the new launch configs name the burn program's claimer: the keeper claims them through the program, which splits them itself
    if (feeClaimer.equals(burnClaimer)) { warnings.push(`${label}: claimed and split 50/50 by the burn program, not from this page`); continue; }
    claimers.set(feeClaimer.toBase58(), feeClaimer);
    const quoteMint: PublicKey = cfg.quoteMint;
    const quoteDecimals = await decimalsOf(quoteMint);
    const quoteProgram = await tokenProgramOf(connection, quoteMint);
    const destination = getAssociatedTokenAddressSync(quoteMint, feeClaimer, false, quoteProgram);
    const destinationExists = !!(await connection.getAccountInfo(destination));
    let pools: any[] = [];
    try { pools = await dbc.state.getPoolsByConfig(config); } catch (e) { warnings.push(`${label}: pools unreadable (${String((e as Error).message ?? e)})`); continue; }
    for (const p of pools) {
      const state: any = p.account?.poolState ?? p.account;
      const pool: PublicKey = p.publicKey;
      const baseMint: PublicKey = state.baseMint;
      const partnerQuote = BigInt(String(state.partnerQuoteFee ?? 0)), partnerBase = BigInt(String(state.partnerBaseFee ?? 0));
      const tag = `${label} · ${baseMint.toBase58().slice(0, 4)}…${baseMint.toBase58().slice(-4)}`;
      if (partnerQuote > 0n || partnerBase > 0n) {
        claims.push({ id: `fee:${pool.toBase58()}`, kind: "dbc-partner-fee", configLabel: tag, config, pool, baseMint, claimer: feeClaimer, quoteMint, quoteDecimals, amountQuote: partnerQuote, amountBase: partnerBase, destination, destinationExists });
      }
      // the partner's share of the pool creation fee, once per pool (DBC creation_fee_bits & 0b10)
      if (Number(cfg.poolCreationFee ?? 0) > 0 && (Number(state.creationFeeBits ?? 0) & 0b10) === 0) {
        claims.push({ id: `creation:${pool.toBase58()}`, kind: "dbc-partner-creation-fee", configLabel: tag, config, pool, baseMint, claimer: feeClaimer, quoteMint: NATIVE_MINT, quoteDecimals: 9, amountQuote: null, amountBase: 0n, destination: getAssociatedTokenAddressSync(NATIVE_MINT, feeClaimer), destinationExists: true, note: "the partner's share of the pool creation fee, paid in SOL; the program measures it" });
      }
      const migrated = Number(state.migrationProgress) === MigrationProgress.CreatedPool;
      const surplusDone = Number(state.isPartnerWithdrawSurplus ?? 0) === 1;
      const threshold = BigInt(String(cfg.migrationQuoteThreshold ?? 0)), reserve = BigInt(String(state.quoteReserve ?? 0));
      const surplusTotal = reserve > threshold ? reserve - threshold : 0n;
      if (migrated && !surplusDone && surplusTotal > 0n) {
        claims.push({ id: `surplus:${pool.toBase58()}`, kind: "dbc-partner-surplus", configLabel: tag, config, pool, baseMint, claimer: feeClaimer, quoteMint, quoteDecimals, amountQuote: null, amountBase: 0n, destination, destinationExists, note: `the curve ended ${surplusTotal.toString()} raw quote units above its target; the program pays the partner's share of that` });
      }
    }
  }
  // locked DAMM v2 positions held by a fee claimer: the migrated pools' partner positions
  const amm = new CpAmm(connection);
  for (const claimer of claimers.values()) {
    let positions: { position: PublicKey; positionNftAccount: PublicKey; positionState: any }[] = [];
    try { positions = await amm.getPositionsByUser(claimer); } catch (e) { warnings.push(`positions of ${claimer.toBase58()} unreadable (${String((e as Error).message ?? e)})`); continue; }
    for (const pos of positions) {
      let poolState: any;
      try { poolState = await amm.fetchPoolState(pos.positionState.pool); } catch { warnings.push(`pool of position ${pos.position.toBase58()} unreadable`); continue; }
      const fees = getUnClaimLpFee(poolState, pos.positionState);
      const feeA = BigInt(fees.feeTokenA.toString()), feeB = BigInt(fees.feeTokenB.toString());
      if (feeA === 0n && feeB === 0n) continue;
      const tokenA: PublicKey = poolState.tokenAMint, tokenB: PublicKey = poolState.tokenBMint;
      // the quote is the SOL side when there is one, else token B
      const quoteIsA = tokenA.equals(NATIVE_MINT);
      const quoteMint = quoteIsA ? tokenA : tokenB, baseMint = quoteIsA ? tokenB : tokenA;
      const quoteProgram = getTokenProgram(quoteIsA ? poolState.tokenAFlag : poolState.tokenBFlag);
      const destination = getAssociatedTokenAddressSync(quoteMint, claimer, false, quoteProgram);
      const destinationExists = !!(await connection.getAccountInfo(destination));
      claims.push({
        id: `position:${pos.position.toBase58()}`, kind: "damm-position-fee", configLabel: `position · ${baseMint.toBase58().slice(0, 4)}…${baseMint.toBase58().slice(-4)}`,
        pool: pos.positionState.pool, baseMint, position: pos.position, positionNftAccount: pos.positionNftAccount, claimer,
        quoteMint, quoteDecimals: await decimalsOf(quoteMint), amountQuote: quoteIsA ? feeA : feeB, amountBase: quoteIsA ? feeB : feeA, destination, destinationExists,
      });
    }
  }
  // the protocol treasury the vault program pays into
  const treasuryInfo = await connection.getParsedAccountInfo(ADDRESSES.treasury);
  const parsed: any = treasuryInfo.value?.data;
  const treasury = {
    address: ADDRESSES.treasury,
    owner: parsed?.parsed?.info?.owner ? new PublicKey(parsed.parsed.info.owner) : null,
    lamports: parsed?.parsed?.info?.tokenAmount?.amount ? BigInt(parsed.parsed.info.tokenAmount.amount) : null,
    exists: !!treasuryInfo.value,
  };
  const claimerLamports: Record<string, bigint> = {};
  for (const k of claimers.values()) claimerLamports[k.toBase58()] = BigInt(await connection.getBalance(k, "confirmed"));
  return { claims, claimers: [...claimers.values()], claimerLamports, treasury, burn, warnings };
}

/** SPL Token CloseAccount is instruction 9 in both token programs. */
function isCloseAccount(ix: TransactionInstruction): boolean {
  return (ix.programId.equals(TOKEN_PROGRAM_ID) || ix.programId.equals(TOKEN_2022_PROGRAM_ID)) && ix.data.length >= 1 && ix.data[0] === 9;
}

/** The claim's instructions for the claimer to sign.
 *  - A SOL claim while the burn program is live goes through the program's owner claim: the program measures what
 *    the claim pays and sends exactly half to the burn reserve and half to the signer's own WSOL account, in the
 *    same instruction (no amount is taken from this page's scan).
 *  - While the program is absent (not set up), or for a claim not paid in SOL, the Meteora SDK builds the claim
 *    as before, with every CloseAccount removed (the WSOL accounts stay open).
 *  - While the program's state cannot be read, a SOL claim is refused: the 50% cannot be guaranteed. */
export async function buildProtocolClaim(connection: Connection, claim: ProtocolClaim, burn: BurnStatus): Promise<{ instructions: TransactionInstruction[]; removedCloses: number; throughBurn: boolean }> {
  const sol = claim.quoteMint.equals(NATIVE_MINT);
  if (sol && burn.status === "unavailable") throw new Error(`the burn program's state could not be read (${burn.error}); a SOL claim is not built until it can be, so the 50% to the burn reserve is never skipped`);
  if (sol && burn.status === "live") {
    const client = new BurnClient(connection);
    const ownerWsol = getAssociatedTokenAddressSync(NATIVE_MINT, claim.claimer);
    const pre = [createAssociatedTokenAccountIdempotentInstruction(claim.claimer, ownerWsol, claim.claimer, NATIVE_MINT)];
    const base = { state: burn.state, owner: claim.claimer, ownerWsol };
    let ix: TransactionInstruction;
    if (claim.kind === "damm-position-fee") {
      if (!claim.position || !claim.positionNftAccount) throw new Error("position claim without a position");
      const poolState: any = await new CpAmm(connection).fetchPoolState(claim.pool);
      if (!poolState.tokenBMint.equals(NATIVE_MINT) || Number(poolState.collectFeeMode) !== 2) throw new Error("this position's pool does not pay its fees in SOL only (token B, compounding): the burn program cannot split it; claim it elsewhere and send half to the reserve with card 3");
      ix = await client.ownerClaimPositionFees({ ...base, pool: claim.pool, position: claim.position, positionNftAccount: claim.positionNftAccount, tokenAVault: poolState.tokenAVault, tokenBVault: poolState.tokenBVault, tokenAMint: poolState.tokenAMint, tokenAProgram: getTokenProgram(poolState.tokenAFlag) });
    } else {
      if (!claim.config) throw new Error("claim without its config");
      const p: any = (await dbcClient(connection).state.getPool(claim.pool)) as any;
      const ps = p?.poolState ?? p;
      if (claim.kind === "dbc-partner-fee") ix = await client.ownerClaimCurveFees({ ...base, config: claim.config, pool: claim.pool, baseVault: ps.baseVault, quoteVault: ps.quoteVault, baseMint: ps.baseMint, baseTokenProgram: await tokenProgramOf(connection, ps.baseMint) });
      else if (claim.kind === "dbc-partner-surplus") ix = await client.ownerClaimSurplus({ ...base, config: claim.config, pool: claim.pool, quoteVault: ps.quoteVault });
      else ix = await client.ownerClaimCreationFee({ ...base, config: claim.config, pool: claim.pool });
    }
    return { instructions: [...pre, ix], removedCloses: 0, throughBurn: true };
  }
  let instructions: TransactionInstruction[];
  if (claim.kind === "dbc-partner-fee") {
    const tx = await dbcClient(connection).partner.claimPartnerTradingFee({
      feeClaimer: claim.claimer, payer: claim.claimer, pool: claim.pool,
      maxBaseAmount: claim.amountBase > 0n ? new BN(claim.amountBase.toString()) : new BN(0),
      maxQuoteAmount: claim.amountQuote !== null ? new BN(claim.amountQuote.toString()) : U64_MAX,
    });
    instructions = tx.instructions;
  } else if (claim.kind === "dbc-partner-surplus") {
    const tx = await dbcClient(connection).partner.partnerWithdrawSurplus({ feeClaimer: claim.claimer, pool: claim.pool });
    instructions = tx.instructions;
  } else if (claim.kind === "dbc-partner-creation-fee") {
    const tx = await dbcClient(connection).partner.claimPartnerPoolCreationFee({ pool: claim.pool, feeReceiver: claim.claimer });
    instructions = tx.instructions;
  } else {
    if (!claim.position || !claim.positionNftAccount) throw new Error("position claim without a position");
    const amm = new CpAmm(connection);
    const poolState: any = await amm.fetchPoolState(claim.pool);
    const tx = await amm.claimPositionFee({
      owner: claim.claimer, pool: claim.pool, position: claim.position, positionNftAccount: claim.positionNftAccount,
      tokenAMint: poolState.tokenAMint, tokenBMint: poolState.tokenBMint, tokenAVault: poolState.tokenAVault, tokenBVault: poolState.tokenBVault,
      tokenAProgram: getTokenProgram(poolState.tokenAFlag), tokenBProgram: getTokenProgram(poolState.tokenBFlag),
    });
    instructions = tx.instructions;
  }
  const kept = instructions.filter((ix) => !isCloseAccount(ix));
  return { instructions: kept, removedCloses: instructions.length - kept.length, throughBurn: false };
}

/** What a paired claim ($COMETAIL quote) pays and burns: half of the $COMETAIL it pays is burned in the same transaction;
 *  the other half goes to the claimer's own $COMETAIL account (the treasury's $COMETAIL). */
export interface PairedBurn { claimed: bigint; burned: bigint; kept: bigint; exact: boolean }
/** Where each supported claim instruction pays its quote: the account index of its $COMETAIL destination. */
export const CLAIM_QUOTE_DESTINATION: Record<string, number> = {
  // DBC claim_trading_fee (the partner's curve fees): token_b_account
  [Buffer.from([8, 236, 89, 49, 152, 125, 177, 81]).toString("hex")]: 4,
  // DBC partner_withdraw_surplus: token_quote_account
  [Buffer.from([168, 173, 72, 100, 201, 98, 38, 92]).toString("hex")]: 3,
  // DAMM v2 claim_position_fee: token_b_account (a paired coin's pool has $COMETAIL as token B)
  [Buffer.from([180, 38, 154, 17, 133, 33, 162, 211]).toString("hex")]: 4,
};
/** The claim, paid into a fresh token account created in the same transaction and closed at its end. The chain itself
 *  enforces the split: the burn and the transfer to the treasury spend exactly the amount the claim was built for, from
 *  an account that held nothing before the claim, and the close fails unless that account is then empty. A claim that
 *  pays less than built (a stale scan, a claim already made) or more (fees that arrived since) fails as a whole: nothing
 *  of the treasury's earlier $COMETAIL can be burned. A curve fee claim is built for the scanned amount; any other claim
 *  (a graduated position's fees, a curve's surplus) for the amount a simulation of the claim pays now. */
export async function buildPairedClaim(connection: Connection, claim: ProtocolClaim, burn: BurnStatus): Promise<{ instructions: TransactionInstruction[]; signers: Keypair[]; removedCloses: number; pairedBurn: PairedBurn }> {
  if (!isPairedQuote(claim.quoteMint)) throw new Error("not a $COMETAIL claim");
  const built = await buildProtocolClaim(connection, claim, burn);
  const treasury = getAssociatedTokenAddressSync(claim.quoteMint, claim.claimer, false, TOKEN_PROGRAM_ID);
  if (!claim.destination.equals(treasury)) throw new Error("the claim does not land in the claimer's own $COMETAIL account");
  // the claim instruction itself, its $COMETAIL destination moved from the treasury to the fresh account
  const temp = Keypair.generate();
  let redirected = 0;
  const instructions = built.instructions.map((ix) => {
    const at = CLAIM_QUOTE_DESTINATION[Buffer.from(ix.data.subarray(0, 8)).toString("hex")];
    if (at === undefined) return ix;
    if (!ix.keys[at]?.pubkey.equals(treasury)) throw new Error("the claim's $COMETAIL destination is not the treasury's account");
    redirected++;
    return new TransactionInstruction({ programId: ix.programId, data: ix.data, keys: ix.keys.map((k, i) => (i === at ? { ...k, pubkey: temp.publicKey } : k)) });
  });
  if (redirected !== 1) throw new Error(`expected one claim instruction, found ${redirected}`);
  const rent = await connection.getMinimumBalanceForRentExemption(ACCOUNT_SIZE);
  const open = [
    createAssociatedTokenAccountIdempotentInstruction(claim.claimer, treasury, claim.claimer, claim.quoteMint),
    SystemProgram.createAccount({ fromPubkey: claim.claimer, newAccountPubkey: temp.publicKey, lamports: rent, space: ACCOUNT_SIZE, programId: TOKEN_PROGRAM_ID }),
    createInitializeAccount3Instruction(temp.publicKey, claim.quoteMint, claim.claimer),
  ];
  let claimed: bigint, exact: boolean;
  if (claim.kind === "dbc-partner-fee" && claim.amountQuote !== null) { claimed = claim.amountQuote; exact = true; }
  else {
    const tx = new Transaction().add(...open, ...instructions);
    tx.feePayer = claim.claimer; tx.recentBlockhash = (await connection.getLatestBlockhash("confirmed")).blockhash;
    const sim = await connection.simulateTransaction(tx, undefined, [temp.publicKey]);
    if (sim.value.err) throw new Error(`the claim does not simulate: ${JSON.stringify(sim.value.err)}`);
    const after = sim.value.accounts?.[0];
    if (!after) throw new Error("the simulation returned no $COMETAIL account");
    const data = Buffer.from(after.data[0], "base64");
    claimed = data.length >= 72 ? data.readBigUInt64LE(64) : 0n;
    exact = false;
  }
  if (claimed <= 0n) throw new Error("this claim pays no $COMETAIL now");
  const burned = claimed / 2n, kept = claimed - burned;
  const split = [
    ...(burned > 0n ? [createBurnCheckedInstruction(temp.publicKey, claim.quoteMint, claim.claimer, burned, PAIRED_DECIMALS)] : []),
    createTransferCheckedInstruction(temp.publicKey, claim.quoteMint, treasury, claim.claimer, kept, PAIRED_DECIMALS),
    createCloseAccountInstruction(temp.publicKey, claim.claimer, claim.claimer),
  ];
  return { instructions: [...open, ...instructions, ...split], signers: [temp], removedCloses: built.removedCloses, pairedBurn: { claimed, burned, kept, exact } };
}

/** A transfer of wrapped SOL from the owner's treasury account to the burn reserve (never a close or an unwrap). */
export function treasuryToBurnIx(treasury: PublicKey, owner: PublicKey, reserve: PublicKey, lamports: bigint): TransactionInstruction {
  return createTransferInstruction(treasury, reserve, owner, lamports);
}

/** A short human line for an amount in the quote's units. */
export function formatQuote(raw: bigint | null, decimals: number, symbol: string): string {
  if (raw === null) return "amount set by the program";
  const s = raw.toString().padStart(decimals + 1, "0");
  const whole = s.slice(0, s.length - decimals), frac = s.slice(s.length - decimals).replace(/0+$/, "");
  return `${whole}${frac ? "." + frac : ""} ${symbol}`;
}
