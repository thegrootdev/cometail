"use client";
// Proof: every public figure about COMETAIL in one place, each read from chain (or from the indexer that follows
// it) with the moment it was read and a link where a reader can check it. A figure the server cannot prove at
// that moment arrives as null and reads "unknown", never a guess or a zero.
import { useEffect, useState } from "react";
import Link from "next/link";
import { BURN_PROGRAM_ID, VAULT_PROGRAM_ID } from "@cometail/client";
import { Shell, Card } from "@/components/Shell";
import { PageHeader, DataState } from "@/components/Experience";
import { Money } from "@/components/Money";
import { api, type Stats, type StatsLaunch } from "@/lib/api";
import { API_URL, EXPLORER, isEarly, vaultInLists } from "@/lib/addresses";
import { units } from "@/lib/format";
import { quoteAsset, WSOL } from "@/lib/quotes";
import { shownName, shownSymbol, tickerText } from "@/lib/token-display";
import { statsPage as copy } from "@/content/cometail";

// the commits OtterSec's verifier rebuilt; they change only with a program upgrade
const VERIFIED = [
  { label: copy.verified.vault, program: VAULT_PROGRAM_ID.toBase58(), commit: "741e8e751825b005b6cedc359a7e8c6d937997dd" },
  { label: copy.verified.burn, program: BURN_PROGRAM_ID.toBase58(), commit: "58956342a8c9e65892ea4fcad2704b579959854b" },
];
const REPO = "https://github.com/thegrootdev/cometail";

const when = (ms: number | null | undefined) => (ms ? new Date(ms).toLocaleString("en-US", { dateStyle: "medium", timeStyle: "short", timeZone: "UTC" }) + " UTC" : copy.unknown);
const n = (v: number | null | undefined) => (v === null || v === undefined ? copy.unknown : v.toLocaleString("en-US"));
const sum = (xs: (string | null)[]) => (xs.some((x) => x === null) ? null : xs.reduce((t, x) => t + BigInt(x as string), 0n).toString());
const pctBps = (bps: number | null) => (bps === null ? copy.unknown : `${(bps / 100).toFixed(2)}%`);

function Out({ href, children }: { href: string; children: React.ReactNode }) {
  return <a className="text-link" href={href} target="_blank" rel="noreferrer">{children}</a>;
}
/** One figure: the number links to where it can be checked. */
function Fig({ label, href, children, sub }: { label: string; href: string; children: React.ReactNode; sub?: React.ReactNode }) {
  return <div><span className="micro">{label}</span><strong><a className="stats-figure" href={href} target={href.startsWith("/") ? undefined : "_blank"} rel="noreferrer">{children}</a></strong>{sub ? <span className="micro">{sub}</span> : null}</div>;
}
function Lamports({ v, quote }: { v: string | null | undefined; quote?: { mint: string; decimals: number | null; sol?: number | null } }) {
  if (v === null || v === undefined) return <>{copy.unknown}</>;
  // a launch quoted in another token shows its own unit, never SOL (a $COMETAIL one adds SOL at today's pool price)
  return quote && quote.mint !== WSOL ? <Money lamports={v} quote={quoteAsset(quote.mint, quote.decimals, null, quote.sol)} /> : <Money lamports={v} />;
}
/** SOL per whole $COMETAIL at the stats read, from its pool (lamports per token x 10^6). */
const cometailSol = (s: Stats) => { const m = s.pairedQuote?.microLamportsPerToken; return m ? Number(m) / 1e15 : null; };
function Footer({ readAtMs, href, label = copy.check }: { readAtMs: number | null | undefined; href: string; label?: string }) {
  return <p className="micro mt-3">{copy.read(when(readAtMs))} · <Out href={href}>{label} ↗</Out></p>;
}

export default function StatsPage() {
  const [s, setS] = useState<Stats | null | undefined>(undefined);
  const load = () => void api.stats().then((r) => setS(r));
  useEffect(() => { load(); const t = setInterval(load, 60_000); return () => clearInterval(t); }, []);
  const raw = `${API_URL}/api/stats`;
  return (
    <Shell wide>
      <PageHeader eyebrow={copy.eyebrow} title={copy.title} body={copy.body} />
      {s === undefined && <DataState kind="loading" title={copy.loading} />}
      {s === null && <DataState kind="error" title={copy.error} onRetry={() => { setS(undefined); load(); }} />}
      {s && <Body s={s} raw={raw} />}
    </Shell>
  );
}

