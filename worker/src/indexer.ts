import { PublicKey } from "@solana/web3.js";
// Event indexer: follows the vault program's transaction history, decodes Anchor events and
// stores them together with a snapshot of every vault and its streams, for the site's pages.
import { Connection } from "@solana/web3.js";
import { VAULT_PROGRAM_ID } from "@cometail/client";
import { Chain , isDefault } from "./chain";
import { isCrossed } from "./ladder";
import { getMint, TOKEN_2022_PROGRAM_ID } from "@solana/spl-token";
import { EventRow, Store, plain } from "./store";
import { log, parseEvents } from "./tx";

/** Public RPC endpoints throttle; a read is retried a few times with backoff before the pass fails. */
async function retry<T>(what: string, fn: () => Promise<T>, attempts = 8): Promise<T> {
  let last: unknown;
  for (let i = 1; i <= attempts; i++) {
    try { return await fn(); } catch (e) { last = e; if (i < attempts) await new Promise((r) => setTimeout(r, 2500 * i)); }
  }
  throw new Error(`${what}: ${String((last as Error)?.message ?? last)}`);
}

export class Indexer {
  constructor(readonly chain: Chain, readonly store: Store) {}

  /** One pass; returns how many events were newly indexed. */
  async pass(): Promise<number> {
    const added = await this.indexEvents();
    await this.snapshot();
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
    const out: any = { updatedAt: Date.now(), ladder: null };
    try {
      if (vault.dlmmPair && !isDefault(vault.dlmmPair)) {
        const pair = await this.chain.lbPair(vault.dlmmPair);
        if (pair) {
          const binStep = Number(pair.binStep), activeId = Number(pair.activeId);
          const dec = await this.stDecimals(vault.stMint);
          const price = (id: number) => binPriceSolPerSt(id, binStep, !!vault.stIsX, dec);
          const orders: any[] = [];
          for (const r of await this.chain.orderRecords(vaultPk)) {
            const order = await this.chain.limitOrder(r.account.limitOrder);
            if (!order) continue;
            orders.push({ limitOrder: r.account.limitOrder.toBase58(), placedTs: Number(r.account.placedTs), grossSpent: r.account.grossSpent.toString(),
              bins: order.bins.map((b) => ({ id: b.id, amount: b.amount.toString(), isAsk: b.isAsk, crossed: isCrossed(b.id, b.isAsk, activeId), price: price(b.id) })) });
          }
          const resting = orders.flatMap((o) => o.bins as any[]).filter((b) => !b.crossed).reduce((a, b) => a + BigInt(b.amount), 0n);
          out.ladder = { pair: vault.dlmmPair.toBase58(), activeId, binStep, activePrice: price(activeId), orders, restingLamports: resting.toString() };
        }
      }
    } catch (e) { log("live ladder read failed", { vault: vaultPk.toBase58(), error: String((e as Error).message ?? e) }); }
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

  private async snapshot(): Promise<void> {
    this.poolTotals.clear();
    const vaults = await this.chain.vaults(); // throws on an RPC failure: nothing is pruned on a partial read
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
