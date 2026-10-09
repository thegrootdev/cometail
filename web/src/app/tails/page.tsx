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
import { api, type Tail, type TailInfo } from "@/lib/api";
import { useMarket, type MarketToken } from "@/lib/market";
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
  // a vault whose fee token is not launched has nothing to show yet: no token, no raise, no buybacks
  const launched = rows.filter((t) => t.status !== "open");
  const statusLabel = (s: string) => (s === "live" ? copy.live : s === "launched" ? copy.launched : s === "unwound" ? copy.unwound : copy.open);
  return (
    <Shell wide>
      <PageHeader eyebrow={copy.eyebrow} title={copy.title} body={copy.body} />
      <WalletTails />
      <h2 className="section-title mt-6">{copy.vaultTitle}</h2>
      <p className="text-sm mb-3">{copy.vaultBody}</p>
      {state === "loading" && <DataState kind="loading" />}
      {state === "error" && <DataState kind="error" onRetry={() => { setState("loading"); void load(0); }} />}
      {state === "ok" && rows.length === 0 && <DataState title={copy.empty} />}
      {state === "ok" && rows.length > 0 && (
        <div className="table-scroll">
          <table className="stream-table fee-table">
            <thead><tr><th>Tail</th><th>{copy.source}</th><th>{copy.raise}</th><th>{copy.flowing}</th><th>{copy.buybacks}</th><th>{copy.burned}</th><th>{copy.unwind}</th></tr></thead>
            <tbody>
              {launched.map((t) => (
                <tr key={t.vault}>
                  <td data-label="Tail"><CoinCell mint={t.stMint} name={t.name} symbol={t.symbol} imageUrl={t.imageUrl} href={`/vault/${t.vault}`} /><p className="mt-1"><Badge tone={t.status === "live" ? "gold" : "ion"}>{statusLabel(t.status)}</Badge></p></td>
                  <td data-label={copy.source}>{t.sources.length ? t.sources.map((s) => <div key={s.stream} className="tail-source">{s.mint ? <CoinCell mint={s.mint} name={s.name} symbol={s.symbol} imageUrl={s.imageUrl} href={`/token/${s.mint}`} /> : <span className="micro">{copy.unavailable}</span>}<p className="micro">{s.kind === "dammV2Position" ? "locked liquidity" : "creator fees"}</p></div>) : "—"}</td>
                  <td data-label={copy.raise}>{t.raise ? <><Money lamports={t.raise.raisedLamports} secondary={false} /><span className="micro"> of </span><Money lamports={t.raise.targetLamports} secondary={false} />{t.raise.progressBps !== null ? <p className="micro">{(t.raise.progressBps / 100).toFixed(1)}%</p> : null}</> : <span className="micro">{copy.unavailable}</span>}</td>
                  <td className="money" data-label={copy.flowing}><Money lamports={t.feesIn.lifetimeLamports} /><p className="micro">24 h: <Money lamports={t.feesIn.last24hLamports} secondary={false} /></p></td>
                  <td className="money" data-label={copy.buybacks}>{t.bids.filledLamports !== null ? <Money lamports={t.bids.filledLamports} /> : <span className="micro">{copy.unavailable}</span>}<p className="micro">{copy.placed("")}<Money lamports={t.bids.placedLamports} secondary={false} /></p></td>
                  <td data-label={copy.burned}>{t.decimals !== null ? units(t.burnedStRaw, t.decimals) : copy.unavailable}</td>
                  <td data-label={copy.unwind}>{t.status === "unwound" ? copy.unwound : t.status !== "launched" || t.unwindOpensAtSec === null ? copy.noUnwind : t.unwindOpensAtSec <= now ? copy.unwindAvailable : new Date(t.unwindOpensAtSec * 1000).toLocaleDateString("en-US", { dateStyle: "medium", timeZone: "UTC" })}</td>
                </tr>
              ))}
            </tbody>
          </table>
          <p className="micro mt-3">{copy.of(launched.length, total - (rows.length - launched.length))}{rows.length > launched.length ? ` · ${copy.notLaunched(rows.length - launched.length)}` : ""}</p>
          {rows.length < total && <button type="button" className="button button-secondary mt-3" disabled={paging} onClick={() => void more()}>{copy.more}</button>}
        </div>
      )}
    </Shell>
  );
}

/** Coins launched from the team's wallet whose every fee claim is split toward $COMETAIL (tail-claims). */
function WalletTails() {
  const [tails, setTails] = useState<TailInfo[] | null | undefined>(undefined);
  useEffect(() => { void api.tailList().then((r) => setTails(r ? r.tails : null)); }, []);
  if (tails === undefined) return null;
  return (
    <section className="mt-4">
      <h2 className="section-title">{copy.walletTitle}</h2>
      <p className="text-sm mb-3">{copy.walletBody}</p>
      {tails === null ? <p className="micro">{copy.unavailable}</p> : tails.length === 0 ? <p className="micro">{copy.walletEmpty}</p> : (
        <div className="table-scroll">
          <table className="stream-table fee-table">
            <thead><tr><th>Tail</th><th>{copy.walletClaims}</th><th>{copy.walletClaimed}</th><th>{copy.walletToBurn}</th><th>{copy.walletLocked}</th></tr></thead>
            <tbody>{tails.map((t) => <WalletTailRow key={t.mint} t={t} />)}</tbody>
          </table>
        </div>
      )}
    </section>
  );
}
function WalletTailRow({ t }: { t: TailInfo }) {
  const m = useMarket<MarketToken>(`/api/tokens/${encodeURIComponent(t.mint)}`);
  const id = m.data?.data;
  const n = t.totals;
  return (
    <tr>
      <td data-label="Tail"><CoinCell mint={t.mint} name={id?.name ?? null} symbol={id?.symbol ?? null} imageUrl={id?.imageUrl ?? null} href={`/token/${t.mint}`} /></td>
      <td data-label={copy.walletClaims}>{n.claims === null ? copy.unavailable : n.claims}</td>
      <td className="money" data-label={copy.walletClaimed}>{n.claimedLamports === null ? copy.unavailable : <Money lamports={n.claimedLamports} />}</td>
      <td className="money" data-label={copy.walletToBurn}>{n.toBurnLamports === null ? copy.unavailable : <Money lamports={n.toBurnLamports} />}</td>
      <td className="money" data-label={copy.walletLocked}>{n.liquidityLamports === null ? copy.unavailable : <div><Money lamports={n.liquidityLamports} /><p className="micro">+ {units(n.liquidityRaw ?? "0", 6, 0)} $COMETAIL</p></div>}</td>
    </tr>
  );
}
