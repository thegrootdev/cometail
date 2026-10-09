// The public proof document behind /stats on the site (GET /api/stats). Every figure carries the moment it was
// read and where a reader can check it: the pool accounts on chain, the burn program's counters, the indexed
// trades, the tails' claims, the vaults' own accounting and the Fee Index. A figure that cannot be proven at
// that moment (an index still catching up, an account that could not be read, a trade without its quote leg)
// is null, never a guess or a zero.
import { PublicKey } from "@solana/web3.js";
import type { Chain } from "./chain";
import type { FeeIndex } from "./feeindex";
import type { Store, TokenRow, TradeRow } from "./store";

const WSOL = "So11111111111111111111111111111111111111112";
const TTL_MS = 60_000;
const PAGE = 1000;

export interface StatsOptions {
  cluster: string;
  /** The team's own wallets (COMETAIL_DEMO_ACTORS): launches and vaults they own are ours, everything else is outside. */
  team: string[];
  feeIndex: FeeIndex | null;
  burnView: (() => Promise<unknown>) | null;
  tailView: ((mint: string | null) => Promise<{ tails: unknown[] }>) | null;
}

const big = (v: unknown): bigint | null => {
  if (v === null || v === undefined) return null;
  try { return BigInt(String(v)); } catch { return null; }
};
const str = (v: bigint | null) => (v === null ? null : v.toString());
interface Launch {
  mint: string; symbol: string; name: string; kind: TokenRow["tokenKind"]; stage: TokenRow["stage"]; createdAtMs: number | null; config: string;
  creator: string; owner: string | null; team: boolean | null; quoteMint: string; quoteDecimals: number | null; dbcPool: string; dammPool: string | null;
  trades: number; traders: number; volumeLamports: string | null; volumeByVenue: Record<string, string> | null;
  fees: { curveTradingLamports: string | null; curveProtocolLamports: string | null; poolLpLamports: string | null; poolProtocolLamports: string | null };
  lockedBps: number | null;
}
const sumOrNull = (xs: (bigint | null)[]) => (xs.some((x) => x === null) ? null : xs.reduce<bigint>((t, x) => t + (x as bigint), 0n));

/** Every indexed trade of one launch, oldest page last; null when any trade lacks its quote leg. */
async function tradesOf(store: Store, t: TokenRow): Promise<{ trades: number; lamports: bigint | null; byVenue: Record<string, bigint>; traders: Set<string> }> {
  const pools = [t.dbcPool, ...(t.dammPool ? [t.dammPool] : [])];
  const traders = new Set<string>();
  const byVenue: Record<string, bigint> = {};
  let before: { slot: number; idx: number; signature: string } | null = null, n = 0, lamports: bigint | null = 0n;
  for (;;) {
    const rows: TradeRow[] = await store.listTradesByPools(pools, PAGE, before);
    for (const r of rows) {
      n++; traders.add(r.trader);
      const q = big(r.quoteAmountLamports);
      if (q === null) lamports = null;
      else {
        if (lamports !== null) lamports += q;
        const v = r.venue ?? "unknown";
        byVenue[v] = (byVenue[v] ?? 0n) + q;
      }
    }
    if (rows.length < PAGE) break;
    const last = rows[rows.length - 1];
    before = { slot: last.slot, idx: last.idx, signature: last.signature };
  }
  return { trades: n, lamports, byVenue, traders };
}

