// The public feed (docs/api.md): every program event, trade, launch and graduation as one ordered
// row, replayable from a cursor over GET /api/feed and pushed live over a WebSocket at the same
// path. The socket is a small RFC 6455 server: text frames out, close and ping frames in; it adds
// no dependency. Provenance is on every row: "chain" for what a transaction said, "indexer" for
// what the scan derived, "estimate" for estimates (with a basis in the data).
import crypto from "crypto";
import { EventEmitter } from "events";
import http from "http";
import net from "net";
import { EventRow, FeedRow, Store, TokenRow, TradeRow } from "./store";
import { log } from "./tx";

export const FEED_RETENTION_SLOTS = 1_512_000; // about seven days at 0.4 s per slot
export const feedBus = new EventEmitter();
feedBus.setMaxListeners(1000);

/** "seq:slot:signature": the publication sequence first (unique, strictly increasing in the order
 *  rows were published), then the slot and the signature as information. Compare by `seq`. */
export type Cursor = { seq: number; slot: number; signature: string };
export type CursorLike = { seq?: number; slot: number; signature: string };
export const cursorOf = (c: { seq?: number; slot: number; signature: string }) => `${c.seq ?? 0}:${c.slot}:${c.signature}`;
export function parseCursor(s: string | null | undefined): Cursor | null {
  if (!s) return null;
  const m = /^(\d{1,12}):(\d{1,12}):([^:\s]{1,96})$/.exec(s);
  return m ? { seq: Number(m[1]), slot: Number(m[2]), signature: m[3] } : null;
}
export const compareCursor = (a: { seq?: number }, b: { seq?: number }) => (a.seq ?? 0) - (b.seq ?? 0);
/** The cursor to pass as `since` so that `oldest` itself is delivered (since is exclusive). */
export const resumeBefore = (oldest: CursorLike): string => `${Math.max(0, (oldest.seq ?? 0) - 1)}:${oldest.slot}:~`;

const now = () => Date.now();
const chain = (signature: string, slot: number) => ({ source: "chain", signature, slot });

/** Program events to feed rows. Every event becomes a row: the named ones with their contract
 *  shape, the rest as `vault` rows carrying the event name, so nothing a vault does is missing. */
export function feedFromEvents(rows: EventRow[]): FeedRow[] {
  const out: FeedRow[] = [];
  for (const e of rows) {
    const base = { slot: e.slot, ordinal: e.idx, signature: e.signature, vault: e.vault, mint: null as string | null, provenance: chain(e.signature, e.slot), at: now() };
    const d = e.data ?? {};
    switch (e.name) {
      case "harvested": case "oneTimeHarvested":
        out.push({ ...base, type: "harvest", data: { vault: e.vault, stream: d.stream ?? null, incomeLamports: d.toIncome ?? d.income ?? null, grossLamports: d.gross ?? null, toDepositorLamports: d.toDepositor ?? null, toProtocolLamports: d.toProtocol ?? null, oneTime: e.name === "oneTimeHarvested", signature: e.signature } }); break;
      case "routed":
        out.push({ ...base, type: "bid", data: { vault: e.vault, order: d.limitOrder ?? d.order ?? null, bins: Number(d.bins ?? 0), grossLamports: d.gross ?? d.grossSpent ?? null, signature: e.signature } }); break;
      case "settled":
        out.push({ ...base, type: "fill", data: { vault: e.vault, order: d.limitOrder ?? d.order ?? null, burnedStRaw: d.burnedSt ?? d.burned ?? null, unfilledLamports: d.unfilled ?? d.refunded ?? null, signature: e.signature } }); break;
      case "cashedOut":
        out.push({ ...base, type: "cashout", data: { vault: e.vault, depositorLamports: d.amount ?? null, signature: e.signature } }); break;
      case "unwound":
        out.push({ ...base, type: "unwind", mint: d.stMint ?? null, data: { vault: e.vault, stMint: d.stMint ?? null, dbcPool: d.dbcPool ?? null, incomeReturned: d.incomeReturned ?? null, launchedAt: d.launchedAt ?? null, unwoundAt: d.unwoundAt ?? null, signature: e.signature } }); break;
      default:
        out.push({ ...base, type: "vault", mint: d.stMint ?? null, data: { vault: e.vault, event: e.name, ...d, signature: e.signature } });
    }
  }
  return out;
}

