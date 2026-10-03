"use client";
import { useId } from "react";
import { identity as copy } from "@/content/cometail";
import {
  cleanLinks,
  socialKinds,
  socialUrl,
  type SocialKind,
  type TokenLinks,
} from "@/lib/token-display";
function SocialIcon({ kind }: { kind: SocialKind }) {
  return (
    <svg
      viewBox="0 0 24 24"
      width="16"
      height="16"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.7"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      {kind === "x" ? (
        <>
          <path d="m5 4 14 16M19 4 5 20" />
        </>
      ) : kind === "telegram" ? (
        <>
          <path d="m3 10 18-7-5 18-5-7-8-4Z" />
          <path d="m11 14 10-11" />
        </>
      ) : kind === "discord" ? (
        <>
          <path d="M8 6 5 7l-2 10 5 2 1-2m6 0 1 2 5-2-2-10-3-1M8 7c3-1 5-1 8 0M7 16c3 2 7 2 10 0" />
          <circle cx="9" cy="12" r="1" />
          <circle cx="15" cy="12" r="1" />
        </>
      ) : (
        <>
          <circle cx="12" cy="12" r="9" />
          <ellipse cx="12" cy="12" rx="4" ry="9" />
          <path d="M3 12h18" />
        </>
      )}
    </svg>
  );
}
export function SocialLinks({
  links,
  tokenName,
}: {
  links?: TokenLinks | null;
  tokenName?: string | null;
}) {
  const safe = cleanLinks(links);
  if (!Object.keys(safe).length) return null;
  return (
    <div className="social-pills" aria-label={copy.linksLabel}>
      {socialKinds.map(
        (kind) =>
          safe[kind] && (
            <a
              key={kind}
              href={safe[kind]}
              target="_blank"
              rel="noopener noreferrer"
              aria-label={`${tokenName || copy.token}: ${copy.social[kind].label} ${copy.newTab}`}
            >
              <SocialIcon kind={kind} />
              <span>{copy.social[kind].label}</span>
            </a>
          ),
      )}
    </div>
  );
}
export function SocialFields({
  value,
  onChange,
}: {
  value: TokenLinks;
  onChange: (links: TokenLinks) => void;
}) {
  const id = useId();
  return (
    <div className="social-fields" role="group" aria-labelledby={`${id}-title`}>
      <div className="social-fields-heading">
        <h3 id={`${id}-title`}>{copy.socialTitle}</h3>
        <span>{copy.optional}</span>
      </div>
      <p className="caption">{copy.socialHint}</p>
      <div className="social-fields-grid">
        {socialKinds.map((kind) => {
          const invalid =
            !!value[kind]?.trim() && !socialUrl(kind, value[kind]);
          return (
            <label className="field" key={kind} htmlFor={`${id}-${kind}`}>
              <span id={`${id}-${kind}-label`}>
                <SocialIcon kind={kind} />
                {copy.social[kind].label}
              </span>
              <input
                id={`${id}-${kind}`}
                type="url"
                inputMode="url"
                autoComplete="off"
                autoCapitalize="none"
                spellCheck={false}
                maxLength={200}
                value={value[kind] || ""}
                placeholder={copy.social[kind].placeholder}
                onChange={(event) =>
                  onChange({ ...value, [kind]: event.target.value })
                }
                aria-labelledby={`${id}-${kind}-label`}
                aria-invalid={invalid}
                aria-describedby={invalid ? `${id}-${kind}-error` : undefined}
              />
              {invalid && (
                <small
                  id={`${id}-${kind}-error`}
                  className="field-error"
                  role="status"
                >
                  {copy.social[kind].invalid}
                </small>
              )}
            </label>
          );
        })}
      </div>
    </div>
  );
}
