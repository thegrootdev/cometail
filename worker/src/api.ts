// The site's read API, served next to the indexer. JSON only, open CORS, no writes.
//   GET /api/sky?limit=200          the Sky scan, by claimable backlog
//   GET /api/vaults                 every vault snapshot
//   GET /api/vaults/:vault          one vault with its streams and latest events
//   GET /api/events?vault=&limit=   events, newest first
//   GET /api/health
import http from "http";
import { Store } from "./store";
import { log } from "./tx";

export function startApi(store: Store, port: number): http.Server {
  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url ?? "/", "http://localhost");
    const send = (code: number, body: unknown) => {
      res.writeHead(code, { "content-type": "application/json", "access-control-allow-origin": "*", "cache-control": "public, max-age=10" });
      res.end(JSON.stringify(body));
    };
    try {
      if (req.method === "OPTIONS") { res.writeHead(204, { "access-control-allow-origin": "*", "access-control-allow-methods": "GET" }); return res.end(); }
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
  server.listen(port, () => log("api listening", { port }));
  return server;
}
