"use client";
import Link from "next/link";
import { useEffect, useState } from "react";
import { experience as copy } from "@/content/cometail";
export function PageHeader({
  eyebrow,
  title,
  body,
  children,
  art,
}: {
  eyebrow: string;
  title: string;
  body?: string;
  children?: React.ReactNode;
  /** The mascot pose shown beside the heading (illustrations in /art). */
  art?: "mascot" | "launch" | "sell";
}) {
  return (
    <div className="page-heading">
      {art && (
        <img
          className="page-mascot"
          src={`/art/${art === "mascot" ? "mascot" : `mascot-${art}`}.png`}
          alt=""
          width="200"
          height="200"
        />
      )}
      <div>
        <div className="eyebrow">
          <span />
          {eyebrow}
        </div>
        <h1>{title}</h1>
        {body && <p>{body}</p>}
      </div>
      {children && <div className="page-heading-side">{children}</div>}
    </div>
  );
}
export function DataState({
  kind = "empty",
  title,
  body,
  onRetry,
  children,
  compact = false,
}: {
  kind?: "loading" | "empty" | "error" | "wallet";
  title?: string;
  body?: string;
  onRetry?: () => void;
  children?: React.ReactNode;
  compact?: boolean;
}) {
  return (
    <div
      className={`data-state ${compact ? "state-compact" : ""} state-${kind}`}
      role={kind === "error" ? "alert" : "status"}
      aria-live="polite"
    >
      <img
        className="state-mascot"
        src="/art/mascot.png"
        alt=""
        width="96"
        height="96"
      />
      <svg
        className="state-orbit"
        viewBox="0 0 160 100"
        fill="none"
        aria-hidden="true"
      >
        <ellipse
          cx="80"
          cy="50"
          rx="64"
          ry="25"
          transform="rotate(-24 80 50)"
        />
        <ellipse
          cx="80"
          cy="50"
          rx="42"
          ry="17"
          transform="rotate(-24 80 50)"
        />
        <path d="M80 40v20M70 50h20" />
        <circle cx="125" cy="30" r="4" />
        <circle cx="45" cy="75" r="2" />
      </svg>
      <h3>
        {title ??
          (kind === "loading"
            ? copy.loading
            : kind === "error"
              ? copy.failed
              : copy.empty)}
      </h3>
      <p>
        {body ??
          (kind === "loading"
            ? copy.loadingBody
            : kind === "error"
              ? copy.failedBody
              : copy.atlasEmptyBody)}
      </p>
      {kind === "loading" && (
        <div className="loading-track">
          <span />
        </div>
      )}
      {onRetry && (
        <button className="button button-secondary" onClick={onRetry}>
          {copy.reconnect} <span aria-hidden="true">↻</span>
        </button>
      )}
      {children}
    </div>
  );
}
export function TokenAvatar({
  seed,
  image,
  size = "normal",
}: {
  seed: string;
  image?: string;
  size?: "normal" | "large";
}) {
  const [failed, setFailed] = useState(false);
  useEffect(() => setFailed(false), [image]);
  let n = 0;
  for (const c of seed) n = (n * 31 + c.charCodeAt(0)) >>> 0;
  return (
    <span
      className={`token-avatar avatar-${size}`}
      style={{ "--avatar-angle": `${n % 360}deg` } as React.CSSProperties}
    >
      {image && !failed ? (
        <img
          src={image}
          alt=""
          loading="lazy"
          referrerPolicy="no-referrer"
          onError={() => setFailed(true)}
        />
      ) : (
        <svg viewBox="0 0 40 40" aria-hidden="true">
          <path d="M7 30L25 13M12 32L28 16M8 23L22 9" />
          <circle cx="27" cy="12" r="5" />
        </svg>
      )}
    </span>
  );
}
export function Badge({
  children,
  tone = "neutral",
}: {
  children: React.ReactNode;
  tone?: "neutral" | "ion" | "gold";
}) {
  return <span className={`badge badge-${tone}`}>{children}</span>;
}
export function BackToSky() {
  return (
    <Link href="/sky" className="text-link">
      ← {copy.back}
    </Link>
  );
}
