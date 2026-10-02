"use client";
import Link from "next/link";
import { useMemo, useState } from "react";
import { Shell } from "@/components/Shell";
import { StarAtlas, AtlasStats, loadSky } from "@/components/Atlas";
import {
  PageHeader,
  DataState,
  TokenAvatar,
  Badge,
} from "@/components/Experience";
import { experience as copy, sky, wizard } from "@/content/cometail";
import { useLoad } from "@/lib/hooks";
import { short, sol } from "@/lib/format";
export default function SkyPage() {
  const { data, loading, error, reload } = useLoad(loadSky, [], 30000);
  const [query, setQuery] = useState(""),
    [eligible, setEligible] = useState(false);
  const streams = useMemo(() => data?.streams ?? [], [data]);
  const shown = streams.filter(
    (s) =>
      (!eligible || s.eligible) &&
      [s.pool, s.baseMint, s.creator].some((x) =>
        x.toLowerCase().includes(query.trim().toLowerCase()),
      ),
  );
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
        streams={shown}
        loading={loading}
        error={!!error}
        onRetry={reload}
      />
      {data && <AtlasStats streams={streams} />}
      <div className="catalogue-header">
        <h2>{copy.list}</h2>
        <span className="micro">
          {shown.length} / {streams.length}
        </span>
      </div>
      <div className="atlas-search">
        <input
          aria-label={copy.search}
          type="search"
          placeholder={copy.search}
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
      {shown.length > 0 ? (
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
              {shown.map((s) => (
                <tr key={s.pool}>
                  <td>
                    <Link className="token-cell" href={`/token/${s.baseMint}`}>
                      <TokenAvatar seed={s.baseMint} />
                      <span>
                        <strong>{short(s.baseMint, 5)}</strong>
                        <small>
                          {s.custody} / {s.creatorPct}% locked
                        </small>
                      </span>
                    </Link>
                  </td>
                  <td>
                    <Badge tone={s.progress === 3 ? "gold" : "ion"}>
                      {wizard.stages[s.progress] ?? s.progress}
                    </Badge>
                  </td>
                  <td className="money">{sol(s.claimableLamports)}</td>
                  <td>
                    {s.realized30dLamports === null
                      ? "—"
                      : sol(s.realized30dLamports)}
                  </td>
                  <td>
                    {s.eligible ? (
                      <Badge tone="gold">{copy.eligible}</Badge>
                    ) : (
                      <span className="muted" title={s.reasons.join("; ")}>
                        {s.reasons[0] ?? "—"}
                      </span>
                    )}
                  </td>
                  <td>
                    <Link
                      className="text-link"
                      href={`/token/${s.baseMint}`}
                      aria-label={`${copy.viewToken} ${s.baseMint}`}
                    >
                      ↗
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
