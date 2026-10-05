export type TokenLinks = {
  x?: string;
  telegram?: string;
  discord?: string;
  website?: string;
};
export type TokenIdentity = {
  mint: string;
  name?: string | null;
  symbol?: string | null;
  imageUrl?: string | null;
  stage?: string | null;
  links?: TokenLinks | null;
};
export const socialKinds = ["x", "telegram", "website", "discord"] as const;
export type SocialKind = (typeof socialKinds)[number];
const hosts: Record<SocialKind, readonly string[] | null> = {
  x: ["x.com", "twitter.com"],
  telegram: ["t.me"],
  discord: ["discord.gg", "discord.com"],
  website: null,
};
/** Match the upload contract; never turn untrusted metadata into arbitrary links. */
export function socialUrl(kind: SocialKind, raw: unknown): string | null {
  if (typeof raw !== "string" || !raw.trim() || raw.trim().length > 200)
    return null;
  try {
    const url = new URL(raw.trim());
    if (
      url.protocol !== "https:" ||
      url.username ||
      url.password ||
      url.href.length > 200
    )
      return null;
    const host = url.hostname.toLowerCase().replace(/^www\./, "");
    if (hosts[kind] && !hosts[kind]!.includes(host)) return null;
    return url.href;
  } catch {
    return null;
  }
}
export function cleanLinks(raw?: TokenLinks | null): TokenLinks {
  const result: TokenLinks = {};
  for (const kind of socialKinds) {
    const url = socialUrl(kind, raw?.[kind]);
    if (url) result[kind] = url;
  }
  return result;
}
export function linksValid(raw: TokenLinks): boolean {
  return socialKinds.every(
    (kind) => !raw[kind]?.trim() || !!socialUrl(kind, raw[kind]),
  );
}
/** A token page can read metadata before the indexer's next pass. */
export function metadataLinks(raw: unknown): TokenLinks {
  if (!raw || typeof raw !== "object") return {};
  const data = raw as Record<string, unknown>;
  const extensions =
    data.extensions && typeof data.extensions === "object"
      ? (data.extensions as Record<string, unknown>)
      : {};
  return cleanLinks({
    x: extensions.twitter as string,
    telegram: extensions.telegram as string,
    discord: extensions.discord as string,
    website: (extensions.website || data.external_url) as string,
  });
}
export function tokenForMint(
  token: TokenIdentity | null | undefined,
  mint: string,
): TokenIdentity | null {
  return token?.mint === mint ? token : null;
}

/** A stored symbol without the dollar sign some creators type in front of it, for display. */
export function bareSymbol(raw: string | null | undefined): string {
  return (raw ?? "").replace(/^[\s$]+/, "").trim();
}
/** The ticker as pages show it: exactly one dollar sign, or empty when there is no symbol. */
export function tickerText(raw: string | null | undefined): string {
  const s = bareSymbol(raw);
  return s ? `$${s}` : "";
}
/** A typed symbol as it will be stored: no leading dollar signs, no whitespace, upper case. */
export function cleanSymbolInput(raw: string): string {
  return raw.replace(/^[\s$]+/, "").replace(/\s+/g, "").toUpperCase();
}