export function statsViewer(chain: Chain, store: Store, opts: StatsOptions) {
  let memo: { at: number; value: unknown } | null = null;
  let inflight: Promise<unknown> | null = null;
  const team = new Set(opts.team);
  const build = async () => {
    const generatedAtMs = Date.now();
    const tokens: TokenRow[] = await store.listTokens();
    const vaults = await store.listVaults();
    const depositorOf = new Map(vaults.map((v) => [v.vault, String(v.data?.depositor ?? "")]));
    // the same owner rule as the metrics: a vault-held launch belongs to the vault's depositor (unknown until the vault
    // record exists); without a vault only a wallet-held creator is a resolved owner; program or unknown custody is unattributed
    const ownerOf = (t: TokenRow) => (t.vault ? depositorOf.get(t.vault) || null : t.custody === "wallet" ? t.creator : null);
    const isTeam = (t: TokenRow) => { const o = ownerOf(t); return o ? team.has(o) : null; };

    // a launch's trades are complete only when every one of its pools (the curve and, once graduated, its pool) has a
    // cursor that finished a catch-up; a pool the indexer has not reached yet has no cursor and counts as pending
    const cursorOk = new Map((await store.listPoolCursors()).map((c) => [c.key, c.cursor.status === "ok"]));
    const poolsOf = (t: TokenRow) => [t.dbcPool, ...(t.dammPool ? [t.dammPool] : [])];
    const covered = (t: TokenRow) => poolsOf(t).every((p) => cursorOk.get(p) === true);
    const pendingPools = tokens.reduce((n, t) => n + poolsOf(t).filter((p) => cursorOk.get(p) !== true).length, 0);
    const scannedAtMs = Number(await store.getMeta("tokens_scanned_at")) || null;
    const indexComplete = pendingPools === 0 && scannedAtMs !== null;

    // the pool accounts, read in batches of 100 (each batch at its own slot; the latest is reported)
    const keys: PublicKey[] = [];
    for (const t of tokens) { keys.push(new PublicKey(t.dbcPool)); if (t.dammPool) keys.push(new PublicKey(t.dammPool)); }
    let chainRead: { slot: number; atMs: number; byKey: Map<string, any> } | null = null;
    try {
      const byKey = new Map<string, any>();
      let slot = 0;
      for (let i = 0; i < keys.length; i += 100) {
        const r = await chain.connection.getMultipleAccountsInfoAndContext(keys.slice(i, i + 100), "confirmed");
        slot = Math.max(slot, r.context.slot);
        r.value.forEach((info, j) => {
          const k = keys[i + j].toBase58();
          if (!info) return;
          try {
            const isDamm = info.owner.equals(chain.damm.programId);
            if (isDamm) byKey.set(k, { kind: "damm", state: chain.damm.coder.accounts.decode("pool", info.data) });
            else { const d = chain.dbc.coder.accounts.decode("virtualPool", info.data); byKey.set(k, { kind: "curve", state: d.poolState ?? d }); }
          } catch { /* undecodable: left unknown */ }
        });
      }
      chainRead = { slot, atMs: Date.now(), byKey };
    } catch { chainRead = null; }

    const allTraders = new Set<string>();
    const launches: Launch[] = [];
    for (const t of tokens) {
      const tr = await tradesOf(store, t);
      tr.traders.forEach((w) => allTraders.add(w));
      const curve = chainRead?.byKey.get(t.dbcPool);
      const damm = t.dammPool ? chainRead?.byKey.get(t.dammPool) : null;
      const cm = curve?.kind === "curve" ? curve.state.metrics : null;
      const dm = damm?.kind === "damm" ? damm.state : null;
      const dammQuoteIsSol = dm ? dm.tokenBMint.toBase58() === WSOL : false;
      launches.push({
        mint: t.mint, symbol: t.symbol, name: t.name, kind: t.tokenKind, stage: t.stage, createdAtMs: t.createdAtMs, config: t.config,
        creator: t.creator, owner: ownerOf(t), team: isTeam(t), quoteMint: t.quoteMint, quoteDecimals: t.quoteDecimals ?? null, dbcPool: t.dbcPool, dammPool: t.dammPool,
        trades: tr.trades, traders: tr.traders.size,
        // volume in the quote's base units; only WSOL-quoted launches are summed into SOL totals
        volumeLamports: scannedAtMs !== null && covered(t) ? str(tr.lamports) : null,
        volumeByVenue: scannedAtMs !== null && covered(t) && tr.lamports !== null ? Object.fromEntries(Object.entries(tr.byVenue).map(([k, v]) => [k, v.toString()])) : null,
        fees: {
          // DBC's own counters on the curve: the trading fee net of Meteora's protocol share, and that share
          curveTradingLamports: cm ? cm.totalTradingQuoteFee.toString() : null,
          curveProtocolLamports: cm ? cm.totalProtocolQuoteFee.toString() : null,
          // DAMM v2's counters on the graduated pool, quote side (the pools collect fees in the quote token)
          poolLpLamports: t.dammPool ? (dm && dammQuoteIsSol ? dm.metrics.totalLpBFee.toString() : null) : "0",
          poolProtocolLamports: t.dammPool ? (dm && dammQuoteIsSol ? dm.metrics.totalProtocolBFee.toString() : null) : "0",
        },
        // the share of the graduated pool's liquidity that is permanently locked, in basis points (exact integer division)
        lockedBps: dm && BigInt(dm.liquidity.toString()) > 0n ? Number((BigInt(dm.permanentLockLiquidity.toString()) * 10000n) / BigInt(dm.liquidity.toString())) : null,
      });
    }
    const sol = launches.filter((l) => l.quoteMint === WSOL);
    const sumField = (rows: Launch[], f: (l: Launch) => string | null) => str(sumOrNull(rows.map((l) => big(f(l)))));
    const curveTrading = sumField(sol, (l) => l.fees.curveTradingLamports), curveProtocol = sumField(sol, (l) => l.fees.curveProtocolLamports);
    const poolLp = sumField(sol, (l) => l.fees.poolLpLamports), poolProtocol = sumField(sol, (l) => l.fees.poolProtocolLamports);
    const total = (xs: (string | null)[]) => str(sumOrNull(xs.map(big)));

    let burn: any = null;
    try { burn = opts.burnView ? await opts.burnView() : null; } catch { burn = null; }
    const burnLive = burn && burn.status === "live";

    let tails: any[] | null = null;
    try { tails = opts.tailView ? ((await opts.tailView(null)).tails as any[]) : []; } catch { tails = null; }

    const fi = opts.feeIndex ? opts.feeIndex.status() as any : null;

    const vaultRows = vaults.map((v) => {
      const a = v.data?.accounting ?? {};
      const status = v.data?.status ? Object.keys(v.data.status)[0] ?? null : null;
      return { vault: v.vault, depositor: String(v.data?.depositor ?? ""), team: team.has(String(v.data?.depositor ?? "")), status, stMint: v.data?.stMint ? String(v.data.stMint) : null,
        harvestedLamports: a.harvestedGross ?? null, toDepositorLamports: a.toDepositor ?? null, toProtocolLamports: a.toProtocol ?? null,
        waitingLamports: a.income ?? null, routedLamports: a.routedGross ?? null, burnedStRaw: a.burnedSt ?? null, readAtMs: v.updatedAt };
    });

    return {
      schemaVersion: 1, cluster: opts.cluster, generatedAtMs,
      team: [...team],
      launches: {
        readAtMs: scannedAtMs, total: launches.length,
        team: launches.filter((l) => l.team === true).length, outside: launches.filter((l) => l.team === false).length, unattributed: launches.filter((l) => l.team === null).length,
        graduated: { total: launches.filter((l) => l.stage === "graduated").length, team: launches.filter((l) => l.stage === "graduated" && l.team === true).length, outside: launches.filter((l) => l.stage === "graduated" && l.team === false).length },
        list: launches,
      },
      trading: {
        readAtMs: scannedAtMs, complete: indexComplete, pendingPools,
        trades: launches.reduce((n, l) => n + l.trades, 0),
        traders: indexComplete ? allTraders.size : null,
        volumeLamports: indexComplete ? sumField(sol, (l) => l.volumeLamports) : null,
        outsideVolumeLamports: indexComplete ? sumField(sol.filter((l) => l.team === false), (l) => l.volumeLamports) : null,
        basis: "every swap on the launches' curves and graduated pools, as indexed from chain; volume is the quote leg of each trade, WSOL-quoted launches only",
      },
      fees: {
        readAtMs: chainRead?.atMs ?? null, slot: chainRead?.slot ?? null,
        curveTradingLamports: curveTrading, curveProtocolLamports: curveProtocol, poolLpLamports: poolLp, poolProtocolLamports: poolProtocol,
        totalLamports: total([curveTrading, curveProtocol, poolLp, poolProtocol]),
        meteoraProtocolLamports: total([curveProtocol, poolProtocol]),
        basis: "the pools' own lifetime counters on chain: DBC virtual pool metrics (totalTradingQuoteFee, totalProtocolQuoteFee) and DAMM v2 pool metrics (totalLpBFee, totalProtocolBFee, which includes the compounding share). Referral payouts are taken out of the protocol fee before these counters and are not included",
        excludes: "referral payouts",
      },
      burn: burnLive ? {
        readAtMs: burn.generatedAtMs, slot: burn.observedSlot ?? null, program: burn.program, reserve: burn.setup?.reserve ?? null, mint: burn.cometail?.mint ?? null,
        burnedRaw: burn.totals.burnedRaw, buybacks: burn.totals.buybacks, spentLamports: burn.totals.spentLamports,
        splitLamports: burn.totals.splitLamports, toReserveLamports: burn.totals.toReserveLamports, lastBuyAtSec: burn.totals.lastBuyAtSec,
        supplyRaw: burn.cometail?.supplyRaw ?? null, decimals: burn.cometail?.decimals ?? null, reconciled: burn.history?.reconciled ?? null,
        basis: "the burn program's own counters, read from its state account at one slot",
      } : null,
      tails: tails === null ? null : {
        readAtMs: generatedAtMs,
        list: tails.map((t: any) => ({ mint: t.mint, claims: t.totals?.claims ?? null, notSplit: t.totals?.notSplit ?? null, madeUp: t.totals?.madeUp ?? null,
          claimedLamports: t.totals?.claimedLamports ?? null, toBurnLamports: t.totals?.toBurnLamports ?? null, liquidityLamports: t.totals?.liquidityLamports ?? null,
          liquidityRaw: t.totals?.liquidityRaw ?? null, complete: t.coverage?.claims?.status === "complete" })),
      },
      vaults: { readAtMs: vaultRows.reduce((m, v) => Math.max(m, v.readAtMs), 0) || null, total: vaultRows.length, launched: vaultRows.filter((v) => v.status && v.status !== "open").length, list: vaultRows },
      feeIndex: fi ? { readAtMs: fi.deltaAtMs ?? null, mode: fi.mode ?? null, pools: fi.pools ?? null, configs: fi.configs ?? null, claimsConfirmed: fi.claims?.confirmed ?? null, historySinceMs: fi.historySinceMs ?? null, refreshMinutes: fi.deltaEveryMinutes ?? null } : null,
    };
  };
  return async (): Promise<unknown> => {
    if (memo && Date.now() - memo.at < TTL_MS) return memo.value;
    // one build at a time: concurrent callers share it
    inflight ??= build().then((value) => { memo = { at: Date.now(), value }; return value; }).finally(() => { inflight = null; });
    return inflight;
  };
}
