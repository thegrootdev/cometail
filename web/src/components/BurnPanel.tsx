"use client";
// $COMETAIL buyback and burn: what the burn program has burned, what it spent, what waits in its
// reserve, when the next buyback can run, and every burn with its signature. Exact figures come from
// the program's own counters and the chain; anything not known reads "unknown", never zero.
import { useEffect, useState } from "react";
import Link from "next/link";
import { Card } from "./Shell";
import { Money } from "./Money";
import { api, type BurnRow, type BurnView } from "@/lib/api";
import { EXPLORER } from "@/lib/addresses";
import { short, units } from "@/lib/format";
import { burnPanel as copy, home as homeCopy } from "@/content/cometail";
import { burnPanelRead, burnStatState, isLive, LIVE_FOR_MS, pollFigures } from "@/lib/freshness";

const when = (sec: number | null) => (sec ? new Date(sec * 1000).toLocaleString("en-US", { dateStyle: "medium", timeStyle: "short", timeZone: "UTC" }) + " UTC" : "—");

export function BurnPanel({ compact = false }: { compact?: boolean }) {
  const [data, setData] = useState<BurnView | null | undefined>(undefined);
  const [older, setOlder] = useState<BurnRow[]>([]);
  const [olderCursor, setOlderCursor] = useState<string | null | undefined>(undefined);
  const [paging, setPaging] = useState(false);
  const more = async () => {
    const cursor = olderCursor === undefined ? data?.burnsNextCursor : olderCursor;
    if (!cursor || paging) return;
    setPaging(true);
    try { const p = await api.burnPage(cursor); if (p) { setOlder((o) => [...o, ...p.items]); setOlderCursor(p.nextCursor); } } finally { setPaging(false); }
  };
  useEffect(() => {
    let live = true;
    // a kept live view is asked again soon: the read it started is usually done by then
    const stop = pollFigures(async () => {
      const r = await api.burn();
      if (!live) return false;
      setData(r);
      return !!r && r.status === "live" && !isLive(r.generatedAtMs, r.servedAtMs, LIVE_FOR_MS.burn);
    }, 30_000);
    return () => { live = false; stop(); };
  }, []);
  // the home page shows the panel once the program is live; the token page always says where it stands
  if (compact && data && data.status === "not-set-up") return null;
  const d = data?.cometail?.decimals ?? 6;
  // when these figures were read, and whether that is recent (a kept view is not a new read)
  const read = data && data.status === "live" ? burnPanelRead(data) : null;
  const coin = (raw: string | null | undefined) => (raw === null || raw === undefined ? copy.unknown : `${units(raw, d)} $COMETAIL`);
  // the token page shows the numbers; every burn, the accounting and the program link sit in one fold
  const body = data && data.status === "live" ? <>
    {!compact && <>
      <dl className="outside-facts mt-4">
        <div><dt>{copy.claimedThroughProgram}</dt><dd>{data.provenance?.claimedByProgramLamports ? <Money lamports={data.provenance.claimedByProgramLamports} /> : copy.unknown}</dd></div>
        <div><dt>{copy.claimedByOwners}</dt><dd>{data.provenance?.claimedByOwnersLamports ? <Money lamports={data.provenance.claimedByOwnersLamports} /> : copy.unknown}</dd></div>
        <div><dt>{copy.carried}</dt><dd>{data.provenance?.carriedLamports ? <Money lamports={data.provenance.carriedLamports} /> : copy.unknown}</dd></div>
        <div><dt>{copy.toReserve}</dt><dd><Money lamports={data.totals?.toReserveLamports ?? null} /></dd></div>
        <div><dt>{copy.toTreasury}</dt><dd><Money lamports={data.totals?.toOtherLamports ?? null} /></dd></div>
        <div><dt>{copy.sentDirect}</dt><dd>{data.sentDirectLamports ? <Money lamports={data.sentDirectLamports} /> : copy.unknown}</dd></div>
        <div><dt>{copy.tailsShare}</dt><dd>{data.commitment ? <Money lamports={data.commitment.tailsShareLamports} /> : copy.unknown}</dd></div>
        <div><dt>{copy.claimableNow}</dt><dd>{data.claimableNow?.programConfigsLamports ? <Money lamports={data.claimableNow.programConfigsLamports} /> : copy.unknown}</dd></div>
        <div><dt>{copy.supply}</dt><dd>{coin(data.cometail?.supplyRaw)}</dd></div>
      </dl>
      <p className="micro mt-3">{copy.accountingNote}</p>
    </>}
    <h3 className="burn-list-title mt-4">{copy.listTitle(Math.min((data.burns ?? []).length + older.length, compact ? 5 : Infinity), data.burnsTotal ?? 0)}</h3>
    {(data.coverage.status !== "complete" || data.history?.reconciled === false) && <p className="micro">{data.coverage.status === "unavailable" ? copy.historyUnavailable : copy.historyPartial}</p>}
    {(data.burns ?? []).length === 0 ? <p className="micro">{copy.noBurns}</p> : (
      <ul className="burn-list">
        {[...(data.burns ?? []), ...(compact ? [] : older)].slice(0, compact ? 5 : undefined).map((b) => (
          <li key={b.signature}>
            <span><strong>{units(b.burnedRaw, d)}</strong> <span className="micro">$COMETAIL for</span> <Money lamports={b.spentLamports} /></span>
            <span className="micro">{when(b.blockTime)} · <a className="text-link" href={EXPLORER("tx", b.signature)} target="_blank" rel="noreferrer">{short(b.signature, 6)} ↗</a></span>
          </li>
        ))}
      </ul>
    )}
    {!compact && (olderCursor === undefined ? data.burnsNextCursor : olderCursor) && <button type="button" className="button button-secondary mt-3" disabled={paging} onClick={() => void more()}>{copy.showMore}</button>}
    <p className="micro mt-3"><a className="text-link" href={EXPLORER("address", data.program)} target="_blank" rel="noreferrer">{copy.program} {short(data.program)} ↗</a> · <a className="text-link" href={`https://verify.osec.io/status/${data.program}`} target="_blank" rel="noreferrer">{copy.verified} ↗</a>{compact && data.cometail ? <> · <Link className="text-link" href={`/token/${data.cometail.mint}`}>{copy.more} ↗</Link></> : null}</p>
  </> : null;
  return (
    <Card title={copy.title} className={compact ? "burn-panel burn-compact" : "burn-panel mt-6"}>
      <p className="text-sm text-starlight/70">{copy.body}</p>
      {data === undefined ? <p className="micro mt-3">{copy.loading}</p>
        : data === null || data.status === "unavailable" ? <p className="micro mt-3">{copy.unavailable}</p>
        : data.status === "not-set-up" ? <p className="micro mt-3">{copy.notSetUp}</p>
        : <>
          <div className="burn-stats mt-4">
            <div><span className="micro">{copy.burned}</span><strong>{data.totals?.burnedRaw ? `${units(data.totals.burnedRaw, d, 0)} $COMETAIL` : copy.unknown}</strong></div>
            <div><span className="micro">{copy.spent}</span><strong><Money lamports={data.totals?.spentLamports ?? null} /></strong></div>
            <div><span className="micro">{copy.buybacks}</span><strong>{data.totals?.buybacks ?? copy.unknown}</strong></div>
            <div><span className="micro">{copy.reserve}</span><strong>{data.reserve ? <Money lamports={data.reserve.lamports} /> : copy.unknown}</strong></div>
          </div>
          {read?.line && <p className="micro mt-3">{read.line}</p>}
          <p className="micro mt-3">{data.nextBuyback ? (data.nextBuyback.due ? copy.dueNow(units(data.nextBuyback.amountLamports, 9)) : BigInt(data.nextBuyback.amountLamports) < 1_000_000n ? copy.waitingForFunds : copy.dueAt(when(data.nextBuyback.dueAtSec))) : copy.nextUnknown}</p>
          {compact ? body : <details className="burn-more mt-3">
            <summary>{copy.everyBurn(data.burnsTotal ?? 0)}</summary>
            {body}
          </details>}
        </>}
    </Card>
  );
}

