"use client";
// Tails: every vault's tail token with the coins whose fees fund it, its raise, the fees flowing in,
// the SOL placed in buybacks, the tail tokens burned, and when its unwind opens. All from the
// worker's API (vaults, their streams and events) and the tail token's market row.
import { useEffect, useState } from "react";
import Link from "next/link";
import { Shell } from "@/components/Shell";
import { PageHeader, DataState, Badge } from "@/components/Experience";
import { Money } from "@/components/Money";
import { api } from "@/lib/api";
import { API_URL } from "@/lib/addresses";
import { short, units } from "@/lib/format";
import { tailsPage as copy } from "@/content/cometail";

/** Must match the program's UNWIND_WINDOW_SECONDS. */
const UNWIND_WINDOW_SECONDS = 30 * 24 * 60 * 60;
const KIND = (s: any) => (s?.kind ? Object.keys(s.kind)[0] : "");
const str = (v: unknown) => (v === null || v === undefined ? "0" : String(v));

interface TailRow {
  vault: string; status: string; stMint: string; name: string | null; symbol: string | null; stDecimals: number;
  sources: { mint: string | null; name: string | null; kind: string }[];
  raisedLamports: string | null; targetLamports: string | null; progressBps: number | null;
  harvestedGross: string; harvested24h: string; routedGross: string; burnedSt: string; unwindOpensAt: number | null;
}

async function tokenMarket(mint: string): Promise<any | null> {
  try { const r = await fetch(`${API_URL}/api/tokens/${mint}`, { cache: "no-store", signal: AbortSignal.timeout(12_000) }); return r.ok ? (await r.json()).data : null; } catch { return null; }
}

async function loadTails(): Promise<TailRow[] | null> {
  const list = await api.vaults();
  if (!list) return null;
  const rows = await Promise.all(list.vaults.slice(0, 50).map(async (v): Promise<TailRow> => {
    const d = v.data ?? {};
    const [detail, market] = await Promise.all([api.vault(v.vault), tokenMarket(String(d.stMint))]);
    const streams = detail?.streams ?? [];
    const own = streams.find((s) => s.data?.isOwn && KIND(s.data) === "dbcCreatorRights");
    const dayAgo = Date.now() / 1000 - 86_400;
    const harvested24h = (detail?.events ?? []).filter((e) => (e.name === "harvested" || e.name === "oneTimeHarvested") && (e.blockTime ?? 0) >= dayAgo).reduce((n, e) => n + BigInt(str((e.data as any)?.gross)), 0n);
    const acc = d.accounting ?? {};
    return {
      vault: v.vault, status: Object.keys(d.status ?? {})[0] ?? "open", stMint: String(d.stMint), name: v.stToken?.name ?? null, symbol: v.stToken?.symbol ?? null, stDecimals: Number(market?.identity?.decimals ?? 6),
      sources: streams.filter((s) => !s.data?.isOwn).map((s) => ({ mint: s.token?.mint ?? null, name: s.token?.name ?? s.token?.symbol ?? null, kind: KIND(s.data) })),
      raisedLamports: market?.bonding?.quoteRaisedLamports ?? null, targetLamports: market?.bonding?.targetLamports ?? null, progressBps: market?.bonding?.progressBps ?? null,
      harvestedGross: str(acc.harvestedGross), harvested24h: harvested24h.toString(), routedGross: str(acc.routedGross), burnedSt: str(acc.burnedSt),
      unwindOpensAt: own ? Number(own.data.depositTs) + UNWIND_WINDOW_SECONDS : null,
    };
  }));
  return rows;
}

export default function TailsPage() {
  const [rows, setRows] = useState<TailRow[] | null | undefined>(undefined);
  const [tick, setTick] = useState(0);
  useEffect(() => { let live = true; void loadTails().then((r) => { if (live) setRows(r); }); return () => { live = false; }; }, [tick]);
  const now = Date.now() / 1000;
  const statusLabel = (s: string) => (s === "live" ? copy.live : s === "launched" ? copy.launched : s === "unwound" ? copy.unwound : copy.open);
  return (
    <Shell wide>
      <PageHeader eyebrow={copy.eyebrow} title={copy.title} body={copy.body} />
      {rows === undefined && <DataState kind="loading" />}
      {rows === null && <DataState kind="error" onRetry={() => setTick((n) => n + 1)} />}
      {rows && rows.length === 0 && <DataState title={copy.empty} />}
      {rows && rows.length > 0 && (
        <div className="table-scroll">
          <table className="stream-table fee-table">
            <thead><tr><th>Tail</th><th>{copy.source}</th><th>{copy.raise}</th><th>{copy.flowing}</th><th>{copy.buybacks}</th><th>{copy.burned}</th><th>{copy.unwind}</th></tr></thead>
            <tbody>
              {rows.map((t) => (
                <tr key={t.vault}>
                  <td data-label="Tail"><Link className="token-cell" href={`/vault/${t.vault}`}><strong>{t.name || short(t.stMint)}</strong>{t.symbol ? <span className="micro"> {t.symbol}</span> : null}</Link><p className="mt-1"><Badge tone={t.status === "live" ? "gold" : "ion"}>{statusLabel(t.status)}</Badge></p></td>
                  <td data-label={copy.source}>{t.sources.length ? t.sources.map((s, i) => <p key={i}>{s.mint ? <Link className="text-link" href={`/token/${s.mint}`}>{s.name || short(s.mint)}</Link> : "—"}<span className="micro"> {s.kind === "dammV2Position" ? "locked liquidity" : "creator fees"}</span></p>) : "—"}</td>
                  <td data-label={copy.raise}>{t.raisedLamports !== null ? <><Money lamports={t.raisedLamports} secondary={false} /><span className="micro"> of </span><Money lamports={t.targetLamports} secondary={false} /><p className="micro">{t.progressBps !== null ? `${(t.progressBps / 100).toFixed(1)}%` : ""}</p></> : "—"}</td>
                  <td className="money" data-label={copy.flowing}><Money lamports={t.harvestedGross} /><p className="micro">24 h: <Money lamports={t.harvested24h} secondary={false} /></p></td>
                  <td className="money" data-label={copy.buybacks}><Money lamports={t.routedGross} /></td>
                  <td data-label={copy.burned}>{units(t.burnedSt, t.stDecimals)}</td>
                  <td data-label={copy.unwind}>{t.status === "unwound" ? copy.unwound : t.status !== "launched" || t.unwindOpensAt === null ? copy.noUnwind : t.unwindOpensAt <= now ? copy.unwindAvailable : new Date(t.unwindOpensAt * 1000).toLocaleDateString("en-US", { dateStyle: "medium", timeZone: "UTC" })}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </Shell>
  );
}
