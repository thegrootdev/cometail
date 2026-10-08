"use client";
// A tail's page panel: how the tail works, in plain words, and every claim of its creator fees, split or not, with
// what each sent to the $COMETAIL burn, the $COMETAIL the buybacks that spent it bought and burned (first in, first
// out through the reserve; shown only once the reserve's ledger proves it), and the liquidity it locked, each with
// its transaction. Shown only for mints the worker records as tails (/api/tail-claims/:mint).
import { useEffect, useState } from "react";
import { Card } from "./Shell";
import { Money } from "./Money";
import { api, type TailClaim, type TailInfo } from "@/lib/api";
import { EXPLORER } from "@/lib/addresses";
import { short, units } from "@/lib/format";
import { TAIL_TAKE_PCT } from "@/lib/tails";
import { tailPage as copy } from "@/content/cometail";

const TARGET = "$COMETAIL";
const TARGET_DECIMALS = 6;
const when = (t: number | null) => (t ? new Date(t * 1000).toISOString().slice(0, 16).replace("T", " ") + " UTC" : "");

/** What a claim's SOL bought and burned: unknown until the reserve's ledger proves it; while some of it waits, say so. */
function boughtText(c: TailClaim): string {
  if (!c.burn) return copy.pending;
  const waiting = BigInt(c.burn.waitingLamports);
  if (BigInt(c.burn.spentLamports) === 0n) return copy.waitingAll;
  const bought = `${units(c.burn.boughtRaw, TARGET_DECIMALS, 0)} ${TARGET}`;
  return waiting > 0n ? `${bought} · ${copy.waiting(units(c.burn.waitingLamports, 9, 4))}` : bought;
}

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
  const t = state.tail, n = t.totals;
  const boughtTotal = n.boughtRaw === null ? copy.pending : BigInt(n.boughtRaw) === 0n && BigInt(n.toBurnLamports ?? "0") > 0n ? copy.waitingAll : units(n.boughtRaw, TARGET_DECIMALS, 0);
  return (
    <Card title={copy.title(TARGET)} className="tail-panel">
      <p className="tail-tagline">{copy.tagline(TARGET)}</p>
      <p className="text-sm mt-2">{copy.how(TARGET)}</p>
      <p className="text-sm mt-2"><strong>{copy.honest}</strong></p>
      <p className="text-sm mt-2">{copy.graduation(TAIL_TAKE_PCT)}</p>
      {n.claims === null ? <p className="micro mt-3">{copy.partial}</p> : (
        <div className="burn-stats mt-3">
          <div><span className="micro">{copy.sentToBurn}</span><strong>{n.toBurnLamports === null ? copy.unknownWithAmbiguous : <Money lamports={n.toBurnLamports} />}</strong></div>
          <div><span className="micro">{copy.bought(TARGET)}</span><strong>{boughtTotal}</strong></div>
          <div><span className="micro">{copy.liquidity}</span>{n.liquidityLamports === null ? <strong>{copy.unknownWithAmbiguous}</strong> : <><strong><Money lamports={n.liquidityLamports} /></strong><span className="micro tail-plus">+ {units(n.liquidityRaw ?? "0", TARGET_DECIMALS, 0)} {TARGET}</span></>}</div>
          <div><span className="micro">{copy.claims}</span><strong>{n.claims}</strong>{(n.notSplit ?? 0) > 0 && <span className="micro tail-plus">{copy.notSplit}: {n.notSplit}</span>}</div>
        </div>
      )}
      <details className="burn-more mt-3" open={t.claims.length > 0 && t.claims.length <= 5}>
        <summary>{copy.list(t.claims.length)}</summary>
        {t.claims.length === 0 && t.payouts.length === 0 ? <p className="text-sm mt-2">{n.claims === null ? copy.partial : copy.none}</p> : (
          <ul className="tail-claims mt-2">
            {t.payouts.map((p) => (
              <li key={`${p.signature}-${p.kind}-${p.idx}`}>
                <p className="micro">{when(p.blockTime)}</p>
                <dl className="detail-list"><div><dt>{copy.payout[p.kind]}</dt><dd className="money"><Money lamports={p.lamports} /></dd></div></dl>
                <p className="micro"><a href={EXPLORER("tx", p.signature)} target="_blank" rel="noreferrer">{copy.tx} {short(p.signature)}</a></p>
              </li>
            ))}
            {t.claims.map((c) => (
              <li key={`${c.signature}-${c.source}-${c.idx}`} className={c.status === "split" ? "" : "tail-claim-unsplit"}>
                <p className="micro">{when(c.blockTime)} · {copy.source[c.source]} · <strong>{copy.status[c.status]}</strong></p>
                <dl className="detail-list">
                  <div><dt>{copy.claimed}</dt><dd className="money"><Money lamports={c.claimedLamports} /></dd></div>
                  {c.keptLamports !== null && <div><dt>{copy.kept}</dt><dd className="money"><Money lamports={c.keptLamports} /></dd></div>}
                  {c.toBurnLamports !== null && <div><dt>{copy.toBurn}</dt><dd className="money"><Money lamports={c.toBurnLamports} /></dd></div>}
                  {c.toBurnLamports !== null && <div><dt>{copy.bought(TARGET)}</dt><dd>{boughtText(c)}</dd></div>}
                  {c.liquidity && <div><dt>{c.liquidity.locked ? copy.added : copy.addedNotLocked}</dt><dd className="money"><Money lamports={c.liquidity.addedLamports} /><span className="micro tail-plus">+ {units(c.liquidity.addedRaw, TARGET_DECIMALS, 0)} {TARGET}</span></dd></div>}
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