/** The home page's live line: how much $COMETAIL the burn program has burned, linking to its page. Hidden until the program reports. */
export function BurnStat() {
  const [data, setData] = useState<BurnView | null>(null);
  // true once a read fails or the program reports a non-live status: the last figure stays, marked last known, as it
  // does while the view that arrives is a kept one whose read is not recent (lib/freshness.ts)
  const [failed, setFailed] = useState(false);
  useEffect(() => {
    let live = true;
    const stop = pollFigures(async () => {
      const r = await api.burn();
      if (!live) return false;
      const ok = !!r && r.status === "live" && !!r.totals?.burnedRaw && !!r.cometail;
      if (ok) setData(r);
      setFailed(!ok);
      return ok && !isLive(r!.generatedAtMs, r!.servedAtMs, LIVE_FOR_MS.burn);
    }, 30_000);
    return () => { live = false; stop(); };
  }, []);
  if (!data?.totals?.burnedRaw || !data.cometail) return null;
  const f = burnStatState(data, failed);
  return (
    <Link className={`burn-stat ${f.live ? "" : "is-last-known"}`} href={`/token/${data.cometail.mint}`} title={f.title}>
      <span className="burn-flame" aria-hidden="true" />
      <strong>{units(data.totals.burnedRaw, data.cometail.decimals ?? 6, 0)}</strong>
      <span>{homeCopy.burned}</span>
      {f.live ? <span className="burn-live" aria-hidden="true" /> : <span className="burn-stale">{f.stale}</span>}
    </Link>
  );
}
