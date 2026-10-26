// The box has no IPv6 route (2026-10-26: a link-local address only), yet every outbound lookup asked for both A and
// AAAA: glibc counts the link-local address under AI_ADDRCONFIG. A lost answer to either half held the whole lookup
// until glibc's 5 s retry (spike 228). fetch, the RPC client, WebSockets and Postgres all resolve through dns.lookup,
// read at each call, so a lookup that names no family now asks for IPv4 only. A caller that asks for IPv6 by name still
// gets it. index.ts imports this first, for every mode (indexer, keeper, once).
import dns from "dns";

type Opts = { family?: number | string; [k: string]: unknown };
const v4 = (o: unknown): Opts => {
  const opts: Opts = typeof o === "number" ? { family: o } : { ...((o as Opts) ?? {}) };
  if (!opts.family || opts.family === "IPv0") opts.family = 4; // 0 / undefined = either family
  return opts;
};

let installed: { lookup: typeof dns.lookup; promises: typeof dns.promises.lookup } | null = null;

/** Lookups without a family ask for IPv4 only. Idempotent; the returned function puts the originals back (tests). */
export function ipv4Lookups(): () => void {
  if (!installed) {
    const lookup = dns.lookup, promises = dns.promises.lookup;
    installed = { lookup, promises };
    (dns as any).lookup = function (host: string, o: unknown, cb?: unknown) {
      return typeof o === "function" ? (lookup as any).call(this, host, v4(undefined), o) : (lookup as any).call(this, host, v4(o), cb);
    };
    (dns.promises as any).lookup = (host: string, o?: unknown) => (promises as any)(host, v4(o));
  }
  return () => { if (installed) { (dns as any).lookup = installed.lookup; (dns.promises as any).lookup = installed.promises; installed = null; } };
}

ipv4Lookups();
