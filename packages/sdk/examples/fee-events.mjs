#!/usr/bin/env node
// Fee events in a terminal: claims on every launchpad's DBC coins, vault harvests, buyback bids and
// the fills that burn tail tokens, from the public COMETAIL feed. Resumable: pass the last printed
// cursor to continue where you stopped. Node 22.12+ (global WebSocket), after `npm run build`.
//   node examples/fee-events.mjs [since-cursor]
//   COMETAIL_API=https://api.cometail.fun node examples/fee-events.mjs
import { CometailClient, FEE_TYPES } from "../dist/index.js";

const api = process.env.COMETAIL_API ?? "https://api.cometail.fun";
const client = new CometailClient({ baseUrl: api });
const sol = (lamports) => (lamports === null || lamports === undefined ? "?" : (Number(lamports) / 1e9).toFixed(4));
const line = (e) => {
  const d = e.data;
  switch (e.type) {
    case "claim": return `claim    ${d.role.padEnd(7)} ${sol(d.quoteAmountLamports)} SOL  mint ${d.mint ?? "?"}  pool ${d.pool}`;
    case "harvest": return `harvest  vault ${d.vault}  income ${sol(d.incomeLamports)} SOL  gross ${sol(d.grossLamports)} SOL`;
    case "bid": return `buyback  vault ${d.vault}  ${sol(d.grossLamports)} SOL over ${d.bins} bins`;
    case "fill": return `burn     vault ${d.vault}  ${d.burnedStRaw ?? "?"} raw tail tokens burned`;
    default: return `${e.type} ${JSON.stringify(d)}`;
  }
};

const sub = client.feed({
  since: process.argv[2],
  types: FEE_TYPES,
  onEvent: (e) => console.log(`${new Date(e.generatedAtMs).toISOString()}  ${line(e)}  ${e.data.signature ?? ""}  [${e.cursor}]`),
  onControl: (f) => { if (f.type === "gap") console.error(`gap: resume from ${f.resume}`); if (f.type === "hello") console.error(`live from ${f.cursor ?? "the start"}`); },
  onError: (err) => console.error(`feed: ${err.message}`),
});
process.on("SIGINT", () => { sub.close(); console.error(`stopped at ${sub.cursor ?? "the start"}`); process.exit(0); });
