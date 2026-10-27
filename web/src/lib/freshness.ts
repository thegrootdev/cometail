// The worker keeps /api/stats and /api/burn: past their age it serves the last one while one read refreshes it, and a
// failed read keeps it (worker/src/refresh.ts). So an answer that arrives is not always a new read. A figure shows as
// live only while its own read is recent: its read time against servedAtMs, when the answer left the worker, both on
// the worker's clock, so a visitor's clock that is off changes nothing. An answer without servedAtMs comes from a
// worker older than that cache, which read for every answer.
import { burnPanel, home } from "../content/cometail";

/** How old a read may be and still show as live: the worker's own age for it, a refresh, and a page's poll between. */
export const LIVE_FOR_MS = { stats: 180_000, burn: 90_000 } as const;
/** How soon a page asks again after an answer that is not live: the refresh that answer started is usually done. */
export const RECHECK_MS = 15_000;

export function isLive(readAtMs: number | null | undefined, servedAtMs: number | undefined, limitMs: number): boolean {
  if (servedAtMs === undefined) return true;
  return typeof readAtMs === "number" && servedAtMs - readAtMs <= limitMs;
}

export const utcTime = (ms: number) => `${new Date(ms).toLocaleTimeString("en-US", { timeStyle: "short", timeZone: "UTC" })} UTC`;

type StatsTimes = { generatedAtMs: number; servedAtMs?: number; burn: { readAtMs: number } | null };
type BurnTimes = { status: string; generatedAtMs?: number; servedAtMs?: number };

/** The home figures. The traded and fee figures are the document's; the burned one is the burn read the document
 *  carries, which can be older. failed: the latest read gave no answer, so what shows is the last one. */
export function homeNumbersState(s: StatsTimes, failed: boolean) {
  const doc = !failed && isLive(s.generatedAtMs, s.servedAtMs, LIVE_FOR_MS.stats);
  const burn = doc && (!s.burn || isLive(s.burn.readAtMs, s.servedAtMs, LIVE_FOR_MS.stats));
  const live = doc && burn;
  // the time shown: the oldest read among the figures that are not live
  const since = !doc ? Math.min(s.generatedAtMs, s.burn?.readAtMs ?? Infinity) : !burn ? s.burn!.readAtMs : null;
  return {
    live, docLive: doc, burnLive: burn,
    label: live ? home.numbers.label : home.numbers.lastKnown,
    title: since === null ? undefined : `${home.numbers.lastKnown} (${new Date(since).toUTCString()})`,
    stale: since === null ? null : `${home.numbers.stale} · ${utcTime(since)}`,
  };
}

/** The home burn line before the stats document answers: live while its read is; failed as above, or not a live view. */
export function burnStatState(v: BurnTimes, failed: boolean) {
  const live = !failed && v.status === "live" && isLive(v.generatedAtMs, v.servedAtMs, LIVE_FOR_MS.burn);
  const at = v.generatedAtMs;
  return {
    live,
    title: live ? undefined : at ? `${home.burnedLastKnown} (${new Date(at).toUTCString()})` : home.burnedLastKnown,
    stale: live ? null : at ? `${home.lastKnown} · ${utcTime(at)}` : home.lastKnown,
  };
}

/** The burn panel's read line: when its figures (reserve, waiting to be claimed, next buyback) were read. */
export function burnPanelRead(v: BurnTimes) {
  const live = isLive(v.generatedAtMs, v.servedAtMs, LIVE_FOR_MS.burn);
  return { live, line: v.generatedAtMs ? (live ? burnPanel.readAt : burnPanel.lastKnownAt)(utcTime(v.generatedAtMs)) : null };
}

/** Calls read now and again after each answer: every everyMs, or RECHECK_MS when read says its answer was not live.
 *  Returns the stop. */
export function pollFigures(read: () => Promise<boolean>, everyMs: number): () => void {
  let on = true, t: ReturnType<typeof setTimeout> | undefined;
  const next = (soon: boolean) => { if (on) t = setTimeout(run, soon ? RECHECK_MS : everyMs); };
  const run = () => void read().then(next, () => next(false));
  run();
  return () => { on = false; clearTimeout(t); };
}