function Body({ s, raw }: { s: Stats; raw: string }) {
  const L = s.launches, T = s.trading, F = s.fees, B = s.burn, P = s.pairedQuote ?? null;
  const pairedSol = cometailSol(s);
  const pairedFees = F.paired ? sum([F.paired.curveTradingRaw, F.paired.curveProtocolRaw, F.paired.poolLpRaw, F.paired.poolProtocolRaw]) : null;
  // every figure counts all our launches; the per-coin rows leave out our early coins
  const graduated = L.list.filter((l) => l.dammPool && !isEarly(l.mint));
  const d = B?.decimals ?? 6;
  const coin = (rawAmount: string | null | undefined) => (rawAmount === null || rawAmount === undefined ? copy.unknown : units(rawAmount, d, 0));
  const tailRows = s.tails?.list ?? [];
  const tailSum = (f: (t: (typeof tailRows)[number]) => string | null) => (s.tails ? sum(tailRows.map(f)) : null);
  const tailClaims = s.tails && tailRows.every((t) => t.claims !== null) ? tailRows.reduce((a, t) => a + (t.claims ?? 0), 0) : null;
  const madeUp = tailRows.reduce((a, t) => a + (t.madeUp ?? 0), 0);
  const notSplit = tailRows.reduce((a, t) => a + (t.notSplit ?? 0), 0);
  // split in the claim's own transaction = every claim that is neither unresolved/not split nor made up later
  const splitAtClaim = tailClaims === null ? null : tailClaims - notSplit - madeUp;
  const v = s.vaults;
  return (
    <div className="stats-page">
      <Card title={copy.trading.title} className="burn-panel">
        <div className="burn-stats">
          <Fig label={copy.trading.volume} href={raw}><Lamports v={T.volumeLamports} /></Fig>
          <Fig label={copy.trading.trades} href={raw}>{n(T.trades)}</Fig>
          <Fig label={copy.trading.traders} href={raw}>{n(T.traders)}</Fig>
          <Fig label={copy.trading.outside} href={raw}><Lamports v={T.outsideVolumeLamports} /></Fig>
        </div>
        <p className="micro mt-3">{T.complete ? copy.trading.note : copy.trading.partial}</p>
        {P && P.launches > 0 && <p className="micro mt-2">{copy.trading.paired(T.pairedVolumeLamports ? `${units(T.pairedVolumeLamports, 9, 2)} SOL` : copy.unknown, T.pairedRoutedLamports ? `${units(T.pairedRoutedLamports, 9, 2)} SOL` : copy.unknown)}</p>}
        <Footer readAtMs={T.readAtMs} href={raw} label={copy.json} />
      </Card>

      <Card title={copy.fees.title} className="burn-panel">
        <div className="burn-stats">
          <Fig label={copy.fees.total} href={raw}><Lamports v={F.totalLamports} /></Fig>
          <Fig label={copy.fees.curve} href={raw}><Lamports v={F.curveTradingLamports} /></Fig>
          <Fig label={copy.fees.pool} href={raw}><Lamports v={F.poolLpLamports} /></Fig>
          <Fig label={copy.fees.meteora} href={raw}><Lamports v={F.meteoraProtocolLamports} /></Fig>
        </div>
        <p className="micro mt-3">{copy.fees.note}</p>
        {F.paired && <p className="micro mt-2">{copy.fees.paired(pairedFees === null ? copy.unknown : `${units(pairedFees, 6, 0)} $COMETAIL`, pairedFees !== null && pairedSol ? `${(Number(pairedFees) / 1e6 * pairedSol).toLocaleString("en-US", { maximumFractionDigits: 4 })} SOL` : "")}</p>}
        <Footer readAtMs={F.readAtMs} href={raw} label={copy.json} />
      </Card>

      <Card title={copy.launches.title} className="burn-panel">
        <div className="burn-stats">
          <Fig label={copy.launches.total} href={`${API_URL}/api/tokens?sort=newest&limit=100`}>{n(L.total)}</Fig>
          <Fig label={copy.launches.graduated} href={raw}>{n(L.graduated.total)}</Fig>
          <Fig label={copy.launches.ours} href={raw}>{n(L.team)}</Fig>
          <Fig label={copy.launches.outside} href={raw} sub={L.unattributed ? `${copy.launches.unattributed}: ${L.unattributed}` : undefined}>{n(L.outside)}</Fig>
        </div>
        <p className="micro mt-3">{copy.launches.note}</p>
        <LaunchTable list={L.list.filter((l) => !isEarly(l.mint))} pairedSol={pairedSol} />
        <Footer readAtMs={L.readAtMs} href={`${API_URL}/api/tokens?sort=newest&limit=100`} />
      </Card>

      <Card title={copy.burn.title} className="burn-panel">
        {B ? <>
          <div className="burn-stats">
            <Fig label={copy.burn.burned} href={EXPLORER("address", B.program)}>{coin(B.burnedRaw)}</Fig>
            <Fig label={copy.burn.buybacks} href={`${API_URL}/api/burn`}>{n(B.buybacks)}</Fig>
            <Fig label={copy.burn.spent} href={`${API_URL}/api/burn`}><Lamports v={B.spentLamports} /></Fig>
            <Fig label={copy.burn.supply} href={B.mint ? EXPLORER("address", B.mint) : `${API_URL}/api/burn`}>{coin(B.supplyRaw)}</Fig>
            {P?.burned && <Fig label={copy.burn.pairedBurned} href={EXPLORER("address", P.burned.account)} sub={P.burned.complete ? copy.burn.pairedSub(P.burned.burns) : copy.trading.partial}>{P.burned.complete ? coin(P.burned.burnedRaw) : copy.unknown}</Fig>}
          </div>
          <p className="micro mt-3">{copy.burn.note}</p>
          {P?.burned && <p className="micro mt-2">{copy.burn.pairedNote} {copy.read(when(P.burned.readAtMs))}</p>}
          <p className="micro mt-2">{copy.burn.split}: <Money lamports={B.splitLamports} secondary={false} />{B.mint ? <> · <Link className="text-link" href={`/token/${B.mint}`}>{copy.burn.page} →</Link></> : null}</p>
          <Footer readAtMs={B.readAtMs} href={EXPLORER("address", B.program)} />
        </> : <p className="text-sm">{copy.unknown}</p>}
      </Card>

      <Card title={copy.liquidity.title} className="burn-panel">
        <div className="burn-stats">
          {graduated.map((l) => <Fig key={l.mint} label={copy.liquidity.locked(display(l))} href={EXPLORER("address", l.dammPool!)}>{pctBps(l.lockedBps)}</Fig>)}
        </div>
        {graduated.length === 0 && <p className="text-sm">{copy.liquidity.none}</p>}
        <p className="micro mt-3">{copy.liquidity.note}</p>
        <Footer readAtMs={F.readAtMs} href={raw} label={copy.json} />
      </Card>

      <Card title={copy.tails.title} className="burn-panel">
        <div className="burn-stats">
          <Fig label={copy.tails.claims} href={`${API_URL}/api/tail-claims`} sub={tailClaims === null ? undefined : copy.tails.statuses(splitAtClaim ?? 0, madeUp, notSplit)}>{n(tailClaims)}</Fig>
          <Fig label={copy.tails.claimed} href={`${API_URL}/api/tail-claims`}><Lamports v={tailSum((t) => t.claimedLamports)} /></Fig>
          <Fig label={copy.tails.toBurn} href={`${API_URL}/api/tail-claims`}><Lamports v={tailSum((t) => t.toBurnLamports)} /></Fig>
          <Fig label={copy.tails.liquidity} href={`${API_URL}/api/tail-claims`} sub={tailSum((t) => t.liquidityRaw) !== null ? `+ ${coin(tailSum((t) => t.liquidityRaw))} $COMETAIL` : undefined}><Lamports v={tailSum((t) => t.liquidityLamports)} /></Fig>
        </div>
        <p className="micro mt-3">{copy.tails.note} {tailRows.map((t, i) => <span key={t.mint}>{i ? " · " : ""}<Link className="text-link" href={`/token/${t.mint}`}>{copy.tails.page} →</Link></span>)}</p>
        <Footer readAtMs={s.tails?.readAtMs} href={`${API_URL}/api/tail-claims`} />
      </Card>

      <Card title={copy.vaults.title} className="burn-panel">
        <div className="burn-stats">
          <Fig label={copy.vaults.vaults} href={`${API_URL}/api/vaults`}>{n(v.total)}</Fig>
          <Fig label={copy.vaults.launched} href={`${API_URL}/api/vaults`}>{n(v.launched)}</Fig>
          <Fig label={copy.vaults.harvested} href={`${API_URL}/api/vaults`}><Lamports v={sum(v.list.map((x) => x.harvestedLamports))} /></Fig>
          <Fig label={copy.vaults.waiting} href={`${API_URL}/api/vaults`}><Lamports v={sum(v.list.map((x) => x.waitingLamports))} /></Fig>
        </div>
        <p className="micro mt-3">{copy.vaults.note} {v.list.filter((x) => x.status !== "open" && vaultInLists(x.vault)).map((x, i) => <span key={x.vault}>{i ? " · " : ""}<Link className="text-link" href={`/vault/${x.vault}`}>{x.vault.slice(0, 4)}… →</Link></span>)}</p>
        <Footer readAtMs={v.readAtMs} href={`${API_URL}/api/vaults`} />
      </Card>

      <Card title={copy.feeIndex.title} className="burn-panel">
        {s.feeIndex ? <>
          <div className="burn-stats">
            <Fig label={copy.feeIndex.pools} href={`${API_URL}/api/fees/status`}>{n(s.feeIndex.pools)}</Fig>
            <Fig label={copy.feeIndex.configs} href={`${API_URL}/api/fees/status`}>{n(s.feeIndex.configs)}</Fig>
            <Fig label={copy.feeIndex.claims} href={`${API_URL}/api/fees/status`}>{n(s.feeIndex.claimsConfirmed)}</Fig>
          </div>
          <p className="micro mt-3">{s.feeIndex.refreshMinutes ? copy.feeIndex.refresh(s.feeIndex.refreshMinutes) + " · " : ""}<Link className="text-link" href="/fees">{copy.feeIndex.open} →</Link></p>
          <Footer readAtMs={s.feeIndex.readAtMs} href={`${API_URL}/api/fees/status`} />
        </> : <p className="text-sm">{copy.unknown}</p>}
      </Card>

      <div id="verified" className="stats-anchor" />
      <Card title={copy.verified.title} className="burn-panel" icon="planet">
        <p className="text-sm">{copy.verified.note}</p>
        <dl className="detail-list mt-3">
          {VERIFIED.map((x) => (
            <div key={x.program}><dt>{x.label}</dt><dd className="wrap-anywhere">
              <Out href={`https://verify.osec.io/status/${x.program}`}>{copy.verified.record} ↗</Out> · <Out href={EXPLORER("address", x.program)}>{x.program.slice(0, 4)}…{x.program.slice(-4)} ↗</Out> · <Out href={`${REPO}/tree/${x.commit}`}>{copy.verified.source} {x.commit.slice(0, 7)} ↗</Out>
            </dd></div>
          ))}
        </dl>
      </Card>
      <p className="micro mt-4"><Out href={raw}>{copy.json} ↗</Out> · {copy.read(when(s.generatedAtMs))}</p>
    </div>
  );
}

