// A value read from outside the process (an RPC read, a price source) that a visitor should not wait for once one
// exists. A value younger than ttlMs is returned as it is. An older one is returned at once while one refresh runs
// behind it. Only a caller with no value, or one older than maxStaleMs, waits for a read, and concurrent callers
// share the same read. A read that fails (throws, or gives a value `keep` refuses) leaves the last value in place:
// a waiting caller gets the refused value or the error, as it would without the cache. Every value served carries
// its own read time, so an older value is never shown as a fresh one.
export function staleWhileRefresh<T>(read: () => Promise<T>, o: { ttlMs: number; maxStaleMs: number; keep?: (v: T) => boolean; now?: () => number; onError?: (e: unknown) => void }) {
  const now = o.now ?? Date.now, keep = o.keep ?? (() => true);
  let memo: { at: number; value: T } | null = null;
  let inflight: Promise<T> | null = null;
  const refresh = (): Promise<T> => (inflight ??= (async () => {
    try { const value = await read(); if (keep(value)) memo = { at: now(), value }; return value; } finally { inflight = null; }
  })());
  return {
    get: async (): Promise<T> => {
      const age = memo ? now() - memo.at : Infinity;
      if (memo && age < o.ttlMs) return memo.value;
      if (memo && age < o.maxStaleMs) { refresh().catch((e) => o.onError?.(e)); return memo.value; }
      return refresh();
    },
    /** For a builder that embeds this value (stats embeds the burn view): one younger than ttlMs as it is, else a read
     *  waited for. A failed or refused read gives the last value, which its own read time dates, or with none, what the
     *  read gave. */
    fresh: async (): Promise<T> => {
      if (memo && now() - memo.at < o.ttlMs) return memo.value;
      try { const v = await refresh(); return keep(v) ? v : memo?.value ?? v; } catch (e) { if (memo) return memo.value; throw e; }
    },
    /** the last value kept and when it was read, without reading */
    peek: () => memo,
  };
}
