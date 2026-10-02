// Storage behind the indexer and the API: Postgres in production (DATABASE_URL=postgres://...),
// SQLite through node's built-in driver anywhere else (DATABASE_URL=sqlite:<file>). Both hold
// the same four tables plus the Sky scan; JSON columns carry the decoded accounts and events.
import { PublicKey } from "@solana/web3.js";

export interface EventRow { signature: string; idx: number; slot: number; blockTime: number | null; name: string; vault: string | null; data: any }
export interface SkyRow {
  pool: string; config: string; baseMint: string; quoteMint: string; creator: string; custody: "wallet" | "program" | "unknown";
  progress: number; eligible: boolean; reasons: string[]; creatorPct: number; partnerPct: number; creatorFeePct: number;
  claimableLamports: string; realizedLamports: string; tradingFeeLamports: string; dammPool: string | null; updatedAt: number;
}

export interface Store {
  init(): Promise<void>;
  getCursor(): Promise<string | null>;
  setCursor(signature: string): Promise<void>;
  insertEvents(rows: EventRow[], cursor: string): Promise<void>;
  upsertVault(vault: string, data: any): Promise<void>;
  upsertStream(stream: string, vault: string, data: any): Promise<void>;
  upsertSky(rows: SkyRow[]): Promise<void>;
  listVaults(): Promise<{ vault: string; data: any; updatedAt: number }[]>;
  getVault(vault: string): Promise<{ vault: string; data: any; updatedAt: number } | null>;
  listStreams(vault: string): Promise<{ stream: string; data: any }[]>;
  listEvents(vault: string | null, limit: number): Promise<EventRow[]>;
  listSky(limit: number): Promise<SkyRow[]>;
  close(): Promise<void>;
}

/** JSON-safe copy: bigints and BNs to strings, public keys to base58. */
export const plain = (v: any): any =>
  JSON.parse(JSON.stringify(v, (_, x) => (typeof x === "bigint" ? x.toString() : x instanceof PublicKey ? x.toBase58() : x && x.constructor && x.constructor.name === "BN" ? x.toString() : x)));

export function openStore(url: string): Store {
  if (url.startsWith("postgres://") || url.startsWith("postgresql://")) return new PgStore(url);
  if (url.startsWith("sqlite:")) return new SqliteStore(url.slice("sqlite:".length));
  throw new Error("DATABASE_URL must start with postgres:// or sqlite:");
}

// ---- Postgres ----
class PgStore implements Store {
  private pool: any;
  constructor(private url: string) {}
  async init() {
    const { Pool } = await import("pg");
    this.pool = new Pool({ connectionString: this.url });
    await this.pool.query(`
      create table if not exists events (signature text not null, idx int not null, slot bigint not null, block_time bigint, name text not null, vault text, data jsonb not null, primary key (signature, idx));
      create index if not exists events_vault_idx on events (vault);
      create table if not exists cursor (id int primary key, signature text not null);
      create table if not exists vaults (vault text primary key, data jsonb not null, updated_at bigint not null);
      create table if not exists streams (stream text primary key, vault text not null, data jsonb not null, updated_at bigint not null);
      create table if not exists sky (pool text primary key, data jsonb not null, updated_at bigint not null);`);
  }
  async getCursor() { const r = await this.pool.query("select signature from cursor where id = 1"); return r.rows[0]?.signature ?? null; }
  async setCursor(s: string) { await this.pool.query("insert into cursor (id, signature) values (1, $1) on conflict (id) do update set signature = $1", [s]); }
  async insertEvents(rows: EventRow[], cursor: string) {
    const c = await this.pool.connect();
    try {
      await c.query("begin");
      for (const r of rows) await c.query("insert into events (signature, idx, slot, block_time, name, vault, data) values ($1,$2,$3,$4,$5,$6,$7) on conflict do nothing", [r.signature, r.idx, r.slot, r.blockTime, r.name, r.vault, r.data]);
      await c.query("insert into cursor (id, signature) values (1, $1) on conflict (id) do update set signature = $1", [cursor]);
      await c.query("commit");
    } catch (e) { await c.query("rollback"); throw e; } finally { c.release(); }
  }
  async upsertVault(vault: string, data: any) { await this.pool.query("insert into vaults (vault, data, updated_at) values ($1,$2,$3) on conflict (vault) do update set data = $2, updated_at = $3", [vault, data, Date.now()]); }
  async upsertStream(stream: string, vault: string, data: any) { await this.pool.query("insert into streams (stream, vault, data, updated_at) values ($1,$2,$3,$4) on conflict (stream) do update set data = $3, updated_at = $4", [stream, vault, data, Date.now()]); }
  async upsertSky(rows: SkyRow[]) { for (const r of rows) await this.pool.query("insert into sky (pool, data, updated_at) values ($1,$2,$3) on conflict (pool) do update set data = $2, updated_at = $3", [r.pool, r, r.updatedAt]); }
  async listVaults() { const r = await this.pool.query("select vault, data, updated_at from vaults order by updated_at desc"); return r.rows.map((x: any) => ({ vault: x.vault, data: x.data, updatedAt: Number(x.updated_at) })); }
  async getVault(vault: string) { const r = await this.pool.query("select vault, data, updated_at from vaults where vault = $1", [vault]); return r.rows[0] ? { vault: r.rows[0].vault, data: r.rows[0].data, updatedAt: Number(r.rows[0].updated_at) } : null; }
  async listStreams(vault: string) { const r = await this.pool.query("select stream, data from streams where vault = $1", [vault]); return r.rows; }
  async listEvents(vault: string | null, limit: number) {
    const r = vault ? await this.pool.query("select * from events where vault = $1 order by slot desc, idx desc limit $2", [vault, limit]) : await this.pool.query("select * from events order by slot desc, idx desc limit $1", [limit]);
    return r.rows.map((x: any) => ({ signature: x.signature, idx: x.idx, slot: Number(x.slot), blockTime: x.block_time === null ? null : Number(x.block_time), name: x.name, vault: x.vault, data: x.data }));
  }
  async listSky(limit: number) { const r = await this.pool.query("select data from sky order by (data->>'claimableLamports')::numeric desc limit $1", [limit]); return r.rows.map((x: any) => x.data); }
  async close() { await this.pool.end(); }
}