const display = (l: StatsLaunch) => tickerText(shownSymbol(l.mint, l.symbol)) || l.mint.slice(0, 4);

function LaunchTable({ list, pairedSol }: { list: StatsLaunch[]; pairedSol: number | null }) {
  const C = copy.launches;
  // launches valued in SOL (SOL-quoted, and paired with $COMETAIL at each trade's price) by volume first; amounts in other
  // quote tokens are not comparable with SOL, so those follow by trades
  const sol = (l: StatsLaunch) => l.quoteMint === WSOL || !!l.paired;
  const solVolume = (l: StatsLaunch) => BigInt((l.paired ? l.volumeSolLamports : l.volumeLamports) ?? "0");
  const rows = [...list].sort((a, b) => Number(sol(b)) - Number(sol(a)) || (sol(a) ? Number(solVolume(b) - solVolume(a)) : b.trades - a.trades));
  if (!rows.length) return <p className="text-sm mt-3">{C.none}</p>;
  return (
    <div className="table-scroll mt-3">
      <table className="stream-table fee-table">
        <thead><tr><th>{C.coin}</th><th>{C.by}</th><th>{C.stage}</th><th>{C.trades}</th><th>{C.volume}</th><th>{C.fees}</th><th>{C.locked}</th></tr></thead>
        <tbody>
          {rows.map((l) => {
            const fees = sum([l.fees.curveTradingLamports, l.fees.curveProtocolLamports, l.fees.poolLpLamports, l.fees.poolProtocolLamports]);
            return (
              <tr key={l.mint}>
                <td data-label={C.coin}><Link className="text-link" href={`/token/${l.mint}`}>{display(l)}</Link><p className="micro">{shownName(l.mint, l.name)}</p></td>
                <td data-label={C.by}>{l.team === null ? C.unknownOwner : l.team ? C.us : C.them}</td>
                <td data-label={C.stage}>{l.stage === "graduated" ? C.graduatedStage : l.stage === "completed" ? C.completed : C.bonding}</td>
                <td data-label={C.trades}><Out href={`${API_URL}/api/tokens/${l.mint}/trades?limit=100`}>{n(l.trades)}</Out></td>
                <td className="money" data-label={C.volume}>{l.paired ? <><Lamports v={l.volumeSolLamports ?? null} /><p className="micro">{C.pairedVolume}</p></> : <Lamports v={l.volumeLamports} quote={{ mint: l.quoteMint, decimals: l.quoteDecimals }} />}</td>
                <td className="money" data-label={C.fees}><Out href={EXPLORER("address", l.dbcPool)}><Lamports v={fees} quote={{ mint: l.quoteMint, decimals: l.quoteDecimals, sol: l.paired ? pairedSol : null }} /></Out>{l.dammPool ? <p className="micro"><Out href={EXPLORER("address", l.dammPool)}>{C.pool} ↗</Out></p> : null}</td>
                <td data-label={C.locked}>{l.dammPool ? <Out href={EXPLORER("address", l.dammPool)}>{pctBps(l.lockedBps)}</Out> : "—"}</td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}
