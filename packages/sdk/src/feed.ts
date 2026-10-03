import type { ControlFrame, FeedEvent } from "./types.js";
import { compareCursors, decodeFrame, isFeedEvent, parseCursor, ProtocolError, FeedGapError } from "./protocol.js";
/** Browser WebSocket and standards-compatible Node implementations satisfy this interface. */
export interface SocketLike {
  addEventListener(type: string, listener: (event: Event) => void): void;
  close(code?: number, reason?: string): void;
}
export interface FeedOptions {
  since?: string;
  /** A resolved callback acknowledges delivery. A rejection stops without advancing the cursor. */
  onEvent: (event: FeedEvent) => void | Promise<void>;
  onControl?: (frame: ControlFrame) => void;
  onError?: (error: Error) => void;
  onState?: (state: "connecting" | "open" | "retrying" | "closed") => void;
  socketFactory?: (url: string) => SocketLike;
  signal?: AbortSignal;
  cluster?: string;
  reconnect?: boolean;
  retryDelayMs?: number;
  maxRetryDelayMs?: number;
  maxRetries?: number;
  /** Zero disables the watchdog. The server normally pings every 25 seconds. */
  heartbeatTimeoutMs?: number;
  maxPendingEvents?: number;
  maxFrameChars?: number;
}
export class FeedSubscription {
  private socket?: SocketLike;
  private retryTimer?: ReturnType<typeof setTimeout>;
  private watchdog?: ReturnType<typeof setTimeout>;
  private tail: Promise<void> = Promise.resolve();
  private pending = 0;
  private failures = 0;
  private stopped = false;
  private delivered?: string;
  private cluster?: string;
  private readonly factory: (url: string) => SocketLike;
  private readonly url: string;
  private readonly retryDelay: number;
  private readonly maxRetryDelay: number;
  private readonly heartbeat: number;
  private readonly maxPending: number;
  private readonly maxChars: number;
  private readonly maxRetries: number;
  private readonly abort = () => this.close();
  constructor(baseUrl: string, private readonly options: FeedOptions) {
    const origin = new URL(baseUrl);
    if (!["https:", "http:"].includes(origin.protocol) || origin.username || origin.password || origin.pathname !== "/" || origin.search || origin.hash) throw new TypeError("baseUrl must be an HTTP(S) origin without credentials");
    const u = new URL("/api/feed", origin); u.protocol = u.protocol === "https:" ? "wss:" : "ws:";
    this.url = u.href; this.delivered = options.since; this.cluster = options.cluster;
    if (this.delivered !== undefined) parseCursor(this.delivered);
    this.retryDelay = options.retryDelayMs ?? 500; this.maxRetryDelay = options.maxRetryDelayMs ?? 30_000;
    this.heartbeat = options.heartbeatTimeoutMs ?? 65_000; this.maxPending = options.maxPendingEvents ?? 500;
    this.maxChars = options.maxFrameChars ?? 1_000_000; this.maxRetries = options.maxRetries ?? Infinity;
    if (!Number.isFinite(this.retryDelay) || this.retryDelay < 0 || !Number.isFinite(this.maxRetryDelay) || this.maxRetryDelay < this.retryDelay || !Number.isFinite(this.heartbeat) || this.heartbeat < 0 || !Number.isInteger(this.maxPending) || this.maxPending < 1 || !Number.isFinite(this.maxChars) || this.maxChars < 1 || (this.maxRetries !== Infinity && (!Number.isInteger(this.maxRetries) || this.maxRetries < 0))) throw new RangeError("Invalid feed timing or queue limits");
    this.factory = options.socketFactory ?? (url => {
      if (typeof globalThis.WebSocket === "undefined") throw new Error("Supply socketFactory when WebSocket is unavailable");
      return new globalThis.WebSocket(url);
    });
    if (!options.socketFactory && typeof globalThis.WebSocket === "undefined") throw new TypeError("Supply socketFactory when WebSocket is unavailable");
    if (options.signal?.aborted) { this.stopped = true; return; }
    options.signal?.addEventListener("abort", this.abort, { once: true });
    this.connect();
  }
  /** Last event whose consumer callback completed; hello never moves this watermark. */
  get cursor(): string | undefined { return this.delivered; }
  get closed(): boolean { return this.stopped; }
  close(): void {
    if (this.stopped) return;
    this.stopped = true; clearTimeout(this.retryTimer); clearTimeout(this.watchdog);
    this.options.signal?.removeEventListener("abort", this.abort);
    const socket = this.socket; this.socket = undefined;
    try { socket?.close(1000, "Client closed"); } catch { /* already closed */ }
    this.state("closed");
  }
  private state(state: "connecting" | "open" | "retrying" | "closed"): void {
    try { this.options.onState?.(state); } catch (e) { this.fail(e); }
  }
  private report(error: unknown): void {
    try { this.options.onError?.(error instanceof Error ? error : new Error(String(error))); } catch { this.close(); }
  }
  private fail(error: unknown): void { this.report(error); this.close(); }
  private arm(socket: SocketLike): void {
    clearTimeout(this.watchdog);
    if (this.heartbeat) this.watchdog = setTimeout(() => this.disconnect(socket, new Error("Feed heartbeat timed out")), this.heartbeat);
  }
  private retry(): void {
    if (this.stopped) return;
    if (this.options.reconnect === false || this.failures >= this.maxRetries) { this.close(); return; }
    const delay = Math.min(this.maxRetryDelay, this.retryDelay * 2 ** Math.min(this.failures++, 30));
    this.state("retrying");
    if (!this.stopped) this.retryTimer = setTimeout(() => this.connect(), delay);
  }
  private disconnect(socket: SocketLike, error?: Error): void {
    if (this.socket !== socket || this.stopped) return;
    this.socket = undefined; clearTimeout(this.watchdog);
    if (error) this.report(error);
    try { socket.close(); } catch { /* transport already gone */ }
    // Drain already received events before choosing the resume cursor.
    void this.tail.then(() => this.retry());
  }
  private connect(): void {
    if (this.stopped) return;
    this.state("connecting"); if (this.stopped) return;
    const url = new URL(this.url); if (this.delivered !== undefined) url.searchParams.set("since", this.delivered);
    let socket: SocketLike;
    try { socket = this.factory(url.href); } catch (e) { this.report(e); this.retry(); return; }
    this.socket = socket; let received: string | undefined;
    this.arm(socket);
    socket.addEventListener("open", () => { if (this.socket === socket && !this.stopped) this.state("open"); });
    socket.addEventListener("error", () => this.disconnect(socket, new Error("Feed transport error")));
    socket.addEventListener("close", () => this.disconnect(socket));
    socket.addEventListener("message", event => {
      if (this.stopped || this.socket !== socket) return;
      try {
        const data = (event as MessageEvent<unknown>).data;
        if (typeof data !== "string" || data.length > this.maxChars) throw new ProtocolError("Expected a bounded JSON text frame");
        const frame = decodeFrame(JSON.parse(data)); this.arm(socket); this.failures = 0;
        if (!isFeedEvent(frame)) {
          this.options.onControl?.(frame);
          if (frame.type === "gap") this.fail(new FeedGapError(frame.oldest, frame.resume));
          return;
        }
        if (this.cluster !== undefined && frame.cluster !== this.cluster) throw new ProtocolError("Feed cluster changed");
        this.cluster = frame.cluster;
        if (received !== undefined && compareCursors(frame.cursor, received) <= 0) throw new ProtocolError("Feed events are not strictly increasing within the connection");
        received = frame.cursor;
        if (this.delivered !== undefined && compareCursors(frame.cursor, this.delivered) <= 0) return;
        if (this.pending >= this.maxPending) throw new ProtocolError("Feed consumer queue is full; resume from the last delivered cursor");
        this.pending++;
        this.tail = this.tail.then(async () => {
          try {
            if (this.stopped) return;
            await this.options.onEvent(frame);
            if (!this.stopped) this.delivered = frame.cursor;
          } finally { this.pending--; }
        }).catch(e => this.fail(e));
      } catch (e) { this.fail(e); }
    });
  }
}
