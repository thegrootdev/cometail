// The site's read API, served next to the indexer. JSON only, GET only, no writes.
//   GET /api/sky?limit=200          the Sky scan, by claimable backlog
//   GET /api/vaults                 every vault snapshot
//   GET /api/vaults/:vault          one vault with its streams and latest events
//   GET /api/events?vault=&limit=   events, newest first
//   GET /api/health
// It binds to the loopback interface and expects a reverse proxy in front for TLS. CORS is
// limited to the configured origins, and each client address gets a token bucket; the
// client address is taken from X-Forwarded-For only when the connection comes from loopback.
import http from "http";
import { Store } from "./store";
import { log } from "./tx";

export interface ApiOptions { host: string; port: number; origins: string[]; ratePerMinute: number }

class Buckets {
  private buckets = new Map<string, { tokens: number; at: number }>();
  constructor(private perMinute: number, private burst: number) {}
  take(key: string): boolean {
    const now = Date.now();
    const b = this.buckets.get(key) ?? { tokens: this.burst, at: now };
    b.tokens = Math.min(this.burst, b.tokens + ((now - b.at) / 60_000) * this.perMinute);
    b.at = now;
    if (b.tokens < 1) { this.buckets.set(key, b); return false; }
    b.tokens -= 1;
    this.buckets.set(key, b);
    if (this.buckets.size > 10_000) for (const [k, v] of this.buckets) if (now - v.at > 300_000) this.buckets.delete(k);
    return true;
  }
}

export function startApi(store: Store, opts: ApiOptions): http.Server {
  const buckets = new Buckets(opts.ratePerMinute, Math.max(10, Math.ceil(opts.ratePerMinute / 2)));
  const allowOrigin = (req: http.IncomingMessage): string | null => {
    const o = req.headers.origin;
    if (!o) return null;
    return opts.origins.includes(o) ? o : null;
  };
  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url ?? "/", "http://localhost");
    const origin = allowOrigin(req);
    const cors: Record<string, string> = origin ? { "access-control-allow-origin": origin, "vary": "Origin", "access-control-allow-methods": "GET", "access-control-max-age": "600" } : {};
    const send = (code: number, body: unknown, extra: Record<string, string> = {}) => {
      res.writeHead(code, { "content-type": "application/json", "cache-control": "public, max-age=10", "x-content-type-options": "nosniff", ...cors, ...extra });
      res.end(JSON.stringify(body));
    };
    try {
      if (req.method === "OPTIONS") { res.writeHead(204, cors); return res.end(); }
      if (req.method !== "GET") return send(405, { error: "method not allowed" }, { allow: "GET" });
      const remote = req.socket.remoteAddress ?? "";
      const fromProxy = remote === "127.0.0.1" || remote === "::1" || remote === "::ffff:127.0.0.1";
      const forwarded = fromProxy ? String(req.headers["x-forwarded-for"] ?? "").split(",")[0].trim() : "";
      const client = forwarded || remote;
      if (!buckets.take(client)) return send(429, { error: "rate limited" }, { "retry-after": "10" });
      const limit = Math.min(1000, Math.max(1, Number(url.searchParams.get("limit") ?? 200)));
      if (url.pathname === "/api/health") return send(200, { ok: true, time: Date.now() });
      if (url.pathname === "/api/sky") return send(200, { streams: await store.listSky(limit) });
      if (url.pathname === "/api/vaults") return send(200, { vaults: await store.listVaults() });
      const m = url.pathname.match(/^\/api\/vaults\/([1-9A-HJ-NP-Za-km-z]{32,44})$/);
      if (m) {
        const vault = await store.getVault(m[1]);
        if (!vault) return send(404, { error: "no such vault" });
        return send(200, { ...vault, streams: await store.listStreams(m[1]), events: await store.listEvents(m[1], limit) });
      }
      if (url.pathname === "/api/events") return send(200, { events: await store.listEvents(url.searchParams.get("vault"), limit) });
      send(404, { error: "not found" });
    } catch (e) {
      log("api error", { path: url.pathname, error: String((e as Error).message ?? e) });
      send(500, { error: "internal" });
    }
  });
  server.listen(opts.port, opts.host, () => log("api listening", { host: opts.host, port: opts.port, origins: opts.origins, ratePerMinute: opts.ratePerMinute }));
  return server;
}
