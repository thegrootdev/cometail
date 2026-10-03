import { PublicKey } from "@solana/web3.js";
import { utils } from "@coral-xyz/anchor";
// Event indexer: follows the vault program's transaction history, decodes Anchor events and
// stores them together with a snapshot of every vault and its streams, for the site's pages.
import { Connection } from "@solana/web3.js";
import { VAULT_PROGRAM_ID } from "@cometail/client";
import { Chain , isDefault , Decoded , DAMM_V2_PROGRAM_ID , DBC_PROGRAM_ID } from "./chain";
import { isCrossed } from "./ladder";
import { binArrayIndex, readBinView, unfilledAmount } from "./chain";
import { getMint, TOKEN_2022_PROGRAM_ID } from "@solana/spl-token";
import { feedFromEvents, feedFromTrades, publish, FEED_RETENTION_SLOTS } from "./feed";
import { executionPrice, WSOL_MINT } from "./tokens";
import { EventRow, PoolCursor, Store, TradeRow, plain } from "./store";
import { log, parseEvents } from "./tx";

/** Public RPC endpoints throttle; a read is retried a few times with backoff before the pass fails. */
async function retry<T>(what: string, fn: () => Promise<T>, attempts = 8): Promise<T> {
  let last: unknown;
  for (let i = 1; i <= attempts; i++) {
    try { return await fn(); } catch (e) { last = e; if (i < attempts) await new Promise((r) => setTimeout(r, 2500 * i)); }
  }
  throw new Error(`${what}: ${String((last as Error)?.message ?? last)}`);
}

/** Anchor's event-instruction tag (EVENT_IX_TAG = 0x1d9acb512ea545e4) serialized little-endian: the first eight bytes of the self-CPI that carries an event. */
const EVENT_IX_DISCRIMINATOR = Buffer.from("e445a52e51cb9a1d", "hex");

const SWAP_DISCRIMINATOR = Buffer.from("f8c69e91e17587c8", "hex"), SWAP2_DISCRIMINATOR = Buffer.from("414b3f4ceb5b5b88", "hex"), SWAP2_HOOK_DISCRIMINATOR = Buffer.from("b75d992818e6c297", "hex");
/** A pool the trade index follows: the DBC curve of a launch, or a DAMM v2 pool after graduation. */
export interface TradePool { pool: PublicKey; venue: "curve" | "damm"; vault: string | null; baseDecimals: number; mint?: string; quoteMint?: string; quoteDecimals?: number }

export class Indexer {
  /** Pool to base mint, filled by tradePools, for the feed's trade rows. */
  private mintOfPool = new Map<string, string>();
  constructor(readonly chain: Chain, readonly store: Store) {}

  /** One pass; returns how many events were newly indexed. */
  async pass(): Promise<number> {
    const added = await this.indexEvents();
    const vaults = await this.chain.vaults(); // throws on an RPC failure: nothing is pruned on a partial read
    await this.indexTrades(await this.tradePools(vaults));
    const observed = await this.store.observedSlot();
    if (observed) await this.store.pruneFeed(observed - FEED_RETENTION_SLOTS);
    await this.snapshot(vaults);
    return added;
  }

  /** The pools to follow: every launch's DBC curve and, once graduated, its DAMM v2 pool (token rows),
   *  plus every vault's stream-token pool. A trade's `vault` names the vault whose own stream token
   *  trades on that pool (its dbc_pool or damm_pool), never a vault that merely holds a launch's
   *  fee rights: the metrics count stream-token buyers by that field. */
  private async tradePools(vaults: Decoded[]): Promise<TradePool[]> {
    const out = new Map<string, TradePool>();
    const streamPoolVault = new Map<string, string>();
    for (const v of vaults) for (const p of [v.account.dbcPool, v.account.dammPool] as (PublicKey | undefined)[]) if (p && !isDefault(p)) streamPoolVault.set(p.toBase58(), v.pubkey.toBase58());
    for (const t of await this.store.listTokens()) {
      out.set(t.dbcPool, { pool: new PublicKey(t.dbcPool), venue: "curve", vault: streamPoolVault.get(t.dbcPool) ?? null, baseDecimals: t.decimals, mint: t.mint, quoteMint: t.quoteMint, quoteDecimals: t.quoteDecimals ?? 9 });
      this.mintOfPool.set(t.dbcPool, t.mint);
      if (t.dammPool && t.stage === "graduated") { out.set(t.dammPool, { pool: new PublicKey(t.dammPool), venue: "damm", vault: streamPoolVault.get(t.dammPool) ?? null, baseDecimals: t.decimals, mint: t.mint, quoteMint: t.quoteMint, quoteDecimals: t.quoteDecimals ?? 9 }); this.mintOfPool.set(t.dammPool, t.mint); }
    }
    for (const v of vaults) {
      const pool: PublicKey | undefined = v.account.dammPool;
      if (!pool || isDefault(pool) || out.has(pool.toBase58())) continue;
      let decimals = 6;
      try { decimals = await this.stDecimals(v.account.stMint); } catch { /* keep the default */ }
      out.set(pool.toBase58(), { pool, venue: "damm", vault: v.pubkey.toBase58(), baseDecimals: decimals });
    }
    return [...out.values()];
  }

