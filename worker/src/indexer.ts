// Event indexer: follows the vault program's transaction history, decodes Anchor events and
// stores them together with a snapshot of every vault and its streams, for the site's pages.
import { Connection } from "@solana/web3.js";
import { VAULT_PROGRAM_ID } from "@cometail/client";
import { Chain } from "./chain";
import { EventRow, Store, plain } from "./store";
import { log, parseEvents } from "./tx";

/** Public RPC endpoints throttle; a read is retried a few times with backoff before the pass fails. */
async function retry<T>(what: string, fn: () => Promise<T>, attempts = 5): Promise<T> {
  let last: unknown;
  for (let i = 1; i <= attempts; i++) {
    try { return await fn(); } catch (e) { last = e; if (i < attempts) await new Promise((r) => setTimeout(r, 1500 * i)); }
  }
  throw new Error(`${what}: ${String((last as Error)?.message ?? last)}`);
}

export class Indexer {
  constructor(readonly chain: Chain, readonly store: Store) {}

  async pass(): Promise<void> {
    await this.indexEvents();
    await this.snapshot();
  }

  private async indexEvents(): Promise<void> {
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
      const tx = await retry(`transaction ${s.signature}`, () => conn.getTransaction(s.signature, { commitment: "confirmed", maxSupportedTransactionVersion: 0 }));
      if (!tx || tx.meta?.err) { await this.store.setCursor(s.signature); continue; }
      const events = parseEvents(this.chain.events, tx.meta?.logMessages ?? []);
      const rows: EventRow[] = events.map((e, i) => { const data = plain(e.data); return { signature: s.signature, idx: i, slot: s.slot, blockTime: s.blockTime, name: e.name, vault: typeof data.vault === "string" ? data.vault : null, data }; });
      await this.store.insertEvents(rows, s.signature);
      if (events.length) log("indexed", { signature: s.signature, events: events.map((e) => e.name) });
    }
  }

  private async snapshot(): Promise<void> {
    const vaults = await this.chain.vaults();
    for (const v of vaults) {
      await this.store.upsertVault(v.pubkey.toBase58(), plain(v.account));
      const streams = await this.chain.streams(v.pubkey);
      for (const s of streams) await this.store.upsertStream(s.pubkey.toBase58(), v.pubkey.toBase58(), plain(s.account));
    }
  }
}
