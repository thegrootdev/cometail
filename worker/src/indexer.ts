// Event indexer: follows the vault program's transaction history, decodes Anchor events and
// stores them in Postgres together with a snapshot of every vault, for the site's pages.
import { Connection, PublicKey } from "@solana/web3.js";
import { Pool } from "pg";
import { VAULT_PROGRAM_ID } from "@cometail/client";
import { Chain } from "./chain";
import { log, parseEvents } from "./tx";

const SCHEMA = `
create table if not exists events (
  signature text not null, idx int not null, slot bigint not null, block_time bigint, name text not null, data jsonb not null,
  primary key (signature, idx)
);
create index if not exists events_name_idx on events (name);
create index if not exists events_vault_idx on events ((data->>'vault'));
create table if not exists cursor (id int primary key, signature text not null);
create table if not exists vaults (vault text primary key, data jsonb not null, updated_at timestamptz not null default now());
create table if not exists streams (stream text primary key, vault text not null, data jsonb not null, updated_at timestamptz not null default now());
`;

const plain = (v: any): any => JSON.parse(JSON.stringify(v, (_, x) => (typeof x === "bigint" ? x.toString() : x instanceof PublicKey ? x.toBase58() : x && x.constructor && x.constructor.name === "BN" ? x.toString() : x)));

export class Indexer {
  readonly db: Pool;
  constructor(readonly chain: Chain, databaseUrl: string) { this.db = new Pool({ connectionString: databaseUrl }); }

  async init(): Promise<void> { await this.db.query(SCHEMA); }

  async pass(): Promise<void> {
    await this.indexEvents();
    await this.snapshot();
  }

  private async indexEvents(): Promise<void> {
    const conn: Connection = this.chain.connection;
    const cur = await this.db.query("select signature from cursor where id = 1");
    const until: string | undefined = cur.rows[0]?.signature;
    // newest first from the RPC; stop at the cursor, then apply oldest first
    const sigs: { signature: string; slot: number; blockTime: number | null }[] = [];
    let before: string | undefined;
    for (;;) {
      const page = await conn.getSignaturesForAddress(VAULT_PROGRAM_ID, { before, until, limit: 1000 }, "confirmed");
      sigs.push(...page.map((s) => ({ signature: s.signature, slot: s.slot, blockTime: s.blockTime ?? null })));
      if (page.length < 1000) break;
      before = page[page.length - 1].signature;
    }
    sigs.reverse();
    for (const s of sigs) {
      const tx = await conn.getTransaction(s.signature, { commitment: "confirmed", maxSupportedTransactionVersion: 0 });
      if (!tx || tx.meta?.err) { await this.db.query("insert into cursor (id, signature) values (1, $1) on conflict (id) do update set signature = $1", [s.signature]); continue; }
      const events = parseEvents(this.chain.events, tx.meta?.logMessages ?? []);
      const client = await this.db.connect();
      try {
        await client.query("begin");
        for (let i = 0; i < events.length; i++) {
          await client.query(
            "insert into events (signature, idx, slot, block_time, name, data) values ($1, $2, $3, $4, $5, $6) on conflict do nothing",
            [s.signature, i, s.slot, s.blockTime, events[i].name, plain(events[i].data)],
          );
        }
        await client.query("insert into cursor (id, signature) values (1, $1) on conflict (id) do update set signature = $1", [s.signature]);
        await client.query("commit");
      } catch (e) {
        await client.query("rollback");
        throw e;
      } finally {
        client.release();
      }
      if (events.length) log("indexed", { signature: s.signature, events: events.map((e) => e.name) });
    }
  }

  private async snapshot(): Promise<void> {
    const vaults = await this.chain.vaults();
    for (const v of vaults) {
      await this.db.query("insert into vaults (vault, data, updated_at) values ($1, $2, now()) on conflict (vault) do update set data = $2, updated_at = now()", [v.pubkey.toBase58(), plain(v.account)]);
      const streams = await this.chain.streams(v.pubkey);
      for (const s of streams) {
        await this.db.query("insert into streams (stream, vault, data, updated_at) values ($1, $2, $3, now()) on conflict (stream) do update set data = $3, updated_at = now()", [s.pubkey.toBase58(), v.pubkey.toBase58(), plain(s.account)]);
      }
    }
  }

  async close(): Promise<void> { await this.db.end(); }
}
