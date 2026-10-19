// The Fee Index reader: a worker thread with its own read-only connection that runs the index's slow reads
// (feeindex-read.ts) away from the indexer's thread, which also serves the API. A read that fails, runs past
// its time limit, or finds the thread down is refused with an error (the API answers 503 for the Fee Index
// only); it is never run on the indexer's thread instead, so nothing the Fee Index reads can freeze the API.
// A thread that stops, or is retired after a read ran past its limit, is replaced once, with backoff.
import { Worker } from "worker_threads";
import * as path from "path";
import type { ReadContext, ReadName } from "./feeindex-read";
import { log } from "./tx";

const ENTRY = path.join(__dirname, "feeindex-reader-entry.cjs");

export class ReaderUnavailable extends Error {}

/** What the reader needs of a worker thread (a real Worker; tests pass one whose exit they control). */
export interface ReaderThread {
  on(event: "message", f: (m: any) => void): unknown;
  on(event: "error", f: (e: Error) => void): unknown;
  on(event: "exit", f: (code: number) => void): unknown;
  postMessage(m: unknown): void;
  terminate(): Promise<number> | void;
}
export type MakeThread = (entry: string, workerData: unknown, maxOldGenerationSizeMb: number) => ReaderThread;
const realThread: MakeThread = (entry, workerData, maxOldGenerationSizeMb) => new Worker(entry, { workerData, resourceLimits: { maxOldGenerationSizeMb } });

export class IndexReader {
  /** The live thread; null while none is ready to take reads (starting, retired, stopped). */
  private w: ReaderThread | null = null;
  private seq = 0;
  private pending = new Map<number, { resolve: (v: any) => void; reject: (e: Error) => void; timer: ReturnType<typeof setTimeout> }>();
  private closed = false;
  private backoffMs = 1_000;
  private restartTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(private file: string, private ctx: ReadContext, readonly name: string, private opts: { timeoutMs?: number; maxOldGenerationSizeMb?: number; makeThread?: MakeThread } = {}, private report: (msg: string, extra: Record<string, unknown>) => void = log) {}

  /** Starts a thread and resolves once its connection is open (rejects if it cannot open). */
  start(): Promise<void> {
    return new Promise((resolve, reject) => {
      const w = (this.opts.makeThread ?? realThread)(ENTRY, { file: this.file, ctx: this.ctx }, this.opts.maxOldGenerationSizeMb ?? 256);
      let settled = false;
      w.on("message", (m: any) => {
        if (m && m.ready) {
          if (settled) return;
          settled = true;
          if (this.closed) { void w.terminate(); reject(new ReaderUnavailable(`fee index reader ${this.name} closed`)); return; }
          this.w = w; this.backoffMs = 1_000; resolve(); return;
        }
        if (this.w !== w) return; // a retired thread's late answer: its reads were already refused
        const p = this.pending.get(m.id);
        if (!p) return;
        this.pending.delete(m.id); clearTimeout(p.timer);
        if (m.ok) p.resolve(m.value); else p.reject(new Error(m.error));
      });
      w.on("error", (e) => { this.report("fee index reader failed", { reader: this.name, error: String(e.message ?? e) }); });
      w.on("exit", (code) => {
        if (!settled) { settled = true; reject(new Error(`fee index reader ${this.name} exited (${code}) before it was ready`)); return; }
        this.retire(w, `fee index reader ${this.name} stopped`, { code });
      });
    });
  }

  /** Takes a thread out of service at once: no read is posted to it again, every read waiting on it is refused
   *  (once), it is terminated, and one replacement is scheduled. A thread already retired is left alone, so a
   *  late timeout or exit of an old thread never touches its replacement. */
  private retire(w: ReaderThread, why: string, extra: Record<string, unknown> = {}) {
    if (this.w !== w) return;
    this.w = null;
    for (const p of this.pending.values()) { clearTimeout(p.timer); p.reject(new ReaderUnavailable(why)); }
    this.pending.clear();
    void w.terminate();
    if (this.closed || this.restartTimer) return;
    this.report("fee index reader stopped; starting it again", { reader: this.name, why, inMs: this.backoffMs, ...extra });
    this.restartTimer = setTimeout(() => {
      this.restartTimer = null;
      if (this.closed) return;
      this.start().catch((e) => {
        this.report("fee index reader could not start", { reader: this.name, error: String((e as Error).message ?? e) });
        // the failed thread never went into service; try again later
        if (!this.closed && !this.w && !this.restartTimer) this.restartTimer = setTimeout(() => { this.restartTimer = null; if (!this.closed) void this.start().catch(() => {}); }, this.backoffMs);
      });
    }, this.backoffMs);
    this.backoffMs = Math.min(60_000, this.backoffMs * 2);
  }

  /** One read in the thread. Refused at once while no thread is in service; a read past the time limit is refused
   *  and its thread retired (and replaced), so a stuck query never holds later ones. */
  call<T>(op: ReadName, ...args: unknown[]): Promise<T> {
    const w = this.w;
    if (!w) return Promise.reject(new ReaderUnavailable(`fee index reader ${this.name} not running`));
    const id = ++this.seq;
    return new Promise<T>((resolve, reject) => {
      const timeoutMs = this.opts.timeoutMs ?? 30_000;
      const timer = setTimeout(() => {
        if (!this.pending.delete(id)) return;
        reject(new ReaderUnavailable(`fee index read ${op} ran past ${timeoutMs} ms`));
        this.report("fee index read ran past its limit; retiring the reader", { reader: this.name, op, timeoutMs });
        this.retire(w, `fee index reader ${this.name} retired after a read ran past ${timeoutMs} ms`);
      }, timeoutMs);
      this.pending.set(id, { resolve, reject, timer });
      w.postMessage({ id, op, args });
    });
  }

  async close() {
    this.closed = true;
    if (this.restartTimer) { clearTimeout(this.restartTimer); this.restartTimer = null; }
    const w = this.w; this.w = null;
    for (const p of this.pending.values()) { clearTimeout(p.timer); p.reject(new ReaderUnavailable(`fee index reader ${this.name} closed`)); }
    this.pending.clear();
    if (w) await w.terminate();
  }
}
