"use client";
// The Sky: every fee stream drawn as a comet. Tail length is income; gold is claimable now,
// blue is realized. Eligible streams carry the "Sell this tail" door.
import Link from "next/link";
import { useMemo } from "react";
import { Shell, Card } from "@/components/Shell";
import { sky as copy } from "@/content/cometail";
import { api, SkyStream } from "@/lib/api";
import { useLoad } from "@/lib/hooks";
import { short, sol } from "@/lib/format";

function hash(s: string): number { let h = 2166136261; for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619); } return (h >>> 0) / 4294967295; }
const PROGRESS = ["bonding", "curve complete", "locked vesting", "graduated"];

export default function SkyPage() {
  const { data, loading } = useLoad(() => api.sky(), []);
  const streams = useMemo(() => data?.streams ?? [], [data]);
  const comets = useMemo(() => {
    const max = Math.max(1, ...streams.map((s) => Number(s.claimableLamports) + Number(s.realizedLamports)));
    return streams.map((s) => {
      const income = Number(s.claimableLamports) + Number(s.realizedLamports);
      const len = 20 + 200 * Math.log1p(income) / Math.log1p(max);
      const claimableShare = income > 0 ? Number(s.claimableLamports) / income : 0;
      return { s, x: 60 + hash(s.pool) * 880, y: 40 + hash(s.creator + s.pool) * 420, len, claimableShare };
    });
  }, [streams]);
  return (
    <Shell wide>
      <h1 className="text-4xl font-extrabold">{copy.title}</h1>
      <p className="mt-2 max-w-2xl text-starlight/70">{copy.body}</p>
      <Card className="mt-6 overflow-hidden p-0">
        <svg viewBox="0 0 1000 500" className="h-[420px] w-full" role="img" aria-label="star map of fee streams">
          <rect width="1000" height="500" fill="#06070B" />
          {Array.from({ length: 120 }, (_, i) => <circle key={i} cx={hash(`s${i}`) * 1000} cy={hash(`t${i}`) * 500} r={0.6 + hash(`r${i}`) * 1.2} fill="#E8ECF4" opacity={0.25 + hash(`o${i}`) * 0.5} />)}
          {comets.map(({ s, x, y, len, claimableShare }) => (
            <g key={s.pool} transform={`translate(${x} ${y}) rotate(-25)`}>
              <line x1={0} y1={0} x2={-len} y2={0} stroke="#5BC8FF" strokeWidth={3} strokeLinecap="round" opacity={0.55} />
              <line x1={0} y1={0} x2={-len * claimableShare} y2={0} stroke="#F5C451" strokeWidth={3} strokeLinecap="round" opacity={0.9} />
              <circle r={4.5} fill={s.eligible ? "#F5C451" : "#E8ECF4"} />
              <title>{`${short(s.baseMint)} · ${sol(s.claimableLamports)} claimable · ${sol(s.realizedLamports)} realized`}</title>
            </g>
          ))}
        </svg>
        <div className="flex gap-6 px-5 py-3 text-xs text-starlight/60">
          <span><span className="mr-1 inline-block h-2 w-5 rounded bg-dust" />{copy.legend.claimable}</span>
          <span><span className="mr-1 inline-block h-2 w-5 rounded bg-ion/60" />{copy.legend.realized}</span>
          <span><span className="mr-1 inline-block h-2 w-2 rounded-full bg-dust" />eligible for a vault</span>
        </div>
      </Card>
      <Card title="Streams" className="mt-6">
        {loading && <p className="text-starlight/60">Scanning…</p>}
        {!loading && streams.length === 0 && <p className="text-starlight/60">No streams scanned yet.</p>}
        {streams.length > 0 && (
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead className="text-left text-xs uppercase tracking-wider text-starlight/50">
                <tr><th className="py-2">Token</th><th>Stage</th><th>Creator rights</th><th className="text-right">Claimable</th><th className="text-right">Realized</th><th>Eligible</th><th></th></tr>
              </thead>
              <tbody>
                {streams.map((s: SkyStream) => (
                  <tr key={s.pool} className="border-t border-starlight/10">
                    <td className="py-2"><Link href={`/token/${s.baseMint}`} className="text-ion">{short(s.baseMint)}</Link></td>
                    <td>{PROGRESS[s.progress] ?? s.progress}</td>
                    <td>{s.custody === "wallet" ? "wallet" : s.custody === "program" ? "program-held" : "unknown"} · {s.creatorPct}% locked</td>
                    <td className="text-right text-dust">{sol(s.claimableLamports)}</td>
                    <td className="text-right">{sol(s.realizedLamports)}</td>
                    <td>{s.eligible ? "yes" : <span title={s.reasons.join("; ")} className="text-starlight/50">no</span>}</td>
                    <td className="text-right">{s.eligible && s.custody === "wallet" && <Link href={`/sell?pool=${s.pool}`} className="rounded-full border border-dust px-3 py-1 text-xs text-dust">Sell this tail</Link>}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Card>
    </Shell>
  );
}
