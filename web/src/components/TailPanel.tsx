"use client";
// A tail's page panel: how the tail works, in plain words, and every claim of its creator fees with what each
// sent to the $COMETAIL burn, what that SOL burned (first in, first out through the reserve) and the liquidity it
// locked, each with its transaction. Shown only for mints the worker records as tails (/api/tail-claims/:mint).
import { useEffect, useState } from "react";
import { Card } from "./Shell";
import { Money } from "./Money";
import { api, type TailInfo } from "@/lib/api";
import { EXPLORER } from "@/lib/addresses";
import { short, units } from "@/lib/format";
import { TAIL_TAKE_PCT } from "@/lib/tails";
import { tailPage as copy } from "@/content/cometail";

const TARGET = "$COMETAIL";
const TARGET_DECIMALS = 6;
/** What a claim's SOL burned: unknown until the reserve's history is read; while some of it waits, say so. */
function burnedText(c: TailInfo["claims"][number]): string {
  if (!c.burn || c.burn.burnedRaw === null) return copy.pending;
  const waiting = BigInt(c.burn.waitingLamports);
  if (BigInt(c.burn.spentLamports) === 0n) return copy.waitingAll;
  const burned = `${units(c.burn.burnedRaw, TARGET_DECIMALS, 0)} ${TARGET}`;
  return waiting > 0n ? `${burned} · ${copy.waiting(units(c.burn.waitingLamports, 9, 4))}` : burned;
}
const when = (t: number | null) => (t ? new Date(t * 1000).toISOString().slice(0, 16).replace("T", " ") + " UTC" : "");

export function TailPanel({ mint }: { mint: string }) {
  const [state, setState] = useState<{ kind: "loading" } | { kind: "missing" } | { kind: "error" } | { kind: "ok"; tail: TailInfo }>({ kind: "loading" });
  useEffect(() => {
    let live = true;
    const load = () => api.tail(mint).then((r) => { if (live) setState(r.state === "ok" ? { kind: "ok", tail: r.tail } : { kind: r.state }); });
    void load();
    const t = setInterval(load, 60_000);
    return () => { live = false; clearInterval(t); };
  }, [mint]);
  if (state.kind === "missing") return null;
  if (state.kind === "loading") return <Card title={copy.title(TARGET)}><p className="text-sm">{copy.loading}</p></Card>;
  if (state.kind === "error") return <Card title={copy.title(TARGET)}><p className="text-sm">{copy.unavailable}</p></Card>;
  const t = state.tail;
  const partial = t.coverage.claims.status !== "complete";
  return (
    <Card title={copy.title(TARGET)} className="tail-panel">
      <p className="tail-tagline">{copy.tagline(TARGET)}</p>
      <p className="text-sm mt-2">{copy.how(TARGET)}</p>
      <p className="text-sm mt-2"><strong>{copy.honest}</strong></p>
      <p className="text-sm mt-2">{copy.graduation(TAIL_TAKE_PCT)}</p>
      <div className="burn-stats mt-3">
        <div><span className="micro">{copy.sentToBurn}</span><strong><Money lamports={t.totals.toBurnLamports} /></strong></div>
        <div><span className="micro">{copy.burned(TARGET)}</span><strong>{t.totals.burnedRaw === null ? copy.pending : BigInt(t.totals.burnedRaw) === 0n && BigInt(t.totals.toBurnLamports) > 0n ? copy.waitingAll : units(t.totals.burnedRaw, TARGET_DECIMALS, 0)}</strong></div>
        <div><span className="micro">{copy.liquidity}</span><strong><Money lamports={t.totals.liquidityLamports} /></strong><span className="micro">+ {units(t.totals.liquidityRaw, TARGET_DECIMALS, 0)} {TARGET}</span></div>
        <div><span className="micro">{copy.claims}</span><strong>{t.totals.claims}</strong></div>
      </div>
      {partial && <p className="micro mt-2">{copy.partial}</p>}
      <details className="burn-more mt-3" open={t.claims.length > 0 && t.claims.length <= 5}>
        <summary>{copy.list(t.claims.length)}</summary>
        {t.claims.length === 0 ? <p className="text-sm mt-2">{copy.none}</p> : (
          <ul className="tail-claims mt-2">
            {t.claims.map((c) => (
              <li key={c.signature}>
                <p className="micro">{when(c.blockTime)}</p>
                <dl className="detail-list">
                  <div><dt>{copy.claimed}</dt><dd className="money"><Money lamports={c.claimedLamports} /></dd></div>
                  <div><dt>{copy.kept}</dt><dd className="money"><Money lamports={c.keptLamports} /></dd></div>
                  <div><dt>{copy.toBurn}</dt><dd className="money"><Money lamports={c.toBurnLamports} /></dd></div>
                  <div><dt>{copy.burned(TARGET)}</dt><dd>{burnedText(c)}</dd></div>
                  <div><dt>{copy.added}</dt><dd className="money"><Money lamports={c.liquidity.addedLamports} /><span className="micro tail-plus">+ {units(c.liquidity.addedRaw, TARGET_DECIMALS, 0)} {TARGET}</span></dd></div>
                </dl>
                <p className="micro">
                  <a href={EXPLORER("tx", c.signature)} target="_blank" rel="noreferrer">{copy.tx} {short(c.signature)}</a>
                  {c.burn && c.burn.buybacks.length > 0 && <> · {copy.buybacks}: {c.burn.buybacks.map((b, i) => <span key={b}>{i ? ", " : ""}<a href={EXPLORER("tx", b)} target="_blank" rel="noreferrer">{short(b)}</a></span>)}</>}
                </p>
              </li>
            ))}
          </ul>
        )}
      </details>
    </Card>
  );
}