export function feedFromTrades(rows: TradeRow[], mintOfPool: (pool: string) => string | null): FeedRow[] {
  return rows.map((t) => ({
    slot: t.slot, ordinal: t.idx, signature: t.signature, type: "trade", vault: t.vault || null, mint: mintOfPool(t.pool), provenance: chain(t.signature, t.slot), at: now(),
    data: { mint: mintOfPool(t.pool), pool: t.pool, venue: t.venue ?? null, side: t.buy ? "buy" : "sell", baseAmountRaw: t.baseAmountRaw ?? null, quoteAmountLamports: t.quoteAmountLamports ?? null, executionPriceSol: t.executionPriceSol ?? null, executionPriceQuote: t.executionPriceQuote ?? t.executionPriceSol ?? null, quoteMint: t.quoteMint ?? "So11111111111111111111111111111111111111112", quoteDecimals: t.quoteDecimals ?? 9, trader: t.trader, traderKind: t.traderKind, signature: t.signature },
  }));
}

/** Launches and graduations from one token scan against the previous one. Token rows carry no
 *  transaction: their identity is (type, mint), so a retried scan cannot publish one twice, and the
 *  slot is the scan's observed slot. */
export function feedFromTokens(previous: Map<string, TokenRow>, next: TokenRow[], observedSlot: number): FeedRow[] {
  const out: FeedRow[] = [];
  for (const t of next) {
    const was = previous.get(t.mint);
    if (!was) {
      out.push({ slot: observedSlot, ordinal: 0, signature: t.mint, type: "launch", vault: t.vault, mint: t.mint, at: now(), provenance: { source: "indexer", slot: observedSlot, scannedAtMs: t.updatedAt },
        data: { mint: t.mint, name: t.name, symbol: t.symbol, imageUrl: t.imageUrl, creator: t.creator, config: t.config, dbcPool: t.dbcPool, quoteMint: t.quoteMint, tokenKind: t.tokenKind, stage: t.stage, createdAtMs: t.createdAtMs } });
    }
    if (t.stage === "graduated" && (!was || was.stage !== "graduated")) {
      out.push({ slot: observedSlot, ordinal: 1, signature: t.mint, type: "graduation", vault: t.vault, mint: t.mint, at: now(), provenance: { source: "indexer", slot: observedSlot, scannedAtMs: t.updatedAt },
        data: { mint: t.mint, dbcPool: t.dbcPool, dammPool: t.dammPool, quoteMint: t.quoteMint } });
    }
  }
  return out;
}

/** Append durably, then push what was new (a row already published is never pushed twice). */
export async function publish(store: Store, rows: FeedRow[]): Promise<void> {
  if (!rows.length) return;
  const inserted = await store.appendFeed(rows);
  for (const r of inserted) feedBus.emit("event", r);
}

export function frame(cluster: string, type: string, extra: Record<string, unknown>) {
  return { schemaVersion: 1, cluster, type, generatedAtMs: now(), ...extra };
}
export function rowFrame(cluster: string, r: FeedRow) {
  return frame(cluster, r.type, { cursor: cursorOf(r), observedSlot: r.slot, provenance: r.provenance, data: r.data });
}

/** Replay from an exclusive cursor: { events, nextCursor } or an expiry. */
export async function replay(store: Store, cluster: string, since: CursorLike | null, limit: number): Promise<{ status: 200 | 410; body: any }> {
  const oldest = await store.oldestFeed();
  if (since && oldest && compareCursor(since, oldest) < 0 && cursorOf(since) !== resumeBefore(oldest)) {
    return { status: 410, body: { error: "cursor expired", oldest: cursorOf(oldest), resume: resumeBefore(oldest) } };
  }
  // a cursor beyond the head comes from another database generation: explicit, never silent
  const head = since ? await store.headFeed() : null;
  if (since && (!head || compareCursor(since, head) > 0) && (!oldest || cursorOf(since) !== resumeBefore(oldest))) {
    const resume = oldest ? resumeBefore(oldest) : "0:0:~";
    return { status: 410, body: { error: "cursor unknown", oldest: oldest ? cursorOf(oldest) : null, resume } };
  }
  const rows = await store.listFeedSince(since ? { seq: since.seq ?? 0 } : null, limit + 1);
  const page = rows.slice(0, limit);
  return { status: 200, body: { ...frame(cluster, "replay", {}), events: page.map((r) => rowFrame(cluster, r)), nextCursor: rows.length > limit && page.length ? cursorOf(page[page.length - 1]) : null } };
}