// ---- SQLite (node:sqlite) ----
class SqliteStore implements Store {
  private db: any;
  constructor(private file: string) {}
  async init() {
    const { DatabaseSync } = await import("node:sqlite");
    this.db = new DatabaseSync(this.file);
    this.db.exec(`
      create table if not exists events (signature text not null, idx integer not null, slot integer not null, block_time integer, name text not null, vault text, data text not null, primary key (signature, idx));
      create index if not exists events_vault_idx on events (vault);
      create table if not exists cursor (id integer primary key, signature text not null);
      create table if not exists vaults (vault text primary key, data text not null, updated_at integer not null);
      create table if not exists streams (stream text primary key, vault text not null, data text not null, updated_at integer not null);
      create table if not exists sky (pool text primary key, data text not null, claimable text not null, updated_at integer not null);`);
  }
  async getCursor() { const r = this.db.prepare("select signature from cursor where id = 1").get(); return r ? r.signature : null; }
  async setCursor(s: string) { this.db.prepare("insert into cursor (id, signature) values (1, ?) on conflict (id) do update set signature = excluded.signature").run(s); }
  async insertEvents(rows: EventRow[], cursor: string) {
    this.db.exec("begin");
    try {
      const ins = this.db.prepare("insert or ignore into events (signature, idx, slot, block_time, name, vault, data) values (?,?,?,?,?,?,?)");
      for (const r of rows) ins.run(r.signature, r.idx, r.slot, r.blockTime, r.name, r.vault, JSON.stringify(r.data));
      await this.setCursor(cursor);
      this.db.exec("commit");
    } catch (e) { this.db.exec("rollback"); throw e; }
  }
  async upsertVault(vault: string, data: any) { this.db.prepare("insert into vaults (vault, data, updated_at) values (?,?,?) on conflict (vault) do update set data = excluded.data, updated_at = excluded.updated_at").run(vault, JSON.stringify(data), Date.now()); }
  async upsertStream(stream: string, vault: string, data: any) { this.db.prepare("insert into streams (stream, vault, data, updated_at) values (?,?,?,?) on conflict (stream) do update set data = excluded.data, updated_at = excluded.updated_at").run(stream, vault, JSON.stringify(data), Date.now()); }
  async upsertSky(rows: SkyRow[]) {
    const ins = this.db.prepare("insert into sky (pool, data, claimable, updated_at) values (?,?,?,?) on conflict (pool) do update set data = excluded.data, claimable = excluded.claimable, updated_at = excluded.updated_at");
    for (const r of rows) ins.run(r.pool, JSON.stringify(r), r.claimableLamports.padStart(24, "0"), r.updatedAt);
  }
  async listVaults() { return this.db.prepare("select vault, data, updated_at from vaults order by updated_at desc").all().map((x: any) => ({ vault: x.vault, data: JSON.parse(x.data), updatedAt: x.updated_at })); }
  async getVault(vault: string) { const x = this.db.prepare("select vault, data, updated_at from vaults where vault = ?").get(vault); return x ? { vault: x.vault, data: JSON.parse(x.data), updatedAt: x.updated_at } : null; }
  async listStreams(vault: string) { return this.db.prepare("select stream, data from streams where vault = ?").all(vault).map((x: any) => ({ stream: x.stream, data: JSON.parse(x.data) })); }
  async listEvents(vault: string | null, limit: number) {
    const rows = vault ? this.db.prepare("select * from events where vault = ? order by slot desc, idx desc limit ?").all(vault, limit) : this.db.prepare("select * from events order by slot desc, idx desc limit ?").all(limit);
    return rows.map((x: any) => ({ signature: x.signature, idx: x.idx, slot: x.slot, blockTime: x.block_time, name: x.name, vault: x.vault, data: JSON.parse(x.data) }));
  }
  async listSky(limit: number) { return this.db.prepare("select data from sky order by claimable desc limit ?").all(limit).map((x: any) => JSON.parse(x.data)); }
  async close() { this.db.close(); }
}
