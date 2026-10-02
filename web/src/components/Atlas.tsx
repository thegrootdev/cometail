"use client";
import { useEffect, useId, useMemo, useRef, useState } from "react";
import Link from "next/link";
import { experience as copy } from "@/content/cometail";
import { SkyStream, api } from "@/lib/api";
import { useLoad } from "@/lib/hooks";
import { short, sol } from "@/lib/format";
import { Stat } from "./Shell";
import { DataState } from "./Experience";
export function hash(s: string) {
  let h = 2166136261;
  for (const c of s) {
    h ^= c.charCodeAt(0);
    h = Math.imul(h, 16777619);
  }
  return (h >>> 0) / 4294967295;
}
export async function loadSky() {
  const result = await api.sky();
  if (!result) throw new Error(copy.atlasError);
  return result;
}
export function CometAnatomy() {
  const id = useId().replace(/:/g, "");
  return (
    <div className="hero-art">
      <span className="art-label micro">{copy.anatomy} / 001</span>
      <svg
        viewBox="0 0 600 600"
        role="img"
        aria-label={`${copy.tokenHead}. ${copy.tokenHeadBody} ${copy.feeTail}. ${copy.feeTailBody}`}
      >
        <defs>
          <linearGradient id={`${id}tail`} x1="0" y1="1" x2="1" y2="0">
            <stop stopColor="#5BC8FF" stopOpacity="0" />
            <stop offset=".68" stopColor="#5BC8FF" stopOpacity=".4" />
            <stop offset="1" stopColor="#E8ECF4" />
          </linearGradient>
          <radialGradient id={`${id}glow`}>
            <stop stopColor="#c2e9ff" stopOpacity=".32" />
            <stop offset="1" stopColor="#5BC8FF" stopOpacity="0" />
          </radialGradient>
        </defs>
        <g stroke="#7b9bb82a" fill="none">
          <circle cx="310" cy="290" r="216" />
          <circle cx="310" cy="290" r="171" strokeDasharray="2 9" />
          <ellipse
            cx="300"
            cy="300"
            rx="276"
            ry="108"
            transform="rotate(-35 300 300)"
          />
          <path d="M25 300h545M310 20v540" strokeDasharray="2 10" />
        </g>
        <g className="orbit-drift">
          <circle cx="300" cy="84" r="3" fill="#7595b4" />
          <circle cx="101" cy="384" r="2" fill="#F5C451" />
        </g>
        {Array.from({ length: 45 }, (_, i) => (
          <circle
            key={i}
            cx={hash(`x${i}`) * 560 + 20}
            cy={hash(`y${i}`) * 500 + 50}
            r={i % 8 === 0 ? 1.4 : 0.6}
            fill="#9cafc6"
            opacity={0.2 + hash(`o${i}`) * 0.5}
          />
        ))}
        <g className="comet-breathe">
          <path
            d="M60 530Q178 348 383 218Q330 360 60 530"
            fill={`url(#${id}tail)`}
            opacity=".45"
          />
          <path
            d="M75 513L387 213M111 501L392 219M77 464L378 203M126 463L397 220"
            stroke={`url(#${id}tail)`}
            strokeWidth="2"
          />
          <path d="M136 459L382 220" stroke="#F5C451" strokeOpacity=".3" />
          <circle cx="387" cy="213" r="100" fill={`url(#${id}glow)`} />
          <circle cx="387" cy="213" r="14" fill="#e5f5ff" />
          <circle cx="387" cy="213" r="23" stroke="#9fe4ff80" fill="none" />
          <circle cx="387" cy="213" r="35" stroke="#5bc8ff25" fill="none" />
        </g>
        <g stroke="#8ca5bb66" fill="none">
          <path d="M422 213h80v-55h35" />
          <circle cx="422" cy="213" r="2" />
          <path d="M214 394h105v66h61" />
          <circle cx="214" cy="394" r="2" />
        </g>
        <g
          fill="#9baec4"
          fontSize="9"
          fontFamily="Plex,monospace"
          letterSpacing="1"
        >
          <text x="455" y="142">
            01 / {copy.tokenHead.toUpperCase()}
          </text>
          <text x="328" y="481">
            02 / {copy.feeTail.toUpperCase()}
          </text>
          <text x="57" y="100">
            RA 04h 32m
          </text>
          <text x="399" y="538">
            DEC +23° 18′
          </text>
        </g>
      </svg>
      <span className="art-caption">{copy.illustration}</span>
    </div>
  );
}
export function StarAtlas({
  streams,
  loading = false,
  error = false,
  onRetry,
}: {
  streams: SkyStream[];
  loading?: boolean;
  error?: boolean;
  onRetry?: () => void;
}) {
  const id = useId().replace(/:/g, "");
  const previous = useRef(new Map<string, bigint>());
  const [sparks, setSparks] = useState<string[]>([]);
  const [motion, setMotion] = useState(false);
  const [compact, setCompact] = useState(false);
  useEffect(() => {
    const query = matchMedia("(max-width: 760px)");
    const update = () => setCompact(query.matches);
    update();
    query.addEventListener("change", update);
    return () => query.removeEventListener("change", update);
  }, []);
  useEffect(() => {
    const q = matchMedia("(prefers-reduced-motion: reduce)");
    const update = () =>
      setMotion(!q.matches && document.visibilityState === "visible");
    update();
    q.addEventListener("change", update);
    document.addEventListener("visibilitychange", update);
    return () => {
      q.removeEventListener("change", update);
      document.removeEventListener("visibilitychange", update);
    };
  }, []);
  useEffect(() => {
    const changed: string[] = [];
    for (const s of streams) {
      const n = BigInt(s.tradingFeeLamports || "0");
      const before = previous.current.get(s.pool);
      if (before !== undefined && n > before) changed.push(s.pool);
      previous.current.set(s.pool, n);
    }
    setSparks(changed);
    const timer = setTimeout(() => setSparks([]), 1600);
    return () => clearTimeout(timer);
  }, [streams]);
  const comets = useMemo(() => {
    const top = Math.max(
      1,
      ...streams.map(
        (s) =>
          Number(s.realized30dLamports ?? s.realizedEstimateLamports) +
          Number(s.claimableLamports),
      ),
    );
    return streams.slice(0, compact ? 12 : 60).map((s) => {
      const income =
        Number(s.realized30dLamports ?? s.realizedEstimateLamports) +
        Number(s.claimableLamports);
      return {
        s,
        x:
          (compact ? 100 : 180) +
          hash("longitude:" + s.pool) * (compact ? 330 : 780),
        y: 70 + hash("latitude:" + s.pool) * 280,
        len:
          (compact ? 25 : 35) +
          ((compact ? 85 : 140) * Math.log1p(income)) / Math.log1p(top),
      };
    });
  }, [streams, compact]);
  const width = compact ? 540 : 1080;
  return (
    <div className="atlas-surface">
      <div className="atlas-toolbar">
        <span className="micro">{copy.atlas} / SOLANA</span>
        <span
          className={`live-status ${error ? "is-offline" : ""}`}
          title={
            streams.length
              ? `${copy.observed}: ${new Date(Math.max(...streams.map((s) => s.updatedAt))).toUTCString()}`
              : undefined
          }
        >
          <i />
          {loading ? copy.syncing : error ? copy.offline : copy.live}
        </span>
      </div>
      <svg
        className="atlas-svg"
        viewBox={`0 0 ${width} 420`}
        role="group"
        aria-label={copy.atlasNote}
      >
        <defs>
          <linearGradient
            id={`${id}trail`}
            gradientUnits="userSpaceOnUse"
            x1={compact ? -110 : -175}
            y1="0"
            x2="0"
            y2="0"
          >
            <stop stopColor="#5BC8FF" stopOpacity="0" />
            <stop offset="1" stopColor="#b7dff4" stopOpacity=".85" />
          </linearGradient>
        </defs>
        <g stroke="#7c97b012" fill="none">
          {Array.from({ length: 9 }, (_, i) => (
            <path key={i} d={`M${i * 135} 0v420`} />
          ))}
          {Array.from({ length: 5 }, (_, i) => (
            <path key={i} d={`M0 ${i * 105}h${width}`} />
          ))}
          <ellipse cx={width / 2} cy="210" rx={width * 0.44} ry="154" />
          <ellipse
            cx={width / 2}
            cy="210"
            rx={width / 3}
            ry="110"
            transform={`rotate(-18 ${width / 2} 210)`}
          />
        </g>
        {Array.from({ length: 90 }, (_, i) => (
          <circle
            key={i}
            cx={hash(`sx${i}`) * width}
            cy={hash(`sy${i}`) * 420}
            r={i % 11 === 0 ? 1.1 : 0.6}
            fill="#b9c8dc"
            opacity={0.13 + hash(`so${i}`) * 0.33}
          />
        ))}
        <g className="atlas-coordinates">
          <text x="20" y="25">
            00h
          </text>
          <text x={width / 2 - 10} y="25">
            12h
          </text>
          <text x={width - 48} y="25">
            24h
          </text>
          <text x="20" y="397">
            −60°
          </text>
          <text x={width - 56} y="397">
            +60°
          </text>
        </g>
        {comets.map(({ s, x, y, len }) => (
          <a
            key={s.pool}
            href={`/token/${s.baseMint}`}
            tabIndex={0}
            aria-label={`${copy.viewToken} ${short(s.baseMint)} · ${sol(s.claimableLamports)} ${copy.accrued}`}
          >
            <g transform={`translate(${x} ${y}) rotate(-24)`}>
              <circle
                className="comet-target"
                r={compact ? 35 : 24}
                fill="transparent"
              />
              <path
                d={`M${-len} 0L0 0`}
                stroke={`url(#${id}trail)`}
                strokeWidth="3"
                strokeLinecap="round"
              />
              <path
                d={`M${-len * 0.6} 3L0 0`}
                stroke={`url(#${id}trail)`}
                strokeOpacity=".15"
                strokeWidth="9"
              />
              <circle r="8" fill="#5bc8ff15" />
              <circle r="3" fill={s.eligible ? "#F5C451" : "#bed7e9"} />
              {motion && sparks.includes(s.pool) && (
                <circle
                  className="fee-spark"
                  r="2.5"
                  style={{ "--trail": `${-len}px` } as React.CSSProperties}
                />
              )}
            </g>
            <text
              x={x + 12}
              y={y + 22}
              fontFamily="Plex,monospace"
              fontSize={compact ? 13 : 10}
              fill="#92a7be"
            >
              {short(s.baseMint, 3)}
            </text>
            <text
              x={x + 12}
              y={y + (compact ? 40 : 37)}
              fontFamily="Plex,monospace"
              fontSize={compact ? 13 : 10}
              fill="#f5c451a0"
            >
              {sol(s.claimableLamports, 3)}
            </text>
          </a>
        ))}
      </svg>
      {(loading || error || streams.length === 0) && (
        <div className="atlas-empty-overlay">
          <DataState
            compact
            kind={loading ? "loading" : error ? "error" : "empty"}
            title={
              loading ? undefined : error ? copy.atlasError : copy.atlasEmpty
            }
            body={
              loading
                ? undefined
                : error
                  ? copy.atlasErrorBody
                  : copy.atlasEmptyBody
            }
            onRetry={error ? onRetry : undefined}
          />
        </div>
      )}
      <div className="atlas-legend">
        <span>
          <i className="legend-line" />
          {copy.accrued}
        </span>
        <span title={copy.chartLimit}>
          <i className="legend-line blue" />
          {copy.tailScale}
        </span>
        <span>{copy.activity}</span>
      </div>
    </div>
  );
}
export function AtlasStats({ streams }: { streams: SkyStream[] }) {
  const amount = (field: "claimableLamports" | "realized30dLamports") =>
    streams.reduce((n, s) => n + BigInt(s[field] ?? "0"), 0n);
  return (
    <div className="atlas-stats">
      <Stat label={copy.known} value={String(streams.length)} tone="plain" />
      <Stat
        label={copy.accrued}
        value={sol(amount("claimableLamports"))}
        tone="dust"
      />
      <Stat
        label={copy.harvested}
        value={
          streams.some((s) => s.realized30dLamports !== null)
            ? sol(amount("realized30dLamports"))
            : "—"
        }
        tone="plain"
      />
    </div>
  );
}
export function HomeAtlas() {
  const { data, loading, error, reload } = useLoad(loadSky, [], 30000);
  return (
    <>
      <div className="atlas-divider">
        <h2>{copy.observatory}</h2>
        <Link href="/sky" className="text-link">
          {copy.explore} ↗
        </Link>
      </div>
      <StarAtlas
        streams={data?.streams ?? []}
        loading={loading}
        error={!!error}
        onRetry={reload}
      />
      {data && <AtlasStats streams={data.streams} />}
    </>
  );
}
