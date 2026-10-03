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
import { experience as copy, sky, wizard } from "@/content/cometail";
import { useLoad } from "@/lib/hooks";
export default function SkyPage() {
  const { data, loading, error, reload } = useLoad(loadSky, [], 30000);
  const [query, setQuery] = useState(""),
    [eligible, setEligible] = useState(false);
  const streams = useMemo(() => data?.streams ?? [], [data]);
  const shown = streams.filter(
    (s) =>
      (!eligible || s.eligible) &&
      [s.pool, s.baseMint, s.creator, s.token?.name || "", s.token?.symbol || ""].some((x) =>
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
                  <td data-label={copy.source}>
                    <Link className="token-cell" href={`/token/${s.baseMint}`}>
                      <TokenHeading token={s.token} mint={s.baseMint} />
                    </Link>
                    <p className="source-kind">{s.kind === "position" ? identity.positionFees : identity.creatorFees}</p>
                    <CopyAddress address={s.baseMint} />
                    <SocialLinks links={s.token?.links} tokenName={s.token?.name} />
                  </td>
                  <td data-label={copy.stage}>
                    <Badge tone={s.progress === 3 ? "gold" : "ion"}>
                      {wizard.stages[s.progress] ?? s.progress}
                    </Badge>
                  </td>
                  <td className="money" data-label={copy.accrued}><Money quote={quoteAsset(s.quoteMint)} lamports={s.claimableLamports} /></td>
                  <td data-label={copy.harvested}>
                    {s.realized30dLamports === null
                      ? "—"
                      : <Money quote={quoteAsset(s.quoteMint)} lamports={s.realized30dLamports} />}
                  </td>
                  <td data-label={copy.eligibility}>
                    <SourceStatus stream={s} />
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
