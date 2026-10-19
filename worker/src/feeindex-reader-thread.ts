// The Fee Index reader thread: its own read-only connection to the index file (WAL: the indexer's writes go on
// beside it) answering the reads in feeindex-read.ts, one at a time, so a slow one never holds the indexer's thread.
import { parentPort, workerData } from "worker_threads";
import { READS, type ReadName } from "./feeindex-read";

// eslint-disable-next-line @typescript-eslint/no-var-requires
const { DatabaseSync } = require("node:sqlite");
const db = new DatabaseSync(workerData.file, { readOnly: true });
const prepare = db.prepare.bind(db);
db.prepare = (sql: string) => { const st = prepare(sql); st.setReadBigInts(true); return st; };
db.exec("pragma busy_timeout = 5000");

parentPort!.on("message", (m: { id: number; op: ReadName; args: unknown[] }) => {
  try {
    const value = (READS[m.op] as (...a: unknown[]) => unknown)(db, workerData.ctx, ...m.args);
    parentPort!.postMessage({ id: m.id, ok: true, value });
  } catch (e) { parentPort!.postMessage({ id: m.id, ok: false, error: String((e as Error).message ?? e) }); }
});
parentPort!.postMessage({ ready: true });
