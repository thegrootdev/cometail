"use client";
// $COMETAIL buyback and burn: what the burn program has burned, what it spent, what waits in its
// reserve, when the next buyback can run, and every burn with its signature. Exact figures come from
// the program's own counters and the chain; anything not known reads "unknown", never zero.
import { useEffect, useState } from "react";
import Link from "next/link";
import { Card } from "./Shell";
import { Money } from "./Money";
import { api, type BurnView } from "@/lib/api";
import { EXPLORER } from "@/lib/addresses";
import { short, units } from "@/lib/format";
import { burnPanel as copy } from "@/content/cometail";

const when = (sec: number | null) => (sec ? new Date(sec * 1000).toLocaleString("en-US", { dateStyle: "medium", timeStyle: "short", timeZone: "UTC" }) + " UTC" : "—");

export function BurnPanel({ compact = false }: { compact?: boolean }) {
  const [data, setData] = useState<BurnView | null | undefined>(undefined);
  useEffect(() => {
    let live = true;
    const load = () => void api.burn().then((r) => { if (live) setData(r); });
    load();
    const t = setInterval(load, 30_000);
    return () => { live = false; clearInterval(t); };
  }, []);
  // the home page shows the panel once the program is live; the token page always says where it stands
  if (compact && data && data.status === "not-set-up") return null;
  const d = data?.cometail?.decimals ?? 6;
  const coin = (raw: string | null | undefined) => (raw === null || raw === undefined ? copy.unknown : `${units(raw, d)} $COMETAIL`);
  return (
    <Card title={copy.title} className={compact ? "burn-panel burn-compact" : "burn-panel mt-6"}>
      <p className="text-sm text-starlight/70">{copy.body}</p>
      {data === undefined ? <p className="micro mt-3">{copy.loading}</p>
        : data === null || data.status === "unavailable" ? <p className="micro mt-3">{copy.unavailable}</p>
        : data.status === "not-set-up" ? <p className="micro mt-3">{copy.notSetUp}</p>
        : <>
          <div className="burn-stats mt-4">
            <div><span className="micro">{copy.burned}</span><strong>{coin(data.totals?.burnedRaw)}</strong></div>
            <div><span className="micro">{copy.spent}</span><strong><Money lamports={data.totals?.spentLamports ?? null} /></strong></div>
            <div><span className="micro">{copy.buybacks}</span><strong>{data.totals?.buybacks ?? copy.unknown}</strong></div>
            <div><span className="micro">{copy.reserve}</span><strong>{data.reserve ? <Money lamports={data.reserve.lamports} /> : copy.unknown}</strong></div>
          </div>
          <p className="micro mt-3">{data.nextBuyback ? (data.nextBuyback.due ? copy.dueNow(units(data.nextBuyback.amountLamports, 9)) : BigInt(data.nextBuyback.amountLamports) < 1_000_000n ? copy.waitingForFunds : copy.dueAt(when(data.nextBuyback.dueAtSec))) : copy.nextUnknown}</p>
          {!compact && <>
            <dl className="outside-facts mt-4">
              <div><dt>{copy.claimedThroughProgram}</dt><dd><Money lamports={data.totals?.claimedThroughProgramLamports ?? null} /></dd></div>
              <div><dt>{copy.toReserve}</dt><dd><Money lamports={data.totals?.toReserveLamports ?? null} /></dd></div>
              <div><dt>{copy.toTreasury}</dt><dd><Money lamports={data.totals?.toTreasuryLamports ?? null} /></dd></div>
              <div><dt>{copy.sentDirect}</dt><dd>{data.sentDirectLamports ? <Money lamports={data.sentDirectLamports} /> : copy.unknown}</dd></div>
              <div><dt>{copy.tailsShare}</dt><dd>{data.commitment ? <Money lamports={data.commitment.tailsShareLamports} /> : copy.unknown}</dd></div>
              <div><dt>{copy.olderClaims}</dt><dd>{data.commitment?.olderConfigClaimsLamports ? <Money lamports={data.commitment.olderConfigClaimsLamports} /> : copy.unknown}</dd></div>
              <div><dt>{copy.claimableNow}</dt><dd>{data.claimableNow?.programConfigsLamports ? <Money lamports={data.claimableNow.programConfigsLamports} /> : copy.unknown}</dd></div>
              <div><dt>{copy.supply}</dt><dd>{coin(data.cometail?.supplyRaw)}</dd></div>
            </dl>
            <p className="micro mt-3">{copy.accountingNote}</p>
          </>}
          <h3 className="burn-list-title mt-4">{copy.listTitle}</h3>
          {data.coverage.status !== "complete" && <p className="micro">{data.coverage.status === "partial" ? copy.historyPartial : copy.historyUnavailable}</p>}
          {(data.burns ?? []).length === 0 ? <p className="micro">{copy.noBurns}</p> : (
            <ul className="burn-list">
              {(data.burns ?? []).slice(0, compact ? 5 : 50).map((b) => (
                <li key={b.signature}>
                  <span><strong>{units(b.burnedRaw, d)}</strong> <span className="micro">$COMETAIL for</span> <Money lamports={b.spentLamports} /></span>
                  <span className="micro">{when(b.blockTime)} · <a className="text-link" href={EXPLORER("tx", b.signature)} target="_blank" rel="noreferrer">{short(b.signature, 6)} ↗</a></span>
                </li>
              ))}
            </ul>
          )}
          <p className="micro mt-3"><a className="text-link" href={EXPLORER("address", data.program)} target="_blank" rel="noreferrer">{copy.program} {short(data.program)} ↗</a>{compact && data.cometail ? <> · <Link className="text-link" href={`/token/${data.cometail.mint}`}>{copy.more} ↗</Link></> : null}</p>
        </>}
    </Card>
  );
}
