"use client";
// Tails: every vault's tail token with the coins whose fees fund it (any launchpad), its raise, the fees
// flowing in (lifetime, and the exact sum of the last 24 hours of harvest events), the buybacks filled
// (bids placed minus refunded minus still resting; unavailable while resting principal is unknown), the
// tail tokens burned, and when its unwind opens. One server-side rollup, paged; never a zero for a value
// that could not be read.
import { useEffect, useRef, useState } from "react";
import Link from "next/link";
import { Shell } from "@/components/Shell";
import { PageHeader, DataState, Badge } from "@/components/Experience";
import { Money } from "@/components/Money";
import { CoinCell } from "@/components/CoinCell";
import { api, type Tail } from "@/lib/api";
import { short, units } from "@/lib/format";
import { tailsPage as copy } from "@/content/cometail";

const PAGE = 25;

export default function TailsPage() {
  const [rows, setRows] = useState<Tail[]>([]);
  const [total, setTotal] = useState(0);
  const [state, setState] = useState<"loading" | "ok" | "error">("loading");
  const [paging, setPaging] = useState(false);
  const generation = useRef(0);
  const load = async (offset: number) => {
    const g = offset === 0 ? ++generation.current : generation.current;
    const r = await api.tails({ limit: PAGE, offset });
    if (g !== generation.current) return;
    if (!r) { if (offset === 0) setState("error"); return; }
    setTotal(r.total); setRows((old) => (offset ? [...old, ...r.tails] : r.tails)); setState("ok");
  };
  useEffect(() => { void load(0); }, []);
  const more = async () => { if (paging) return; setPaging(true); try { await load(rows.length); } finally { setPaging(false); } };
  const now = Date.now() / 1000;
  const statusLabel = (s: string) => (s === "live" ? copy.live : s === "launched" ? copy.launched : s === "unwound" ? copy.unwound : copy.open);
  return (
    <Shell wide>
      <PageHeader eyebrow={copy.eyebrow} title={copy.title} body={copy.body} />
      {state === "loading" && <DataState kind="loading" />}
      {state === "error" && <DataState kind="error" onRetry={() => { setState("loading"); void load(0); }} />}
      {state === "ok" && rows.length === 0 && <DataState title={copy.empty} />}
      {state === "ok" && rows.length > 0 && (
        <div className="table-scroll">
          <table className="stream-table fee-table">
            <thead><tr><th>Tail</th><th>{copy.source}</th><th>{copy.raise}</th><th>{copy.flowing}</th><th>{copy.buybacks}</th><th>{copy.burned}</th><th>{copy.unwind}</th></tr></thead>
            <tbody>
              {rows.map((t) => (
                <tr key={t.vault}>
                  <td data-label="Tail"><CoinCell mint={t.stMint} name={t.name} symbol={t.symbol} imageUrl={t.imageUrl} href={`/vault/${t.vault}`} /><p className="mt-1"><Badge tone={t.status === "live" ? "gold" : "ion"}>{statusLabel(t.status)}</Badge></p></td>
                  <td data-label={copy.source}>{t.sources.length ? t.sources.map((s) => <div key={s.stream} className="tail-source">{s.mint ? <CoinCell mint={s.mint} name={s.name} symbol={s.symbol} imageUrl={s.imageUrl} href={`/token/${s.mint}`} /> : <span className="micro">{copy.unavailable}</span>}<p className="micro">{s.kind === "dammV2Position" ? "locked liquidity" : "creator fees"}</p></div>) : "—"}</td>
                  <td data-label={copy.raise}>{t.raise ? <><Money lamports={t.raise.raisedLamports} secondary={false} /><span className="micro"> of </span><Money lamports={t.raise.targetLamports} secondary={false} />{t.raise.progressBps !== null ? <p className="micro">{(t.raise.progressBps / 100).toFixed(1)}%</p> : null}</> : <span className="micro">{copy.unavailable}</span>}</td>
                  <td className="money" data-label={copy.flowing}><Money lamports={t.feesIn.lifetimeLamports} /><p className="micro">24 h: <Money lamports={t.feesIn.last24hLamports} secondary={false} /></p></td>
                  <td className="money" data-label={copy.buybacks}>{t.bids.filledLamports !== null ? <Money lamports={t.bids.filledLamports} /> : <span className="micro">{copy.unavailable}</span>}<p className="micro">{copy.placed("")}<Money lamports={t.bids.placedLamports} secondary={false} /></p></td>
                  <td data-label={copy.burned}>{t.decimals !== null ? units(t.burnedStRaw, t.decimals) : `${t.burnedStRaw} raw`}</td>
                  <td data-label={copy.unwind}>{t.status === "unwound" ? copy.unwound : t.status !== "launched" || t.unwindOpensAtSec === null ? copy.noUnwind : t.unwindOpensAtSec <= now ? copy.unwindAvailable : new Date(t.unwindOpensAtSec * 1000).toLocaleDateString("en-US", { dateStyle: "medium", timeZone: "UTC" })}</td>
                </tr>
              ))}
            </tbody>
          </table>
          <p className="micro mt-3">{copy.of(rows.length, total)}</p>
          {rows.length < total && <button type="button" className="button button-secondary mt-3" disabled={paging} onClick={() => void more()}>{copy.more}</button>}
        </div>
      )}
    </Shell>
  );
}