// ---- the socket ----
const GUID = "258EAFA5-E914-47DA-95CA-C5AB0DC85B11";
function encodeText(text: string): Buffer {
  const payload = Buffer.from(text, "utf8");
  let header: Buffer;
  if (payload.length < 126) { header = Buffer.alloc(2); header[1] = payload.length; }
  else if (payload.length < 65536) { header = Buffer.alloc(4); header[1] = 126; header.writeUInt16BE(payload.length, 2); }
  else { header = Buffer.alloc(10); header[1] = 127; header.writeBigUInt64BE(BigInt(payload.length), 2); }
  header[0] = 0x81; // FIN + text
  return Buffer.concat([header, payload]);
}
const control = (opcode: number, payload: Buffer = Buffer.alloc(0)) => Buffer.concat([Buffer.from([0x80 | opcode, payload.length]), payload]);

class Client {
  private buffer = Buffer.alloc(0);
  closed = false;
  constructor(public socket: net.Socket, public key: string) {}
  send(obj: unknown) {
    if (this.closed) return;
    const encoded = encodeText(JSON.stringify(obj));
    if (encoded.length + this.socket.writableLength > 1_048_576) { this.close(1013); return; }
    this.socket.write(encoded);
  }
  /** Parse whatever arrived: answer pings, honour close, ignore the rest (the client sends nothing the feed needs). */
  feed(chunk: Buffer) {
    this.buffer = Buffer.concat([this.buffer, chunk]);
    for (;;) {
      if (this.buffer.length < 2) return;
      const opcode = this.buffer[0] & 0x0f;
      const masked = (this.buffer[1] & 0x80) !== 0;
      let len = this.buffer[1] & 0x7f, off = 2;
      if (len === 126) { if (this.buffer.length < 4) return; len = this.buffer.readUInt16BE(2); off = 4; }
      else if (len === 127) { if (this.buffer.length < 10) return; len = Number(this.buffer.readBigUInt64BE(2)); off = 10; }
      if (len > 1 << 20) { this.close(1009); return; }
      const total = off + (masked ? 4 : 0) + len;
      if (this.buffer.length < total) return;
      const mask = masked ? this.buffer.subarray(off, off + 4) : null;
      const payload = Buffer.from(this.buffer.subarray(off + (masked ? 4 : 0), total));
      if (mask) for (let i = 0; i < payload.length; i++) payload[i] ^= mask[i & 3];
      this.buffer = this.buffer.subarray(total);
      if (opcode === 8) { this.close(1000, true); return; }
      if (opcode === 9) this.socket.write(control(0xa, payload));
      // text (1), binary (2), pong (10) and continuations are ignored
    }
  }
  close(code = 1000, replying = false) {
    if (this.closed) return;
    this.closed = true;
    try { const p = Buffer.alloc(2); p.writeUInt16BE(code, 0); this.socket.write(control(8, p)); } catch { /* gone */ }
    if (replying) this.socket.end(); else setTimeout(() => this.socket.destroy(), 500);
  }
}

export interface FeedOptions { cluster: string; maxPerClient: number; coverage: () => Promise<{ status: string; pendingPools: number; lastSuccessfulAtMs: number | null }> }