  /** Swaps on every followed pool (DBC EvtSwap* on curves, cp-amm EvtSwap2 on DAMM v2). Per pool, a bounded
   *  catch-up: the walk goes backward from the newest signature toward the last fully indexed one in
   *  at most three pages per pass and persists its frontier (store.PoolCursor); the head moves only
   *  when the walk reaches its target, so no interval is ever skipped, and a pool with a frontier is
   *  reported as still catching up. Trades are keyed by (signature, event ordinal, pool), so any order
   *  and any repeat is safe. The trader is the swap instruction's own signer (cp-amm SwapCtx.payer,
   *  account 8 of swap / swap2) when the event can be paired with its swap in execution order;
   *  otherwise the fee payer, marked as such, which the metrics never count as an independent buyer. */
  private async indexTrades(pools: TradePool[]): Promise<number> {
    let added = 0;
    const conn: Connection = this.chain.connection;
    for (const tp of pools) {
      const pool = tp.pool;
      const poolKey = pool.toBase58(), vaultKey = tp.vault ?? "";
      try {
        // a known pool always has a cursor row; it is pending until a catch-up completes, and a pass
        // interrupted by an unavailable transaction or an error sets it pending again without losing
        // the progress fields
        const existing = await this.store.getPoolCursor(poolKey);
        const cur: PoolCursor = existing ?? { head: null, tail: null, target: null, newHead: null, status: "pending" };
        if (!existing) await this.store.setPoolCursor(poolKey, cur);
        const catchingUp = cur.tail !== null;
        let target = catchingUp ? cur.target : cur.head;
        let newHead = catchingUp ? cur.newHead : null;
        let before: string | undefined = catchingUp ? cur.tail! : undefined;
        const sigs: { signature: string; slot: number; blockTime: number | null }[] = [];
        let reachedTarget = false;
        for (let page = 0; page < 3; page++) {
          const got = await retry("pool signatures", () => conn.getSignaturesForAddress(pool, { before, until: target ?? undefined, limit: 1000 }, "confirmed"));
          if (!catchingUp && page === 0 && got.length) newHead = got[0].signature;
          sigs.push(...got.map((s) => ({ signature: s.signature, slot: s.slot, blockTime: s.blockTime ?? null })));
          if (got.length < 1000) { reachedTarget = true; break; }
          before = got[got.length - 1].signature;
        }
        let stopped = false;
        for (const s of sigs.slice().reverse()) {
          let tx = null as Awaited<ReturnType<Connection["getTransaction"]>>;
          for (let i = 0; i < 5 && !tx; i++) {
            if (i > 0) await new Promise((r) => setTimeout(r, 1500 * i));
            tx = await retry(`transaction ${s.signature}`, () => conn.getTransaction(s.signature, { commitment: "confirmed", maxSupportedTransactionVersion: 0 }));
          }
          if (!tx) { log("pool transaction not available yet; this pool resumes next pass", { pool: poolKey, signature: s.signature }); stopped = true; break; }
          if (tx.meta?.err) continue;
          const rows = decodeTrades(this.chain, tx, pool, { signature: s.signature, slot: s.slot, blockTime: s.blockTime, vault: vaultKey, venue: tp.venue, baseDecimals: tp.baseDecimals, quoteMint: tp.quoteMint, quoteDecimals: tp.quoteDecimals });
          await this.store.insertTrades(rows);
          await publish(this.store, feedFromTrades(rows, (p) => this.mintOfPool.get(p) ?? null));
          added += rows.length;
          if (rows.length) log("indexed trades", { pool: poolKey, signature: s.signature, trades: rows.length });
        }
        // the frontier moves only over what was fully processed; a stopped pass keeps it where it was
        if (stopped) { await this.store.setPoolCursor(poolKey, { ...cur, status: "pending" }); continue; }
        if (reachedTarget) await this.store.setPoolCursor(poolKey, { head: newHead ?? cur.head, tail: null, target: null, newHead: null, status: "ok" });
        else await this.store.setPoolCursor(poolKey, { head: cur.head, tail: before ?? null, target, newHead, status: "pending" });
      } catch (e) {
        log("trade index failed for a pool; it resumes next pass", { pool: poolKey, error: String((e as Error).message ?? e) });
        try { const c = await this.store.getPoolCursor(poolKey); await this.store.setPoolCursor(poolKey, { ...(c ?? { head: null, tail: null, target: null, newHead: null }), status: "pending" }); } catch { /* the store itself is failing; the next pass retries */ }
      }
    }
    return added;
  }

