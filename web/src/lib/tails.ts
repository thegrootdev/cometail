// Tails on the site: chain reads and transactions for /admin/tails. The tail is launched by the owner's wallet on
// the Take 50% fee-sale config; its creator fees are claimed and split by hand in one transaction (the builders
// live in @cometail/client tail.ts, shared with the tests and the indexer). Nothing here is enforced by a program.
import { Connection, PublicKey, Transaction } from "@solana/web3.js";
import { NATIVE_MINT, getAssociatedTokenAddressSync } from "@solana/spl-token";
import { deriveDbcPoolAddress } from "@meteora-ag/dynamic-bonding-curve-sdk";
import { BurnClient, compoundingPool, createLockedPositionIxs, tailCashoutIxs, tailClaimIxs, tailMakeUpIxs, tailMakeUpMemo, type CompoundingPool } from "@cometail/client";
import type { TailInfo } from "./api";
import { cpAmm } from "./damm";
import { dbcState, derivedDammPool, MigrationProgress } from "./dbc";
import { ADDRESSES, COMETAIL_POOL } from "./addresses";

/** Tails launch on the Take 50% fee-sale config: the creator's graduation payout is 50% of the raise. */
export const TAIL_CONFIG = ADDRESSES.streamConfigs[1];
export const TAIL_TAKE_PCT = 50;
export const tailCurveOf = (mint: PublicKey) => deriveDbcPoolAddress(NATIVE_MINT, mint, TAIL_CONFIG);

export type TailChain = {
  curve: PublicKey; state: any | null; stage: "curve" | "complete" | "graduated" | "missing";
  isCreator: boolean; claimable: bigint;
  migrationFeePending: boolean; surplusPending: boolean;
  target: CompoundingPool | null; targetError: string;
  positions: { position: PublicKey; nftAccount: PublicKey; locked: bigint; unlocked: bigint }[];
  graduated: { pool: PublicKey; position: PublicKey; nftAccount: PublicKey; pendingLamports: bigint; tokenAVault: PublicKey; tokenBVault: PublicKey } | null;
};

/** Everything the admin page shows for one tail, read from the chain for the connected wallet. */
export async function readTail(connection: Connection, wallet: PublicKey, mint: PublicKey): Promise<TailChain> {
  const curve = tailCurveOf(mint);
  const amm = cpAmm(connection);
  const raw: any = await dbcState(connection).getPool(curve);
  const state = raw ? (raw.poolState ?? raw) : null;
  let target: CompoundingPool | null = null, targetError = "";
  let positions: TailChain["positions"] = [];
  if (!COMETAIL_POOL) targetError = "the site has no NEXT_PUBLIC_COMETAIL_POOL";
  else {
    try { target = compoundingPool(COMETAIL_POOL, await amm.fetchPoolState(COMETAIL_POOL)); } catch (e: any) { targetError = String(e?.message ?? e); }
    const mine = await amm.getUserPositionByPool(COMETAIL_POOL, wallet);
    positions = mine.map((p: any) => ({ position: p.position, nftAccount: p.positionNftAccount, locked: BigInt(p.positionState.permanentLockedLiquidity.toString()), unlocked: BigInt(p.positionState.unlockedLiquidity.toString()) }));
  }
  if (!state) return { curve, state: null, stage: "missing", isCreator: false, claimable: 0n, migrationFeePending: false, surplusPending: false, target, targetError, positions, graduated: null };
  const progress = Number(state.migrationProgress);
  const stage = progress === MigrationProgress.CreatedPool ? "graduated" : progress === MigrationProgress.PreBondingCurve ? "curve" : "complete";
  let graduated: TailChain["graduated"] = null;
  if (stage === "graduated") {
    const pool = derivedDammPool(mint);
    const ps: any = await amm.fetchPoolState(pool).catch(() => null);
    const own = ps ? await amm.getUserPositionByPool(pool, wallet) : [];
    if (ps && own.length) {
      const { getUnClaimLpFee } = await import("@meteora-ag/cp-amm-sdk");
      let pending = 0n;
      try { pending = BigInt(getUnClaimLpFee(ps, own[0].positionState).feeTokenB.toString()); } catch { /* unreadable */ }
      graduated = { pool, position: own[0].position, nftAccount: own[0].positionNftAccount, pendingLamports: pending, tokenAVault: ps.tokenAVault, tokenBVault: ps.tokenBVault };
    }
  }
  return {
    curve, state, stage, isCreator: new PublicKey(state.creator).equals(wallet), claimable: BigInt(state.creatorQuoteFee.toString()),
    migrationFeePending: stage !== "curve" && (Number(state.migrationFeeWithdrawStatus) & 0b010) === 0,
    surplusPending: stage !== "curve" && Number(state.isCreatorWithdrawSurplus) === 0,
    target, targetError, positions, graduated,
  };
}

const tx = (feePayer: PublicKey, ixs: any[]) => { const t = new Transaction().add(...ixs); t.feePayer = feePayer; return t; };

