// Live watch: new transactions on the owner's token pool and wallet, decoded, then the hosted
// pages' numbers compared after each one. One line per event. Read-only.
import { Connection, PublicKey } from "@solana/web3.js";
import { Chain } from "./chain";
import { decodeTrades } from "./indexer";
const RPC = process.env.COMETAIL_RPC_URL!; const conn = new Connection(RPC, "confirmed"); const chain = new Chain(conn);
const MINT = "J1AhDCKsMxpcYV2naZvQRrZ6wGy3mDGhFbXhTkxqpuHJ", POOL = new PublicKey("8m2YARd5SJ4MewjGWba7S9D8dwzm2x1GM7kunkShSxgp"), WALLET = new PublicKey("G2SsyvTH8DD5wLRuNGQ77x5kQNDdkhYzsvJYFCJtwx13");
const seen = new Set<string>(); let first = true;
const CLAIM = Buffer.from("52d3f3df3c2a69ad", "hex"); // placeholder; names decided by instruction decode below
const log = (m: string) => console.log(`${new Date().toISOString().slice(11, 19)}Z ${m}`);
async function api(mint: string) { try { const r = await fetch(`https://api.cometail.fun/api/tokens/${mint}`, { signal: AbortSignal.timeout(10_000) }); if (!r.ok) return { status: r.status }; const j: any = await r.json(); return { status: 200, price: j.data.market.priceSol, fdv: j.data.market.fdvUsd, progress: j.data.bonding.progressBps, raised: j.data.bonding.quoteRaisedLamports, holders: j.data.holders.count, vol: j.data.volume24h.lamports, buys: j.data.volume24h.buys, sells: j.data.volume24h.sells, stage: j.data.identity.stage, scanned: j.coverage.lastSuccessfulAtMs }; } catch (e) { return { status: "err", error: String((e as Error).message) }; } }
async function sky(mint: string) { try { const r = await fetch("https://api.cometail.fun/api/sky?limit=500", { signal: AbortSignal.timeout(10_000) }); const j: any = await r.json(); const row = j.streams.find((s: any) => s.baseMint === mint && (s.kind ?? "curve") === "curve"); return row ? { claimable: row.claimableLamports, realizedEst: row.realizedEstimateLamports, tradingFee: row.tradingFeeLamports, progress: row.progress, eligible: row.eligible } : null; } catch { return null; } }
async function chainState() { const p: any = await chain.dbcPool(POOL); return { quoteReserve: String(p.quoteReserve), creatorFee: String(p.creatorQuoteFee), tradingFee: String(p.metrics?.totalTradingQuoteFee), progress: Number(p.migrationProgress), sqrt: String(p.sqrtPrice) }; }
async function describe(sig: string) {
  const tx = await conn.getTransaction(sig, { commitment: "confirmed", maxSupportedTransactionVersion: 0 });
  if (!tx) return "tx not available";
  if (tx.meta?.err) return `FAILED ${JSON.stringify(tx.meta.err).slice(0, 80)}`;
  const keys = tx.transaction.message.getAccountKeys({ accountKeysFromLookups: tx.meta?.loadedAddresses ?? undefined });
  const names: string[] = [];
  const dbcIx = (chain.dbc as any).idl.instructions as any[];
  for (const c of tx.transaction.message.compiledInstructions) { const pid = keys.get(c.programIdIndex); if (!pid) continue; const d = Buffer.from(c.data); const ix = dbcIx.find((i) => Buffer.from(i.discriminator).equals(d.subarray(0, 8))); if (pid.toBase58() === "dbcij3LWUppWqq96dh6gJWwBifmcGfLSB5D4DuSMaqN") names.push(ix ? ix.name : "dbc:" + d.subarray(0, 4).toString("hex")); }
  const trades = decodeTrades(chain, tx, POOL, { signature: sig, slot: tx.slot, blockTime: tx.blockTime ?? null, vault: "", venue: "curve", baseDecimals: 6 });
  const fee = tx.meta?.fee; const pre = tx.meta?.preBalances?.[0], post = tx.meta?.postBalances?.[0];
  return `ix[${names.join(",")}] trades=${trades.map((t) => `${t.buy ? "BUY" : "SELL"} ${Number(t.quoteAmountLamports) / 1e9} SOL for ${Number(t.baseAmountRaw) / 1e6} tokens @${t.executionPriceSol}`).join("; ") || "none"} payerDelta=${pre !== undefined && post !== undefined ? (post - pre) / 1e9 : "?"} fee=${fee}`;
}
(async () => {
  log(`watching mint ${MINT} pool ${POOL.toBase58()} wallet ${WALLET.toBase58()}`);
  for (;;) {
    try {
      const sigs = [...(await conn.getSignaturesForAddress(POOL, { limit: 20 })), ...(await conn.getSignaturesForAddress(WALLET, { limit: 20 }))];
      const fresh = sigs.filter((s) => !seen.has(s.signature)).sort((a, b) => a.slot - b.slot);
      for (const s of fresh) { seen.add(s.signature); if (first) continue; log(`NEW ${s.signature} slot ${s.slot}: ${await describe(s.signature)}`); }
      if (first) { first = false; log(`baseline: ${seen.size} prior signatures; chain ${JSON.stringify(await chainState())}; api ${JSON.stringify(await api(MINT))}; sky ${JSON.stringify(await sky(MINT))}`); }
      else if (fresh.length) { await new Promise((r) => setTimeout(r, 70_000)); log(`after ${fresh.length} tx: chain ${JSON.stringify(await chainState())}`); log(`  api ${JSON.stringify(await api(MINT))}`); log(`  sky ${JSON.stringify(await sky(MINT))}`); }
    } catch (e) { log(`watch error ${String((e as Error).message).slice(0, 120)}`); }
    await new Promise((r) => setTimeout(r, 20_000));
  }
})();