  private async indexEvents(): Promise<number> {
    let added = 0;
    const conn: Connection = this.chain.connection;
    const until = (await this.store.getCursor()) ?? undefined;
    // newest first from the RPC; stop at the cursor, then apply oldest first
    const sigs: { signature: string; slot: number; blockTime: number | null }[] = [];
    let before: string | undefined;
    for (;;) {
      const page = await retry("signatures", () => conn.getSignaturesForAddress(VAULT_PROGRAM_ID, { before, until, limit: 1000 }, "confirmed"));
      sigs.push(...page.map((s) => ({ signature: s.signature, slot: s.slot, blockTime: s.blockTime ?? null })));
      if (page.length < 1000) break;
      before = page[page.length - 1].signature;
    }
    sigs.reverse();
    for (const s of sigs) {
      // a null read is the RPC not having the transaction yet (lag, throttling): never skip it
      let tx = null as Awaited<ReturnType<Connection["getTransaction"]>>;
      for (let i = 0; i < 5 && !tx; i++) {
        if (i > 0) await new Promise((r) => setTimeout(r, 1500 * i));
        tx = await retry(`transaction ${s.signature}`, () => conn.getTransaction(s.signature, { commitment: "confirmed", maxSupportedTransactionVersion: 0 }));
      }
      if (!tx) { log("transaction not available yet; the pass stops here and resumes next time", { signature: s.signature }); return added; }
      if (tx.meta?.err) { await this.store.setCursor(s.signature); continue; } // failed transactions carry no events
      const events = parseEvents(this.chain.events, tx.meta?.logMessages ?? []);
      const rows: EventRow[] = events.map((e, i) => { const data = plain(e.data); return { signature: s.signature, idx: i, slot: s.slot, blockTime: s.blockTime, name: e.name, vault: typeof data.vault === "string" ? data.vault : null, data }; });
      await this.store.insertEvents(rows, s.signature);
      await publish(this.store, feedFromEvents(rows));
      added += rows.length;
      if (events.length) log("indexed", { signature: s.signature, events: events.map((e) => e.name) });
    }
    return added;
  }

  /** Every vault and its streams as they are on chain now. Withdrawn streams leave the current
   *  holdings (their events stay). The vault row carries a reconciliation of its accounting totals
   *  against the indexed events, so a gap between the two is visible instead of silent. */
  private stDecimalsCache = new Map<string, number>();
  private poolTotals = new Map<string, bigint>();

  /** Stream-token decimals, read once per mint. */
  private async stDecimals(mint: PublicKey): Promise<number> {
    const k = mint.toBase58();
    const cached = this.stDecimalsCache.get(k);
    if (cached !== undefined) return cached;
    const owner = await this.chain.accountOwner(mint);
    const m = await getMint(this.chain.connection, mint, "confirmed", owner && owner.equals(TOKEN_2022_PROGRAM_ID) ? TOKEN_2022_PROGRAM_ID : undefined);
    this.stDecimalsCache.set(k, m.decimals);
    return m.decimals;
  }