export function lockedPositionTx(owner: PublicKey, nftMint: PublicKey, tailMint: PublicKey, target: CompoundingPool) {
  const built = createLockedPositionIxs({ owner, pool: target.pool, nftMint, tokenAMint: target.tokenAMint, tokenAProgram: target.tokenAProgram, tailMint });
  return { tx: tx(owner, built.ixs), position: built.position };
}

export function claimTx(creator: PublicKey, mint: PublicKey, t: TailChain, position: { position: PublicKey; nftAccount: PublicKey }) {
  if (!t.target || !t.state) throw new Error("tail or target pool unreadable");
  const burn = new BurnClient();
  const built = tailClaimIxs({
    creator, claimable: t.claimable, reserve: burn.a.reserve, x: t.target, locked: position,
    curve: { pool: t.curve, baseMint: mint, baseVault: new PublicKey(t.state.baseVault), quoteVault: new PublicKey(t.state.quoteVault) },
  });
  return { tx: tx(creator, built.ixs), built };
}

/** The one-time make-up of a curve claim that was not split: tailSplit's quarters of its amount, from the wallet's SOL. */
export function makeUpTx(creator: PublicKey, mint: PublicKey, t: TailChain, claim: { signature: string; claimedLamports: string }, position: { position: PublicKey; nftAccount: PublicKey }) {
  if (!t.target) throw new Error("target pool unreadable");
  const burn = new BurnClient();
  const built = tailMakeUpIxs({ creator, tailMint: mint, claimSignature: claim.signature, claimedLamports: BigInt(claim.claimedLamports), reserve: burn.a.reserve, x: t.target, locked: position });
  return { tx: tx(creator, built.ixs), built };
}

/** Why a claim cannot be made up now, from the worker's record of this tail (null: it can). The record must be this
 *  tail's, from a worker that records make-ups, with the whole history read; the claim a curve claim, not split,
 *  of exactly this amount, with no make-up of any kind on record. */
export function makeUpBlocked(rec: TailInfo | null, mint: string, claim: { signature: string; claimedLamports: string }): string | null {
  if (!rec) return "the worker's record of this tail is unreadable";
  if (rec.mint !== mint) return "the worker's record is another tail's";
  if (!Array.isArray(rec.makeUps)) return "the worker does not record make-ups yet (restart it on this release first)";
  if (rec.coverage.claims.status !== "complete") return "the worker has not finished reading this tail's history";
  const c = rec.claims.find((x) => x.signature === claim.signature && x.source === "curve");
  if (!c) return "the worker does not list this claim as a curve claim of this tail";
  if (c.status !== "unsplit" || c.makeUp) return "this claim is not waiting for a make-up";
  if (c.claimedLamports !== claim.claimedLamports) return "the claim's amount differs from the worker's record";
  if (rec.makeUps.some((m) => m.claim === claim.signature)) return "a make-up of this claim is already on record";
  return null;
}

/** A make-up of this claim that landed, found in the wallet's own history since the claim (each signature carries
 *  its memo's text); the worker's record is not needed for this, so a make-up it has not read yet still counts. */
export async function makeUpOnChain(connection: Connection, wallet: PublicKey, mint: PublicKey, claimSignature: string): Promise<string | null> {
  const needle = tailMakeUpMemo(mint, claimSignature);
  let before: string | undefined;
  for (;;) {
    const page = await connection.getSignaturesForAddress(wallet, { before, until: claimSignature, limit: 1000 }, "confirmed");
    for (const s of page) if (!s.err && s.memo?.includes(needle)) return s.signature;
    if (page.length < 1000) return null;
    before = page[page.length - 1].signature;
  }
}

export function cashoutTx(creator: PublicKey, mint: PublicKey, t: TailChain) {
  if (!t.state) throw new Error("tail unreadable");
  return tx(creator, tailCashoutIxs({ creator, config: TAIL_CONFIG, curve: { pool: t.curve, baseMint: mint, baseVault: new PublicKey(t.state.baseVault), quoteVault: new PublicKey(t.state.quoteVault) }, migrationFeePending: t.migrationFeePending, surplusPending: t.surplusPending }));
}

/** After graduation: the tail's own creator position fees through the burn program's owner claim (half to the reserve). */
export async function graduatedClaimTx(connection: Connection, creator: PublicKey, mint: PublicKey, t: TailChain) {
  if (!t.graduated) throw new Error("no graduated position held by this wallet");
  const burn = new BurnClient(connection);
  const info = await connection.getAccountInfo(burn.a.burnState);
  if (!info) throw new Error("burn program state unreadable");
  const state = burn.decodeState(info.data);
  const ownerWsol = getAssociatedTokenAddressSync(NATIVE_MINT, creator);
  const g = t.graduated;
  return tx(creator, [await burn.ownerClaimPositionFees({ state, owner: creator, ownerWsol, pool: g.pool, position: g.position, positionNftAccount: g.nftAccount, tokenAVault: g.tokenAVault, tokenBVault: g.tokenBVault, tokenAMint: mint })]);
}
