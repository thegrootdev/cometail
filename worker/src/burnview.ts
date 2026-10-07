// /api/burn: the burn program's state, history and accounting, every figure labelled by what it is.
// One RPC read (getMultipleAccounts with its context slot) gives the program state, the reserve, the
// $COMETAIL mint and the pool together, so conservation (what reached the reserve outside the program's
// splits = reserve + spent - to-reserve) compares numbers from the same slot. Provenance (what claims paid,
// by program configs and by owners, and what was carried in the inbox) comes from the indexed events and is
// exact only when the history is complete (`coverage`). Unknown is null, never zero.
import { PublicKey } from "@solana/web3.js";
import { AccountLayout, MintLayout } from "@solana/spl-token";
import { BurnClient, BURN_PROGRAM_ID } from "@cometail/client";
import { Chain } from "./chain";
import { nextBuyback } from "./burn";
import { BURN_EVENT_NAMES, burnCoverage } from "./burnindex";
import type { FeeIndex } from "./feeindex";
import type { EventRow, Store } from "./store";

const SOURCES = ["curve fee", "creation fee", "surplus", "graduated position fee", "inbox"];
const TTL_MS = 15_000;
const DEFAULT_KEY = PublicKey.default.toBase58();
export const BURN_PAGE = 50;

export const burnRow = (e: EventRow) => ({ signature: e.signature, slot: e.slot, idx: e.idx, blockTime: e.blockTime, spentLamports: String(e.data.spent), receivedRaw: String(e.data.received), burnedRaw: String(e.data.burned), minOutRaw: String(e.data.min_out) });
export const splitRow = (e: EventRow) => ({
  signature: e.signature, slot: e.slot, idx: e.idx, blockTime: e.blockTime, source: SOURCES[Number(e.data.source)] ?? "unknown", pool: e.data.pool === DEFAULT_KEY ? null : e.data.pool,
  claimant: e.data.claimant === DEFAULT_KEY ? null : e.data.claimant, claimedLamports: String(e.data.claimed), carriedLamports: String(e.data.carried),
  toReserveLamports: String(e.data.to_reserve), toOtherLamports: String(e.data.to_other), other: e.data.other,
});
export const cursorOf = (e: EventRow | undefined) => (e ? `${e.slot}:${e.idx}:${e.signature}` : null);
export function parseBurnCursor(v: string | null): { slot: number; idx: number; signature: string } | null | "invalid" {
  if (!v) return null;
  const m = v.match(/^(\d+):(\d+):([1-9A-HJ-NP-Za-km-z]{64,90})$/);
  return m ? { slot: Number(m[1]), idx: Number(m[2]), signature: m[3] } : "invalid";
}

/** A page of one event kind, newest first, for "every burn" and "every split". */
export async function burnHistory(store: Store, kind: "burns" | "splits", before: { slot: number; idx: number; signature: string } | null, limit: number) {
  const name = kind === "burns" ? BURN_EVENT_NAMES.BuybackBurned : BURN_EVENT_NAMES.ClaimSplit;
  const rows = await store.listBurnEvents(name, limit, before);
  return { kind, total: await store.countBurnEvents(name), items: kind === "burns" ? rows.map(burnRow) : rows.map(splitRow), nextCursor: rows.length === limit ? cursorOf(rows[rows.length - 1]) : null, coverage: await burnCoverage(store) };
}