  /** Live, per pass: the vault's standing bids bin by bin (price in SOL per stream token,
   *  resting amount, whether the active bin has crossed it) and the pool's active price. Display
   *  only; the keeper's settle logic reads the bins itself. */
  private async liveView(vaultPk: PublicKey, vault: any): Promise<any> {
    // ladder null: the vault has no pair yet (known); ladder.status "unavailable": the pair exists
    // but its orders or bins could not be read this pass (the metrics count that as incomplete)
    const out: any = { updatedAt: Date.now(), ladder: null };
    const hasPair = !!vault.dlmmPair && !isDefault(vault.dlmmPair);
    try {
      if (hasPair) {
        const pair = await this.chain.lbPair(vault.dlmmPair);
        if (!pair) out.ladder = { status: "unavailable", reason: "pair account not found" };
        if (pair) {
          const binStep = Number(pair.binStep), activeId = Number(pair.activeId);
          const dec = await this.stDecimals(vault.stMint);
          const price = (id: number) => binPriceSolPerSt(id, binStep, !!vault.stIsX, dec);
          const orders: any[] = [];
          const read: { order: any; record: any }[] = [];
          for (const r of await this.chain.orderRecords(vaultPk)) { const order = await this.chain.limitOrder(r.account.limitOrder); if (order) read.push({ order, record: r }); }
          // the fill state of every bin comes from its bin array, the same accounting the program's
          // settle applies (chain.unfilledAmount); crossed is only the keeper's settle trigger
          const arrays = await this.chain.binArrays(vault.dlmmPair, read.flatMap((x) => x.order.bins.map((b: any) => b.id)));
          for (const { order, record } of read) {
            const bins = order.bins.map((b: any) => {
              const data = arrays.get(binArrayIndex(b.id));
              const view = data ? readBinView(data, vault.dlmmPair, b.id) : null;
              const remaining = view ? unfilledAmount(b, view) : null;
              const status = remaining === null ? "unknown" : remaining === b.amount ? "unfilled" : remaining === 0n ? "filled" : "partial";
              return { id: b.id, amount: b.amount.toString(), remaining: remaining === null ? null : remaining.toString(), filled: remaining === null ? null : (b.amount - remaining).toString(), status, isAsk: b.isAsk, crossed: isCrossed(b.id, b.isAsk, activeId), price: price(b.id) };
            });
            orders.push({ limitOrder: record.account.limitOrder.toBase58(), placedTs: Number(record.account.placedTs), grossSpent: record.account.grossSpent.toString(), bins });
          }
          const allBins = orders.flatMap((o) => o.bins as any[]);
          const resting = allBins.reduce((a, b) => a + BigInt(b.remaining ?? 0), 0n);
          const unknownBins = allBins.filter((b) => b.remaining === null).length;
          out.ladder = { status: "ok", pair: vault.dlmmPair.toBase58(), activeId, binStep, activePrice: price(activeId), orders, restingLamports: resting.toString(), unknownBins };
        }
      }
    } catch (e) {
      const error = String((e as Error).message ?? e);
      log("live ladder read failed", { vault: vaultPk.toBase58(), error });
      if (hasPair) out.ladder = { status: "unavailable", reason: error };
    }
    return out;
  }

  /** The registered position's share of its pool's permanently locked liquidity, read live. */
  private async streamLive(stream: any): Promise<any> {
    try {
      if (!stream.position || isDefault(stream.position) || !stream.derivedDammPool || isDefault(stream.derivedDammPool)) return null;
      const poolKey = stream.derivedDammPool.toBase58();
      let total = this.poolTotals.get(poolKey);
      if (total === undefined) { const pool = await this.chain.dammPool(stream.derivedDammPool); if (!pool) return null; total = BigInt(pool.permanentLockLiquidity.toString()); this.poolTotals.set(poolKey, total); }
      const pos = await this.chain.dammPosition(stream.position);
      if (!pos) return null;
      const a = BigInt(pos.permanentLockedLiquidity.toString());
      return { permanentLiquidity: a.toString(), poolPermanentLiquidity: total.toString(), lockedSharePct: total > 0n ? Number((a * 10_000n) / total) / 100 : 0, updatedAt: Date.now() };
    } catch (e) { log("live position read failed", { error: String((e as Error).message ?? e) }); return null; }
  }