/** Attach the feed to the API server: upgrades on /api/feed, replay first, then live. */
export function attachFeed(server: http.Server, store: Store, opts: FeedOptions) {
  const clients = new Set<Client>();
  const perKey = new Map<string, number>();
  let lastCoverage = "";
  server.on("upgrade", async (req, socket: net.Socket, head) => {
    let url: URL;
    try { url = new URL(req.url ?? "/", "http://localhost"); } catch {
      socket.end("HTTP/1.1 400 Bad Request\r\nConnection: close\r\n\r\n"); return;
    }
    const key = req.headers["sec-websocket-key"];
    const refuse = (code: number, text: string) => { socket.write(`HTTP/1.1 ${code} ${text}\r\nConnection: close\r\n\r\n`); socket.destroy(); };
    if (url.pathname !== "/api/feed" || typeof key !== "string" || !/websocket/i.test(String(req.headers.upgrade))) return refuse(404, "Not Found");
    const remote = socket.remoteAddress ?? "";
    const fromProxy = remote === "127.0.0.1" || remote === "::1" || remote === "::ffff:127.0.0.1";
    const clientKey = (fromProxy ? String(req.headers["x-forwarded-for"] ?? "").split(",")[0].trim() : "") || remote;
    if ((perKey.get(clientKey) ?? 0) >= opts.maxPerClient) return refuse(429, "Too Many Connections");
    const since = url.searchParams.get("since");
    const sinceCursor = since ? parseCursor(since) : null;
    if (since && !sinceCursor) return refuse(400, "Bad Cursor");
    const accept = crypto.createHash("sha1").update(key + GUID).digest("base64");
    socket.write("HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: " + accept + "\r\n\r\n");
    const client = new Client(socket, clientKey);
    clients.add(client); perKey.set(clientKey, (perKey.get(clientKey) ?? 0) + 1);
    const drop = () => { if (clients.delete(client)) perKey.set(clientKey, Math.max(0, (perKey.get(clientKey) ?? 1) - 1)); };
    socket.on("data", (c: Buffer) => client.feed(c));
    socket.on("close", drop); socket.on("error", drop); socket.on("end", drop);
    if (head?.length) client.feed(head);
    let delivered: CursorLike | null = sinceCursor;
    let replaying = true;
    const queued: FeedRow[] = [];
    const live = (r: FeedRow) => {
      if (client.closed) return;
      if (replaying) {
        if (queued.length >= 1000) { client.close(1013); return; }
        queued.push(r);
      } else if (!delivered || compareCursor(r, delivered) > 0) {
        client.send(rowFrame(opts.cluster, r)); delivered = r;
      }
    };
    const detach = () => { feedBus.off("event", live); queued.length = 0; client.closed = true; };
    // Keep one listener installed through every await in replay/hello/coverage.
    feedBus.on("event", live);
    socket.once("close", detach); socket.once("error", detach); socket.once("end", detach);
    try {
      const oldest = await store.oldestFeed();
      const head0 = delivered ? await store.headFeed() : null;
      const expired = delivered && oldest && compareCursor(delivered, oldest) < 0 && cursorOf(delivered) !== resumeBefore(oldest);
      const unknown = delivered && (!head0 || compareCursor(delivered, head0) > 0) && (!oldest || cursorOf(delivered) !== resumeBefore(oldest));
      if (expired || unknown) {
        const resume = oldest ? resumeBefore(oldest) : "0:0:~";
        client.send(frame(opts.cluster, "gap", { oldest: oldest ? cursorOf(oldest) : null, resume }));
        delivered = parseCursor(resume);
      }
      if (delivered) for (;;) {
        if (client.closed) break;
        const rows = await store.listFeedSince({ seq: delivered.seq ?? 0 }, 500);
        for (const r of rows) {
          if (client.closed) break;
          client.send(rowFrame(opts.cluster, r)); delivered = r;
        }
        if (rows.length < 500) break;
      }
      const headRow = await store.headFeed();
      const coverage = await opts.coverage();
      if (client.closed) return;
      queued.sort(compareCursor);
      for (const r of queued) if (!delivered || compareCursor(r, delivered) > 0) {
        client.send(rowFrame(opts.cluster, r)); delivered = r;
      }
      queued.length = 0;
      client.send(frame(opts.cluster, "hello", { cursor: headRow ? cursorOf(headRow) : null, retentionSlots: FEED_RETENTION_SLOTS }));
      client.send(frame(opts.cluster, "coverage", coverage));
      replaying = false;
    } catch (e) {
      feedBus.off("event", live); queued.length = 0;
      log("feed socket failed", { error: String((e as Error).message ?? e) });
      client.close(1011);
    }
  });
  // heartbeat and coverage changes
  const timer = setInterval(async () => {
    const ping = frame(opts.cluster, "ping", {});
    for (const c of clients) { c.send(ping); try { c.socket.write(control(9)); } catch { /* gone */ } }
    try {
      const cov = await opts.coverage(); const key = `${cov.status}:${cov.pendingPools}`;
      if (key !== lastCoverage) { lastCoverage = key; const f = frame(opts.cluster, "coverage", cov); for (const c of clients) c.send(f); }
    } catch { /* next tick */ }
  }, 25_000);
  timer.unref();
  server.on("close", () => { clearInterval(timer); for (const c of clients) c.close(1001); });
  return { clients: () => clients.size };
}
