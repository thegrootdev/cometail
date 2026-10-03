import type { ControlFrame, EstimateLabel, Evidence, FeedEvent, FeedFrame, Provenance } from "./types.js";
export class ProtocolError extends Error {
  constructor(message: string) { super(message); this.name = "ProtocolError"; }
}
export function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new ProtocolError("Expected a JSON object");
  return value as Record<string, unknown>;
}
export function array(value: unknown): unknown[] {
  if (!Array.isArray(value)) throw new ProtocolError("Expected a JSON array");
  return value;
}
export function number(value: unknown): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) throw new ProtocolError("Expected a nonnegative number");
  return value;
}
export function text(value: unknown): string {
  if (typeof value !== "string") throw new ProtocolError("Expected a string");
  return value;
}
export function provenance(value: unknown): Provenance {
  const p = object(value);
  if (p.source !== "chain" && p.source !== "indexer" && p.source !== "estimate") throw new ProtocolError("Unknown provenance source");
  if (p.signature !== undefined) text(p.signature);
  for (const k of ["slot", "scannedAtMs"]) if (p[k] !== undefined) number(p[k]);
  return p as unknown as Provenance;
}
export function evidence(value: unknown, estimates: EstimateLabel[] = []): Evidence {
  const row = object(value);
  const supplied = row.estimates === undefined ? [] : array(row.estimates).map(v => {
    const e = object(v); text(e.path); text(e.basis);
    if (e.source !== "estimate") throw new ProtocolError("Invalid estimate label");
    return e as unknown as EstimateLabel;
  });
  return { provenance: row.provenance === undefined ? { source: "indexer" } : provenance(row.provenance), estimates: [...supplied, ...estimates.filter(e => !supplied.some(s => s.path === e.path))] };
}
/** Cursors sort numerically by slot and ordinal, then by signature; never lexically by the full string. */
export function parseCursor(value: string): readonly [bigint, bigint, string] {
  const m = /^(\d{1,20}):(\d{1,20}):([1-9A-HJ-NP-Za-km-z]{1,128})$/.exec(value);
  if (!m) throw new ProtocolError("Invalid feed cursor");
  return [BigInt(m[1]!), BigInt(m[2]!), m[3]!];
}
export function compareCursors(a: string, b: string): number {
  const x = parseCursor(a), y = parseCursor(b);
  return x[0] !== y[0] ? x[0] < y[0] ? -1 : 1 : x[1] !== y[1] ? x[1] < y[1] ? -1 : 1 : x[2] < y[2] ? -1 : x[2] > y[2] ? 1 : 0;
}
function coverage(v: Record<string, unknown>): void {
  if (!["complete", "partial", "stale"].includes(String(v.status))) throw new ProtocolError("Unknown coverage status");
  number(v.pendingPools); if (v.lastSuccessfulAtMs !== null) number(v.lastSuccessfulAtMs);
}
const required: Record<string, readonly string[]> = {
  launch: ["mint", "name", "symbol", "creator", "config", "dbcPool", "tokenKind"],
  trade: ["mint", "pool", "venue", "side", "baseAmountRaw", "quoteAmountLamports", "trader", "signature"],
  graduation: ["mint", "dbcPool", "dammPool", "signature"],
  harvest: ["vault", "stream", "incomeLamports", "signature"],
  bid: ["vault", "order", "grossLamports", "signature"],
  fill: ["vault", "order", "burnedStRaw", "unfilledLamports", "signature"],
  cashout: ["vault", "depositorLamports", "signature"],
};
export function decodeFrame(value: unknown): FeedFrame {
  const v = object(value);
  if (v.type === "hello") {
    if (v.cursor !== null) parseCursor(text(v.cursor)); number(v.retentionSlots);
    return v as unknown as ControlFrame;
  }
  if (v.type === "ping") { number(v.generatedAtMs); return v as unknown as ControlFrame; }
  if (v.type === "coverage") { coverage(v); return v as unknown as ControlFrame; }
  if (v.schemaVersion !== 1) throw new ProtocolError("Unsupported feed schemaVersion");
  const kind = text(v.type);
  const fields = Object.hasOwn(required, kind) ? required[kind] : undefined;
  if (!fields) throw new ProtocolError("Unknown feed event type");
  text(v.cluster); parseCursor(text(v.cursor)); number(v.generatedAtMs);
  if (v.observedSlot !== null) number(v.observedSlot);
  const p = provenance(v.provenance), d = object(v.data);
  for (const k of fields) text(d[k]);
  for (const [k, x] of Object.entries(d)) if (/(?:Raw|Lamports)$/.test(k) && (typeof x !== "string" || !/^\d+$/.test(x))) throw new ProtocolError(`Invalid raw amount: ${k}`);
  if (p.source === "estimate" && (typeof d.basis !== "string" || !d.basis.trim())) throw new ProtocolError("Estimate event requires data.basis");
  if (v.type === "launch") {
    if (d.imageUrl !== null) text(d.imageUrl);
    if (d.tokenKind !== "plain" && d.tokenKind !== "stream") throw new ProtocolError("Invalid tokenKind");
  }
  if (v.type === "trade") {
    if (!["curve", "damm"].includes(String(d.venue)) || !["buy", "sell"].includes(String(d.side))) throw new ProtocolError("Invalid trade side/venue");
    if (d.executionPriceSol !== null) text(d.executionPriceSol);
  }
  if (v.type === "bid" && (typeof d.bins !== "number" || !Number.isSafeInteger(d.bins) || d.bins < 0)) throw new ProtocolError("Invalid bin count");
  return v as unknown as FeedEvent;
}
export function decodeEnvelope(value: unknown): Record<string, unknown> {
  const v = object(value);
  if (v.schemaVersion !== 1) throw new ProtocolError("Unsupported API schemaVersion");
  text(v.cluster); number(v.generatedAtMs); if (v.observedSlot !== null) number(v.observedSlot);
  coverage(object(v.coverage)); object(v.data);
  if (v.solUsd !== null) { const rate = object(v.solUsd); number(rate.value); text(rate.source); number(rate.observedAtMs); }
  return v;
}