  private async snapshot(vaults: Decoded[]): Promise<void> {
    this.poolTotals.clear();
    const harvestEvents = await this.store.listEventsSince(["harvested", "oneTimeHarvested"], 0);
    const routed = await this.store.listEventsSince(["routed"], 0);
    const settled = await this.store.listEventsSince(["settled"], 0);
    const sum = (rows: { vault: string | null; data: any }[], vault: string, field: string) => rows.filter((e) => e.vault === vault).reduce((acc, e) => acc + BigInt(e.data[field] ?? 0), 0n);
    for (const v of vaults) {
      const key = v.pubkey.toBase58();
      const acc = v.account.accounting ?? {};
      const big = (x: any) => BigInt((x ?? 0).toString());
      const fromEvents = { harvestedGross: sum(harvestEvents, key, "gross"), toDepositor: sum(harvestEvents, key, "toDepositor"), toProtocol: sum(harvestEvents, key, "toProtocol"), routedGross: sum(routed, key, "gross"), burnedSt: sum(settled, key, "burned"), refundedPrincipal: sum(settled, key, "refunded"), orderFeesWsol: sum(settled, key, "fees") };
      const onChain = { harvestedGross: big(acc.harvestedGross), toDepositor: big(acc.toDepositor), toProtocol: big(acc.toProtocol), routedGross: big(acc.routedGross), burnedSt: big(acc.burnedSt), refundedPrincipal: big(acc.refundedPrincipal), orderFeesWsol: big(acc.orderFeesWsol) };
      const mismatches = (Object.keys(onChain) as (keyof typeof onChain)[]).filter((k) => onChain[k] !== fromEvents[k]);
      if (mismatches.length) log("accounting differs from indexed events (events may still be catching up)", { vault: key, mismatches });
      const live = await this.liveView(v.pubkey, v.account);
      await this.store.upsertVault(key, { ...plain(v.account), live, reconciliation: { fromEvents: plain(fromEvents), matches: mismatches.length === 0, mismatches, checkedAt: Date.now() } });
      const streams = await this.chain.streams(v.pubkey);
      for (const s of streams) await this.store.upsertStream(s.pubkey.toBase58(), key, { ...plain(s.account), live: await this.streamLive(s.account) });
      await this.store.pruneStreams(key, streams.map((s) => s.pubkey.toBase58()));
    }
  }
}

/** DLMM bin price as SOL per stream token: (1 + step/10000)^id is Y per X in raw units; the stream
 *  token's side and the two decimals (WSOL has 9) turn it into a display price. */
export function binPriceSolPerSt(binId: number, binStep: number, stIsX: boolean, stDecimals: number): number {
  const raw = Math.pow(1 + binStep / 10_000, binId);
  const yPerX = raw; // token Y raw per token X raw
  return stIsX ? yPerX * Math.pow(10, stDecimals - 9) : (1 / yPerX) * Math.pow(10, stDecimals - 9);
}

/** The trades of one transaction on one pool. Execution order is the top-level instructions each
 *  followed by their inner instructions; a swap's event self-CPI follows its swap instruction, so
 *  the events of a pool pair with the swaps of that pool in order. The ordinal counts every event
 *  instruction of either Meteora program in the transaction before any pool filter, so it is
 *  stable across pools. DBC: swap / swap2 / swap2_with_transfer_hook with the pool at account 2 and
 *  the signer at 9, events EvtSwap (actual input) and EvtSwap2 (included-fee input). cp-amm: swap /
 *  swap2 with the pool at 1 and the signer at 8, EvtSwap2. Direction 1 is quote in, token out. */
