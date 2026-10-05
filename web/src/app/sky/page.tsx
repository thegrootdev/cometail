"use client";
import { CopyAddress } from "@/components/CopyAddress";
import { quoteAsset } from "@/lib/quotes";
import { Money } from "@/components/Money";
import { TokenHeading } from "@/components/TokenHeading";
import { SocialLinks } from "@/components/SocialLinks";
import { SourceStatus } from "@/components/SourceStatus";
import { identity } from "@/content/cometail";
import Link from "next/link";
import { useMemo, useState } from "react";
import { Shell } from "@/components/Shell";
import { StarAtlas, AtlasStats, loadSky } from "@/components/Atlas";
import {
  PageHeader,
  DataState,
  Badge,
} from "@/components/Experience";
import { experience as copy, sky, wizard, market } from "@/content/cometail";
import { isListed, isOfficial } from "@/lib/addresses";
import { useLoad } from "@/lib/hooks";
import type { SkyStream } from "@/lib/api";
export default function SkyPage() {
  const { data, loading, error, reload } = useLoad(loadSky, [], 30000);
  const [query, setQuery] = useState(""),
    [eligible, setEligible] = useState(false);
  const streams = useMemo(() => (data?.streams ?? []).filter((s) => isListed(s.baseMint)), [data]);
  const shown = streams.filter(
    (s) =>
      (!eligible || s.eligible) &&
      [s.pool, s.baseMint, s.creator, s.token?.name || "", s.token?.symbol || ""].some((x) =>
        x.toLowerCase().includes(query.trim().toLowerCase()),
      ),
  );
  // one entry per coin: its curve row leads, its locked-liquidity positions follow as fee sources
  const coins = useMemo(() => {
    const byMint = new Map<string, SkyStream[]>();
    for (const s of shown) byMint.set(s.baseMint, [...(byMint.get(s.baseMint) ?? []), s]);
    const official = (rows: SkyStream[]) => rows.some((r) => isOfficial(r.baseMint));
    return [...byMint.values()].sort((a, b) => Number(official(b)) - Number(official(a))).map((rows) => {
      const sorted = rows.slice().sort((a, b) => Number(a.kind === "position") - Number(b.kind === "position") || (b.lockedSharePct ?? 0) - (a.lockedSharePct ?? 0));
      const lead = sorted[0];
      const sum = (pick: (s: SkyStream) => string | null) => { let any = false, t = 0n; for (const s of sorted) { const v = pick(s); if (v === null) continue; any = true; t += BigInt(v); } return any ? t.toString() : null; };
      return { lead, sources: sorted, claimable: sum((s) => s.claimableLamports) ?? "0", realized30d: sum((s) => s.realized30dLamports) };
    });
  }, [shown]);
  return (
    <Shell wide>
      <PageHeader
        eyebrow={copy.observatory}
        title={sky.title}
        body={copy.atlasNote}
      >
        <Badge tone="ion">SOLANA / METEORA</Badge>
      </PageHeader>
      <StarAtlas
        streams={coins.map((c) => c.lead)}
        loading={loading}
        error={!!error}
        onRetry={reload}
      />
      {data && <AtlasStats streams={streams} />}
      <div className="catalogue-header">
        <h2>{copy.list}</h2>
        <span className="micro">
          {coins.length} / {new Set(streams.map((s) => s.baseMint)).size}
        </span>
      </div>
      <div className="atlas-search">
        <input
          aria-label={identity.search}
          type="search"
          placeholder={identity.search}
          value={query}
          onChange={(e) => setQuery(e.target.value)}
        />
        <label>
          <input
            type="checkbox"
            checked={eligible}
            onChange={(e) => setEligible(e.target.checked)}
          />
          {copy.eligible}
        </label>
      </div>
      {coins.length > 0 ? (
        <div className="table-scroll">
          <table className="stream-table">
            <thead>
              <tr>
                <th>{copy.source}</th>
                <th>{copy.stage}</th>
                <th>{copy.accrued}</th>
                <th>{copy.harvested}</th>
                <th>{copy.eligibility}</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {coins.map(({ lead: s, sources, claimable, realized30d }) => (
                <tr key={s.baseMint}>
                  <td data-label={copy.source}>
                    <Link className="token-cell" href={`/token/${s.baseMint}`}>
                      <TokenHeading token={s.token} mint={s.baseMint} />
                    </Link>
                    {isOfficial(s.baseMint) && <span className="official-badge">{market.official}</span>}
                    <p className="source-kind">{sources.length > 1 ? identity.sourcesOf(sources.length) : s.kind === "position" ? identity.positionFees : identity.creatorFees}</p>
                    <CopyAddress address={s.baseMint} />
                    <SocialLinks links={s.token?.links} tokenName={s.token?.name} />
                  </td>
                  <td data-label={copy.stage}>
                    <Badge tone={s.progress === 3 ? "gold" : "ion"}>
                      {wizard.stages[s.progress] ?? s.progress}
                    </Badge>
                  </td>
                  <td className="money" data-label={copy.accrued}><Money quote={quoteAsset(s.quoteMint)} lamports={claimable} /></td>
                  <td data-label={copy.harvested}>
                    {realized30d === null
                      ? "—"
                      : <Money quote={quoteAsset(s.quoteMint)} lamports={realized30d} />}
                  </td>
                  <td data-label={copy.eligibility}>
                    <ul className="source-list">
                      {sources.map((row) => (
                        <li key={row.pool}>
                          <span className="source-kind">{row.kind === "position" ? identity.lockedShare(String(row.lockedSharePct ?? 0)) : identity.creatorFees}</span>
                          <SourceStatus stream={row} />
                        </li>
                      ))}
                    </ul>
                  </td>
                  <td>
                    <Link
                      className="text-link"
                      href={`/token/${s.baseMint}`}
                      aria-label={`${copy.viewToken} ${s.baseMint}`}
                    >
                      {identity.viewToken} ↗
                    </Link>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : !loading && !error && streams.length > 0 ? (
        <DataState title={copy.noResults} body={copy.noResultsBody}>
          <button
            className="button button-secondary"
            onClick={() => {
              setQuery("");
              setEligible(false);
            }}
          >
            {copy.clear}
          </button>
        </DataState>
      ) : null}
    </Shell>
  );
}
