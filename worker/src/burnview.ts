// /api/burn: the burn program's state, history and accounting, every figure labelled by what it is.
// Exact: the program's own counters, the reserve balance, $COMETAIL's supply, every event with its
// signature, the tails' protocol share (the vaults' own counters), what reached the reserve outside
// the program's splits (by conservation: the reserve's only exit is a buyback). Snapshots: fees
// claimable now. Unknown: shown as null, never as zero.
import { PublicKey } from "@solana/web3.js";
import { BurnClient, BURN_PROGRAM_ID } from "@cometail/client";
import { Chain } from "./chain";
import { nextBuyback, readBurnState } from "./burn";
import { BURN_EVENT_NAMES, burnCoverage } from "./burnindex";
import type { FeeIndex } from "./feeindex";
import type { Store } from "./store";

const SOURCES = ["curve fee", "creation fee", "surplus", "graduated position fee", "inbox"];
const TTL_MS = 15_000;

export function burnViewer(chain: Chain, store: Store, opts: { cluster: string; burnConfigs: string[]; legacyConfigs: string[]; feeIndex: FeeIndex | null }) {
  let memo: { at: number; value: unknown } | null = null;
  return async (limit: number): Promise<unknown> => {
    if (memo && Date.now() - memo.at < TTL_MS) return memo.value;
    const client = new BurnClient(chain.connection);
    const head = { schemaVersion: 1, cluster: opts.cluster, generatedAtMs: Date.now(), program: BURN_PROGRAM_ID.toBase58(), claimer: client.a.claimer.toBase58(), sharePct: 50 };
    const coverage = await burnCoverage(store);
    let s;
    try { s = await readBurnState(chain, client); } catch { return { ...head, status: "unavailable", coverage }; }
    if (!s) return { ...head, status: "not-set-up", coverage };
    const [reserveBal, mintInfo, pool] = await Promise.all([
      chain.connection.getTokenAccountBalance(s.reserve, "confirmed").then((r) => BigInt(r.value.amount)).catch(() => null),
      chain.connection.getTokenSupply(s.cometailMint, "confirmed").then((r) => ({ supplyRaw: r.value.amount, decimals: r.value.decimals })).catch(() => null),
      (chain.damm.account as any).pool.fetch(s.pool, "confirmed").catch(() => null),
    ]);
    const n = (v: { toString(): string }) => BigInt(v.toString());
    const toReserve = n(s.splitToReserve), spent = n(s.spentTotal);
    const next = reserveBal !== null && pool ? nextBuyback(s, reserveBal, BigInt(pool.tokenBAmount.toString()), Math.floor(Date.now() / 1000)) : null;
    const events = await store.listEventsByName([BURN_EVENT_NAMES.BuybackBurned, BURN_EVENT_NAMES.FeesSplit], Math.max(1, Math.min(500, limit)) * 2);
    const burns = events.filter((e) => e.name === BURN_EVENT_NAMES.BuybackBurned).slice(0, limit).map((e) => ({
      signature: e.signature, slot: e.slot, blockTime: e.blockTime, spentLamports: String(e.data.spent), receivedRaw: String(e.data.received), burnedRaw: String(e.data.burned), minOutRaw: String(e.data.min_out),
    }));
    const splits = events.filter((e) => e.name === BURN_EVENT_NAMES.FeesSplit).slice(0, limit).map((e) => ({
      signature: e.signature, slot: e.slot, blockTime: e.blockTime, source: SOURCES[Number(e.data.source)] ?? "unknown", pool: e.data.pool === PublicKey.default.toBase58() ? null : e.data.pool,
      amountLamports: String(e.data.amount), toReserveLamports: String(e.data.to_reserve), toTreasuryLamports: String(e.data.to_treasury),
    }));
    // the tails' 1/5 protocol share, from each vault's own on-chain counter (indexed vault accounts)
    const vaults = await store.listVaults();
    const tailsShare = vaults.reduce((t, v) => t + BigInt(String(v.data?.accounting?.toProtocol ?? "0")), 0n);
    const sumPartner = (configs: string[]) => {
      if (!opts.feeIndex || !configs.length) return null;
      try { return String(opts.feeIndex.db.db.prepare(`select coalesce(sum(partner_fee), 0) as t from fi_pools where config in (${configs.map(() => "?").join(",")})`).get(...configs).t); } catch { return null; }
    };
    const value = {
      ...head, status: "live", coverage,
      setup: { pool: s.pool.toBase58(), cometailMint: s.cometailMint.toBase58(), treasury: s.treasury.toBase58(), reserve: s.reserve.toBase58(), inbox: s.inbox.toBase58(), setupBy: s.setupBy.toBase58(), feeNumerator: s.feeNumerator.toString() },
      totals: {
        claimedThroughProgramLamports: s.splitTotal.toString(), toReserveLamports: toReserve.toString(), toTreasuryLamports: s.splitToTreasury.toString(),
        spentLamports: spent.toString(), burnedRaw: s.burnedTotal.toString(), buybacks: Number(s.buybacks.toString()), lastBuyAtSec: s.lastBuyTs.toNumber() || null,
      },
      reserve: reserveBal === null ? null : { lamports: reserveBal.toString() },
      sentDirectLamports: reserveBal === null ? null : (reserveBal + spent - toReserve).toString(),
      nextBuyback: next ? { amountLamports: next.amount.toString(), dueAtSec: next.dueAtSec, due: next.due } : null,
      cometail: mintInfo ? { mint: s.cometailMint.toBase58(), ...mintInfo } : null,
      claimableNow: { programConfigsLamports: sumPartner(opts.burnConfigs), olderConfigsLamports: sumPartner(opts.legacyConfigs), basis: "DBC partner trading fees waiting in the pools now (Fee Index snapshot); graduated-pool position fees are not included" },
      commitment: {
        tailsShareLamports: tailsShare.toString(), olderConfigClaimsLamports: null,
        basis: "the program enforces the 50% split only on the configs whose fee claimer is its claimer; for the older configs and the tails' 1/5 share the owner sends 50% to the reserve, counted in sentDirectLamports. Claims made on the older configs before tracking began are not known here.",
      },
      burns, splits,
    };
    memo = { at: Date.now(), value };
    return value;
  };
}
