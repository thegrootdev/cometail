// Protocol fee claims for the owner's wallets, read from the chain and built for the wallet to sign:
// partner trading fees on our configs' DBC pools (the config's fee claimer signs), the partner's share
// of a finished curve's surplus, and the fees on the fee claimers' DAMM v2 positions (the
// position's holder signs). Every claim lands in the claimer's token account for the quote (the
// wrapped-SOL account for SOL quotes); nothing here ever closes a token account: the SDKs' builders
// append an unwrap (a close of the wrapped-SOL account) and that instruction is removed, since the
// admin's wrapped-SOL account is the protocol treasury the vault program pays into.
import { Connection, PublicKey, TransactionInstruction } from "@solana/web3.js";
import BN from "bn.js";
import { getAssociatedTokenAddressSync, NATIVE_MINT, TOKEN_PROGRAM_ID, TOKEN_2022_PROGRAM_ID } from "@solana/spl-token";
import { CpAmm, getUnClaimLpFee, getTokenProgram } from "@meteora-ag/cp-amm-sdk";
import { ADDRESSES } from "./addresses";
import { dbcClient, mintDecimals, MigrationProgress } from "./dbc";

export type ClaimKind = "dbc-partner-fee" | "dbc-partner-surplus" | "damm-position-fee";

export interface ProtocolClaim {
  id: string;
  kind: ClaimKind;
  /** Which config or pool this belongs to, for the list. */
  configLabel: string;
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
  warnings: string[];
}

const U64_MAX = new BN("18446744073709551615");

/** Our configs by label, from the addresses the site carries. */
export function ourConfigs(): { label: string; config: PublicKey }[] {
  const out: { label: string; config: PublicKey }[] = [{ label: "Standard", config: ADDRESSES.plainConfig }];
  for (const [label, key] of Object.entries(ADDRESSES.presets)) if (key) out.push({ label, config: key });
  ADDRESSES.streamConfigs.forEach((config, i) => out.push({ label: ["stream-25", "stream-50", "stream-75"][i], config }));
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
  for (const { label, config } of ourConfigs()) {
    let cfg: any;
    try { cfg = await dbc.state.getPoolConfig(config); } catch (e) { warnings.push(`${label}: config unreadable (${String((e as Error).message ?? e)})`); continue; }
    if (!cfg) { warnings.push(`${label}: config ${config.toBase58()} not found on this cluster`); continue; }
    const feeClaimer: PublicKey = cfg.feeClaimer;
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
        claims.push({ id: `fee:${pool.toBase58()}`, kind: "dbc-partner-fee", configLabel: tag, pool, baseMint, claimer: feeClaimer, quoteMint, quoteDecimals, amountQuote: partnerQuote, amountBase: partnerBase, destination, destinationExists });
      }
      const migrated = Number(state.migrationProgress) === MigrationProgress.CreatedPool;
      const surplusDone = Number(state.isPartnerWithdrawSurplus ?? 0) === 1;
      const threshold = BigInt(String(cfg.migrationQuoteThreshold ?? 0)), reserve = BigInt(String(state.quoteReserve ?? 0));
      const surplusTotal = reserve > threshold ? reserve - threshold : 0n;
      if (migrated && !surplusDone && surplusTotal > 0n) {
        claims.push({ id: `surplus:${pool.toBase58()}`, kind: "dbc-partner-surplus", configLabel: tag, pool, baseMint, claimer: feeClaimer, quoteMint, quoteDecimals, amountQuote: null, amountBase: 0n, destination, destinationExists, note: `the curve ended ${surplusTotal.toString()} raw quote units above its target; the program pays the partner's share of that` });
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
  return { claims, claimers: [...claimers.values()], claimerLamports, treasury, warnings };
}

/** SPL Token CloseAccount is instruction 9 in both token programs. */
function isCloseAccount(ix: TransactionInstruction): boolean {
  return (ix.programId.equals(TOKEN_PROGRAM_ID) || ix.programId.equals(TOKEN_2022_PROGRAM_ID)) && ix.data.length >= 1 && ix.data[0] === 9;
}

/** The claim's instructions for the claimer to sign, with every CloseAccount removed and counted. */
export async function buildProtocolClaim(connection: Connection, claim: ProtocolClaim): Promise<{ instructions: TransactionInstruction[]; removedCloses: number }> {
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
  return { instructions: kept, removedCloses: instructions.length - kept.length };
}

/** A short human line for an amount in the quote's units. */
export function formatQuote(raw: bigint | null, decimals: number, symbol: string): string {
  if (raw === null) return "amount set by the program";
  const s = raw.toString().padStart(decimals + 1, "0");
  const whole = s.slice(0, s.length - decimals), frac = s.slice(s.length - decimals).replace(/0+$/, "");
  return `${whole}${frac ? "." + frac : ""} ${symbol}`;
}
