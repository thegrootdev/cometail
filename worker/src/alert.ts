// Alerting: failures and notable actions go to a webhook (COMETAIL_ALERT_WEBHOOK) as JSON,
// in addition to the structured log. No webhook configured means log only.
import { PublicKey } from "@solana/web3.js";

const url = process.env.COMETAIL_ALERT_WEBHOOK || "";
const plain = (v: unknown) => JSON.stringify(v, (_, x) => (typeof x === "bigint" ? x.toString() : x instanceof PublicKey ? x.toBase58() : x));

export async function alert(level: "info" | "warn" | "error", msg: string, extra?: Record<string, unknown>): Promise<void> {
  if (!url) return;
  try {
    await fetch(url, { method: "POST", headers: { "content-type": "application/json" }, body: plain({ source: "cometail-worker", level, msg, ts: new Date().toISOString(), ...(extra ?? {}) }) });
  } catch (e) {
    console.error("alert webhook failed", String((e as Error).message ?? e));
  }
}