export function decodeTrades(chain: Chain, tx: NonNullable<Awaited<ReturnType<Connection["getTransaction"]>>>, pool: PublicKey, meta: { signature: string; slot: number; blockTime: number | null; vault: string; venue: "curve" | "damm"; baseDecimals: number; quoteMint?: string; quoteDecimals?: number }): TradeRow[] {
  const keys = tx.transaction.message.getAccountKeys({ accountKeysFromLookups: tx.meta?.loadedAddresses ?? undefined });
  const feePayer = keys.get(0)?.toBase58() ?? "";
  const inner = new Map<number, { programIdIndex: number; accounts: number[]; data: Buffer }[]>();
  for (const ii of tx.meta?.innerInstructions ?? []) inner.set(ii.index, ii.instructions.map((x) => ({ programIdIndex: x.programIdIndex, accounts: x.accounts, data: Buffer.from(utils.bytes.bs58.decode(x.data)) })));
  const flat: { programIdIndex: number; accounts: number[]; data: Buffer }[] = [];
  tx.transaction.message.compiledInstructions.forEach((c, i) => { flat.push({ programIdIndex: c.programIdIndex, accounts: [...c.accountKeyIndexes], data: Buffer.from(c.data) }); for (const x of inner.get(i) ?? []) flat.push(x); });
  const program = meta.venue === "curve" ? DBC_PROGRAM_ID : DAMM_V2_PROGRAM_ID;
  const coder = meta.venue === "curve" ? chain.dbc.coder : chain.damm.coder;
  const poolIndex = meta.venue === "curve" ? 2 : 1, signerIndex = meta.venue === "curve" ? 9 : 8;
  // one row per swap execution: DBC emits EvtSwap and EvtSwap2 for the same swap (ix_swap.rs), so
  // every event that follows one swap instruction of the pool, up to the next, belongs to that
  // execution; EvtSwap2 supplies the amounts when present (included-fee input), EvtSwap otherwise
  const rows: TradeRow[] = [];
  let ordinal = 0;
  let execution: { signer: string | null; row: TradeRow | null; from2: boolean } | null = null;
  const close = () => { if (execution?.row) rows.push(execution.row); execution = null; };
  for (const f of flat) {
    const pid = keys.get(f.programIdIndex);
    if (!pid || f.data.length < 8) continue;
    const disc = f.data.subarray(0, 8);
    if (disc.equals(EVENT_IX_DISCRIMINATOR) && (pid.equals(DBC_PROGRAM_ID) || pid.equals(DAMM_V2_PROGRAM_ID))) ordinal++;
    if (!pid.equals(program)) continue;
    if (disc.equals(SWAP_DISCRIMINATOR) || disc.equals(SWAP2_DISCRIMINATOR) || disc.equals(SWAP2_HOOK_DISCRIMINATOR)) {
      const p = keys.get(f.accounts[poolIndex] ?? -1), signer = keys.get(f.accounts[signerIndex] ?? -1);
      close();
      if (p && p.equals(pool)) execution = { signer: signer ? signer.toBase58() : null, row: null, from2: false };
      continue;
    }
    if (!disc.equals(EVENT_IX_DISCRIMINATOR) || f.data.length < 16) continue;
    let ev: { name: string; data: any } | null = null;
    try { ev = coder.events.decode(f.data.subarray(8).toString("base64")); } catch { continue; }
    if (!ev || !/^evtswap/i.test(ev.name)) continue;
    const d: any = ev.data;
    if (!d.pool || !new PublicKey(d.pool).equals(pool)) continue;
    const is2 = /2/.test(ev.name);
    // an event without a preceding swap instruction of this pool (a route we could not pair) is its own execution
    if (!execution) execution = { signer: null, row: null, from2: false };
    if (execution.row && (execution.from2 || !is2)) continue; // a second event of the same execution adds nothing
    const buy = Number(d.tradeDirection) === 1;
    const result = d.swapResult ?? {};
    const input = BigInt(String(result.includedFeeInputAmount ?? result.actualInputAmount ?? d.amountIn ?? 0));
    const output = BigInt(String(result.outputAmount ?? 0));
    const quote = buy ? input : output, base = buy ? output : input;
    execution.row = { signature: meta.signature, idx: execution.row?.idx ?? ordinal, slot: meta.slot, blockTime: meta.blockTime, pool: pool.toBase58(), vault: meta.vault, trader: execution.signer ?? feePayer, traderKind: execution.signer ? "authority" : "feePayer", buy, amountIn: input.toString(), amountOut: output.toString(), venue: meta.venue, baseAmountRaw: base.toString(), quoteAmountLamports: quote.toString(), executionPriceSol: (meta.quoteMint ?? WSOL_MINT) === WSOL_MINT ? executionPrice(quote, base, meta.baseDecimals) : null, executionPriceQuote: executionPrice(quote, base, meta.baseDecimals, meta.quoteDecimals ?? 9), quoteMint: meta.quoteMint ?? WSOL_MINT, quoteDecimals: meta.quoteDecimals ?? 9 };
    execution.from2 = is2;
    if (!execution.signer) close(); // unpaired events never merge with each other
  }
  close();
  return rows;
}