export function burnViewer(chain: Chain, store: Store, opts: { cluster: string; burnConfigs: string[]; legacyConfigs: string[]; feeIndex: FeeIndex | null }) {
  let memo: { at: number; value: unknown } | null = null;
  return async (): Promise<unknown> => {
    if (memo && Date.now() - memo.at < TTL_MS) return memo.value;
    const client = new BurnClient(chain.connection);
    const head = { schemaVersion: 1, cluster: opts.cluster, generatedAtMs: Date.now(), program: BURN_PROGRAM_ID.toBase58(), claimer: client.a.claimer.toBase58(), sharePct: 50 };
    const coverage = await burnCoverage(store);
    let snap;
    try { snap = await chain.connection.getMultipleAccountsInfoAndContext([client.a.burnState], "confirmed"); } catch { return { ...head, status: "unavailable", coverage }; }
    if (!snap.value[0]) return { ...head, status: "not-set-up", coverage };
    const s0 = client.decodeState(snap.value[0].data);
    // the state, the reserve, the mint and the pool from ONE read, at one slot
    let one;
    try { one = await chain.connection.getMultipleAccountsInfoAndContext([client.a.burnState, s0.reserve, s0.cometailMint, s0.pool], "confirmed"); } catch { return { ...head, status: "unavailable", coverage }; }
    const [stInfo, resInfo, mintInfo, poolInfo] = one.value;
    if (!stInfo) return { ...head, status: "unavailable", coverage };
    const s = client.decodeState(stInfo.data);
    const reserveBal = resInfo ? BigInt(AccountLayout.decode(resInfo.data).amount.toString()) : null;
    const mint = mintInfo ? MintLayout.decode(mintInfo.data) : null;
    let pool: any = null;
    try { pool = poolInfo ? chain.damm.coder.accounts.decode("pool", poolInfo.data) : null; } catch { pool = null; }
    const n = (v: { toString(): string }) => BigInt(v.toString());
    const toReserve = n(s.splitToReserve), spent = n(s.spentTotal);
    const next = reserveBal !== null && pool ? nextBuyback(s, reserveBal, BigInt(pool.tokenBAmount.toString()), Math.floor(Date.now() / 1000)) : null;
    // provenance from the indexed events (every one: there are a few per day)
    const splitsAll = await store.listBurnEvents(BURN_EVENT_NAMES.ClaimSplit, 1_000_000, null);
    const sum = (rows: EventRow[], f: string) => rows.reduce((t, e) => t + BigInt(String(e.data[f] ?? "0")), 0n);
    const programClaims = splitsAll.filter((e) => e.data.claimant === DEFAULT_KEY), ownerClaims = splitsAll.filter((e) => e.data.claimant !== DEFAULT_KEY);
    const burns = await store.listBurnEvents(BURN_EVENT_NAMES.BuybackBurned, BURN_PAGE, null);
    const splits = splitsAll.slice(0, BURN_PAGE);
    const vaults = await store.listVaults();
    const tailsShare = vaults.reduce((t, v) => t + BigInt(String(v.data?.accounting?.toProtocol ?? "0")), 0n);
    const sumPartner = (configs: string[]) => {
      if (!opts.feeIndex || !configs.length) return null;
      try { return String(opts.feeIndex.db.db.prepare(`select coalesce(sum(partner_fee), 0) as t from fi_pools where config in (${configs.map(() => "?").join(",")})`).get(...configs).t); } catch { return null; }
    };
    const complete = coverage.status === "complete";
    const value = {
      ...head, status: "live", coverage, observedSlot: one.context.slot,
      setup: { pool: s.pool.toBase58(), cometailMint: s.cometailMint.toBase58(), treasury: s.treasury.toBase58(), reserve: s.reserve.toBase58(), inbox: s.inbox.toBase58(), setupBy: s.setupBy.toBase58(), feeNumerator: s.feeNumerator.toString() },
      // the program's own counters (exact, at observedSlot); split = claims plus carried inbox funds
      totals: {
        splitLamports: s.splitTotal.toString(), toReserveLamports: toReserve.toString(), toOtherLamports: s.splitToTreasury.toString(),
        spentLamports: spent.toString(), burnedRaw: s.burnedTotal.toString(), buybacks: Number(s.buybacks.toString()), lastBuyAtSec: s.lastBuyTs.toNumber() || null,
      },
      // from the indexed events: exact when coverage is complete, null otherwise
      provenance: {
        claimedByProgramLamports: complete ? sum(programClaims, "claimed").toString() : null,
        claimedByOwnersLamports: complete ? sum(ownerClaims, "claimed").toString() : null,
        carriedLamports: complete ? sum(programClaims, "carried").toString() : null,
        basis: "claimed = what each claim paid, measured on the inbox before and after it; carried = what was already in the inbox (sent to it directly) and split with a program claim or a sweep. Owner claims split only their own amount.",
      },
      reserve: reserveBal === null ? null : { lamports: reserveBal.toString() },
      sentDirectLamports: reserveBal === null ? null : (reserveBal + spent - toReserve).toString(),
      nextBuyback: next ? { amountLamports: next.amount.toString(), dueAtSec: next.dueAtSec, due: next.due } : null,
      cometail: mint ? { mint: s.cometailMint.toBase58(), supplyRaw: mint.supply.toString(), decimals: mint.decimals } : null,
      claimableNow: { programConfigsLamports: sumPartner(opts.burnConfigs), olderConfigsLamports: sumPartner(opts.legacyConfigs), basis: "DBC partner trading fees waiting in the pools now (Fee Index snapshot); graduated-position fees are not included" },
      commitment: {
        tailsShareLamports: tailsShare.toString(), tailsShareAsOfMs: vaults.reduce((t, v) => Math.max(t, v.updatedAt), 0) || null, olderConfigClaimsLamports: null,
        basis: "the tails' 1/5 share from the vaults' own counters as last indexed (tailsShareAsOfMs). Owner claims made through the program are split on chain and counted in provenance; claims on older configs made elsewhere are not known here.",
      },
      burns: burns.map(burnRow), burnsTotal: await store.countBurnEvents(BURN_EVENT_NAMES.BuybackBurned), burnsNextCursor: burns.length === BURN_PAGE ? cursorOf(burns[burns.length - 1]) : null,
      splits: splits.map(splitRow), splitsTotal: splitsAll.length, splitsNextCursor: splits.length === BURN_PAGE ? cursorOf(splits[splits.length - 1]) : null,
    };
    memo = { at: Date.now(), value };
    return value;
  };
}
