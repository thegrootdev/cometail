// The Fee Index reader: a worker thread with its own read-only connection that runs the index's slow reads
// (feeindex-read.ts) away from the indexer's thread, which also serves the API. A read that fails, runs past
// its time limit, or finds the thread down is refused with an error (the API answers 503 for the Fee Index
// only); it is never run on the indexer's thread instead, so nothing the Fee Index reads can freeze the API.
// A thread that stops (or is stopped after a read ran past its limit) is started again, with backoff.
import { Worker } from "worker_threads";
import * as path from "path";
import type { ReadContext, ReadName } from "./feeindex-read";
import { log } from "./tx";

const ENTRY = path.join(__dirname, "feeindex-reader-entry.cjs");

export class ReaderUnavailable extends Error {}

export class IndexReader {
  private w: Worker | null = null;
  private ready = false;
  private seq = 0;
  private pending = new Map<number, { resolve: (v: any) => void; reject: (e: Error) => void; timer: ReturnType<typeof setTimeout> }>();
  private closed = false;
  private backoffMs = 1_000;
  private restartTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(private file: string, private ctx: ReadContext, readonly name: string, private opts: { timeoutMs?: number; maxOldGenerationSizeMb?: number } = {}, private report: (msg: string, extra: Record<string, unknown>) => void = log) {}

  /** Starts the thread and resolves once its connection is open (rejects if it cannot open). */
  start(): Promise<void> {
    return new Promise((resolve, reject) => {
      const w = new Worker(ENTRY, { workerData: { file: this.file, ctx: this.ctx }, resourceLimits: { maxOldGenerationSizeMb: this.opts.maxOldGenerationSizeMb ?? 256 } });
      this.w = w; this.ready = false;
      let settled = false;
      w.on("message", (m: any) => {
        if (m && m.ready) { this.ready = true; this.backoffMs = 1_000; if (!settled) { settled = true; resolve(); } return; }
        const p = this.pending.get(m.id);
        if (!p) return;
        this.pending.delete(m.id); clearTimeout(p.timer);
        if (m.ok) p.resolve(m.value); else p.reject(new Error(m.error));
      });
      w.on("error", (e) => { if (!settled) { settled = true; reject(e); } this.report("fee index reader failed", { reader: this.name, error: String(e.message ?? e) }); });
      w.on("exit", (code) => {
        if (this.w === w) { this.w = null; this.ready = false; }
        for (const [id, p] of this.pending) { clearTimeout(p.timer); p.reject(new ReaderUnavailable(`fee index reader ${this.name} stopped`)); this.pending.delete(id); }
        if (!settled) { settled = true; reject(new Error(`fee index reader ${this.name} exited (${code}) before it was ready`)); return; }
        if (this.closed) return;
        this.report("fee index reader stopped; starting it again", { reader: this.name, code, inMs: this.backoffMs });
        this.restartTimer = setTimeout(() => { this.restartTimer = null; if (!this.closed) this.start().catch((e) => this.report("fee index reader could not start", { reader: this.name, error: String((e as Error).message ?? e) })); }, this.backoffMs);
        this.backoffMs = Math.min(60_000, this.backoffMs * 2);
      });
    });
  }

  /** One read in the thread. Refused at once while the thread is down; a read past the time limit is refused
   *  and the thread is stopped (and started again), so a stuck query never holds later ones. */
  call<T>(op: ReadName, ...args: unknown[]): Promise<T> {
    const w = this.w;
    if (!w || !this.ready) return Promise.reject(new ReaderUnavailable(`fee index reader ${this.name} not running`));
    const id = ++this.seq;
    return new Promise<T>((resolve, reject) => {
      const timeoutMs = this.opts.timeoutMs ?? 30_000;
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new ReaderUnavailable(`fee index read ${op} ran past ${timeoutMs} ms`));
        this.report("fee index read ran past its limit; restarting the reader", { reader: this.name, op, timeoutMs });
        void w.terminate();
      }, timeoutMs);
      this.pending.set(id, { resolve, reject, timer });
      w.postMessage({ id, op, args });
    });
  }

  async close() {
    this.closed = true;
    if (this.restartTimer) clearTimeout(this.restartTimer);
    const w = this.w; this.w = null;
    if (w) await w.terminate();
  }
}
