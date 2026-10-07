// The burn program's crank, run by the keeper: claims the protocol fees owed to the program's claimer
// (the fee claimer of the launch configs created for it), which the program splits 50/50 to the burn
// reserve and the treasury, then a buyback when one is due. Every instruction is permissionless and
// pays nothing to its caller: the keeper only pays the network fee. Nothing here chooses an amount,
// a price or a destination; the program computes all three from the state it reads.
import { BorshCoder, EventParser } from "@coral-xyz/anchor";
import { PublicKey } from "@solana/web3.js";
import { NATIVE_MINT } from "@solana/spl-token";
import { BurnClient, BURN_IDL, BURN_PROGRAM_ID, type BurnState } from "@cometail/client";
import { deriveDammV2PoolAddress } from "@meteora-ag/dynamic-bonding-curve-sdk";
import { getUnClaimLpFee } from "@meteora-ag/cp-amm-sdk";
import { Chain, DAMM_V2_MIGRATION_CONFIGS, DBC_PROGRAM_ID, DBC_PROGRESS } from "./chain";
import type { KeeperContext } from "./keeper";
import { log, sendTx } from "./tx";

/** Mirrors the program's constants (programs/cometail_burn/src/constants.rs). */
export const BURN = { cooldownSeconds: 600, minBuyLamports: 1_000_000n, capDivisor: 5n, feeDenominator: 1_000_000_000n, partnerCreationFeeClaimedMask: 0b10 } as const;

export const burnParser = new EventParser(BURN_PROGRAM_ID, new BorshCoder(BURN_IDL));

export async function readBurnState(chain: Chain, client = new BurnClient(chain.connection)): Promise<BurnState | null> {
  const info = await chain.connection.getAccountInfo(client.a.burnState, "confirmed");
  return info ? client.decodeState(info.data) : null;
}

/** The chunk the next buyback would spend, and whether one is due now (the program decides; this only avoids a doomed send). */
export function nextBuyback(s: BurnState, reserveLamports: bigint, poolSol: bigint, nowSec: number): { amount: bigint; due: boolean; dueAtSec: number } {
  const cap = (poolSol * BigInt(s.feeNumerator.toString())) / BURN.feeDenominator / BURN.capDivisor;
  const amount = reserveLamports < cap ? reserveLamports : cap;
  const dueAtSec = s.lastBuyTs.toNumber() + BURN.cooldownSeconds;
  return { amount, due: amount >= BURN.minBuyLamports && nowSec >= dueAtSec, dueAtSec };
}

export async function burnPass(ctx: KeeperContext): Promise<void> {
  const { chain, cfg, keeper } = ctx;
  if (!cfg.burnConfigs?.length) return;
  const client = new BurnClient(chain.connection);
  const state = await readBurnState(chain, client);
  if (!state) { log("burn program not set up yet; nothing to claim or buy"); return; }
  const send = (label: string, ix: any, cu = 300_000) => sendTx({ connection: chain.connection, payer: keeper, ixs: [ix], cu, cuPrice: cfg.cuPriceMicroLamports, parser: burnParser, dryRun: cfg.dryRun, label });
  const min = cfg.burnMinClaimLamports;
  const disc = chain.dbc.coder.accounts.memcmp("virtualPool") as { offset: number; bytes: string };
  for (const config of cfg.burnConfigs) {
    const found = await chain.connection.getProgramAccounts(DBC_PROGRAM_ID, { commitment: "confirmed", filters: [{ memcmp: disc }, { memcmp: { offset: 72, bytes: config.toBase58() } }] });
    for (const a of found) {
      const pool = a.pubkey;
      const p = chain.dbc.coder.accounts.decode("virtualPool", a.account.data).poolState;
      try {
        if (BigInt(p.partnerQuoteFee.toString()) >= min) {
          await send(`burn claim_curve_fees ${pool.toBase58()}`, await client.claimCurveFees({ state, config, pool, baseVault: p.baseVault, quoteVault: p.quoteVault, baseMint: p.baseMint }));
        }
        if ((Number(p.creationFeeBits) & BURN.partnerCreationFeeClaimedMask) === 0) {
          await send(`burn claim_creation_fee ${pool.toBase58()}`, await client.claimCreationFee({ state, config, pool }));
        }
        if (Number(p.migrationProgress) === DBC_PROGRESS.createdPool) {
          const cfgState = await (chain.dbc.account as any).poolConfig.fetch(config, "confirmed");
          const surplus = BigInt(p.quoteReserve.toString()) - BigInt(cfgState.migrationQuoteThreshold.toString());
          if (Number(p.isPartnerWithdrawSurplus) === 0 && surplus >= min) {
            await send(`burn claim_surplus ${pool.toBase58()}`, await client.claimSurplus({ state, config, pool, quoteVault: p.quoteVault }));
          }
          const dammPool = deriveDammV2PoolAddress(DAMM_V2_MIGRATION_CONFIGS[Number(cfgState.migrationFeeOption)], p.baseMint, NATIVE_MINT);
          const dp: any = await (chain.damm.account as any).pool.fetchNullable(dammPool, "confirmed");
          if (!dp) continue;
          for (const pos of await chain.positionsOwnedBy(dammPool, client.a.claimer)) {
            let pending = 0n;
            try { pending = BigInt(getUnClaimLpFee(dp, pos.state).feeTokenB.toString()); } catch { /* unreadable: skip this pass */ }
            if (pending < min) continue;
            await send(`burn claim_position_fees ${pos.position.toBase58()}`, await client.claimPositionFees({ state, pool: dammPool, position: pos.position, positionNftAccount: pos.nftAccount, tokenAVault: dp.tokenAVault, tokenBVault: dp.tokenBVault, tokenAMint: dp.tokenAMint }));
          }
        }
      } catch (e) { log("burn claim failed", { pool: pool.toBase58(), error: String((e as Error).message ?? e) }); }
    }
  }
  // anything sent to the inbox directly is split the same way
  const inbox = await chain.connection.getTokenAccountBalance(state.inbox, "confirmed").catch(() => null);
  if (inbox && BigInt(inbox.value.amount) >= min) await send("burn sweep_inbox", await client.sweepInbox({ state }));
  // the buyback, when one is due
  const fresh = (await readBurnState(chain, client)) ?? state;
  const reserve = BigInt((await chain.connection.getTokenAccountBalance(fresh.reserve, "confirmed")).value.amount);
  const pool: any = await (chain.damm.account as any).pool.fetch(fresh.pool, "confirmed");
  const next = nextBuyback(fresh, reserve, BigInt(pool.tokenBAmount.toString()), Math.floor(Date.now() / 1000));
  if (next.due) await send("burn buyback", await client.buyback({ state: fresh, tokenAVault: pool.tokenAVault, tokenBVault: pool.tokenBVault }), 400_000);
}
