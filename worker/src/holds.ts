// The indexer's main thread also serves the API, so whatever holds it holds every visitor. holdWatch logs each hold
// over a second as it ends ("event loop hold"), with what tells its causes apart:
//   mainCpuMs  the main thread's own CPU during the hold: near the hold's length is work on this thread (parsing,
//              a synchronous query, a big answer); near 0 is a wait inside a synchronous call (disk, a lock)
//   gcMs       the garbage collection inside it, and of which kinds
//   stages     the step each lane (the main loop, the Fee Index, the API) had last begun, and how long before the
//              hold (the hold's start is known to one tick, 100 ms: down to -100 means it began as the hold did)
// stage() is a cheap note; the minute line "event loop held" in index.ts stays as it was.
import fs from "fs";
import { PerformanceObserver, constants, performance } from "perf_hooks";

const lanes = new Map<string, { label: string; at: number }>();
export function stage(lane: string, label: string) { lanes.set(lane, { label, at: Date.now() }); }

/** CPU ms used so far by the main thread alone (Linux /proc; utime + stime in 1/100 s), null elsewhere. */
export function mainThreadCpuMs(): number | null {
  try {
    const f = fs.readFileSync(`/proc/self/task/${process.pid}/stat`, "utf8");
    const rest = f.slice(f.lastIndexOf(")") + 2).split(" "); // fields from the 3rd on: utime is the 14th, stime the 15th
    return (Number(rest[11]) + Number(rest[12])) * 10;
  } catch { return null; }
}

const GC_KINDS: Record<number, string> = { [constants.NODE_PERFORMANCE_GC_MINOR]: "minor", [constants.NODE_PERFORMANCE_GC_MAJOR]: "major", [constants.NODE_PERFORMANCE_GC_INCREMENTAL]: "incremental", [constants.NODE_PERFORMANCE_GC_WEAKCB]: "weakcb" };

export function holdWatch(o: { log: (msg: string, fields: Record<string, unknown>) => void; thresholdMs?: number; tickMs?: number; maxPerHour?: number; now?: () => number; cpuMs?: () => number | null }) {
  const threshold = o.thresholdMs ?? 1_000, tick = o.tickMs ?? 100, maxPerHour = o.maxPerHour ?? 30;
  const now = o.now ?? Date.now, cpu = o.cpuMs ?? mainThreadCpuMs;
  const gcs: { start: number; ms: number; kind: string }[] = [];
  const obs = new PerformanceObserver((list) => {
    for (const e of list.getEntries()) { gcs.push({ start: performance.timeOrigin + e.startTime, ms: e.duration, kind: GC_KINDS[(e as any).detail?.kind] ?? "other" }); if (gcs.length > 500) gcs.shift(); }
  });
  obs.observe({ entryTypes: ["gc"] });
  let lastT = now(), lastCpu = cpu(); let sent: number[] = [];
  const timer = setInterval(() => {
    const t = now(), c = cpu();
    if (t - lastT - tick > threshold) {
      sent = sent.filter((x) => t - x < 3_600_000);
      if (sent.length < maxPerHour) {
        sent.push(t);
        const from = lastT, cpuMs = c !== null && lastCpu !== null ? c - lastCpu : null;
        const st = Object.fromEntries([...lanes].map(([k, v]) => [k, { label: v.label, beganMsBefore: from - v.at }]));
        // the GC entries of the hold reach the observer after it: read them a moment later
        setTimeout(() => {
          const inside = gcs.filter((g) => g.start + g.ms > from && g.start < t);
          const kinds: Record<string, number> = {};
          for (const g of inside) kinds[g.kind] = Math.round((kinds[g.kind] ?? 0) + g.ms);
          o.log("event loop hold", { startedAt: new Date(from).toISOString(), ms: t - from, mainCpuMs: cpuMs, gcMs: Math.round(inside.reduce((s, g) => s + g.ms, 0)), gcKinds: kinds, stages: st });
        }, 50).unref?.();
      }
    }
    lastT = t; lastCpu = c;
  }, tick);
  timer.unref?.();
  return { stop: () => { clearInterval(timer); obs.disconnect(); } };
}
