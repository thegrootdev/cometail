// Pure checks used by the upload route (a route module may export handlers only).

/** The dimensions and animation flag of a WebP from its header (RIFF container; VP8, VP8L or VP8X). */
export function webpInfo(b: Buffer): { width: number; height: number; animated: boolean } | null {
  if (b.length < 30 || b.toString("ascii", 0, 4) !== "RIFF" || b.toString("ascii", 8, 12) !== "WEBP") return null;
  const chunk = b.toString("ascii", 12, 16);
  if (chunk === "VP8 ") return { width: b.readUInt16LE(26) & 0x3fff, height: b.readUInt16LE(28) & 0x3fff, animated: false };
  if (chunk === "VP8L") { const b0 = b[21], b1 = b[22], b2 = b[23], b3 = b[24]; return { width: 1 + (b0 | ((b1 & 0x3f) << 8)), height: 1 + ((b1 >> 6) | (b2 << 2) | ((b3 & 0x0f) << 10)), animated: false }; }
  if (chunk === "VP8X") return { width: 1 + b.readUIntLE(24, 3), height: 1 + b.readUIntLE(27, 3), animated: (b[20] & 0x02) !== 0 };
  return null;
}
/** Optional socials: https, a known host per kind (any host for the website), at most 200 characters; empty is allowed. */
export function validateLinks(raw: unknown): { ok: true; links: { x?: string; telegram?: string; discord?: string; website?: string } } | { ok: false; field: string } {
  const out: { x?: string; telegram?: string; discord?: string; website?: string } = {};
  if (raw === undefined || raw === null) return { ok: true, links: out };
  if (typeof raw !== "object") return { ok: false, field: "links" };
  const hosts: Record<string, RegExp | null> = { x: /^(www\.)?(x\.com|twitter\.com)$/, telegram: /^(www\.)?t\.me$/, discord: /^(www\.)?(discord\.gg|discord\.com)$/, website: null };
  for (const key of Object.keys(hosts) as (keyof typeof out)[]) {
    const v = (raw as any)[key];
    if (v === undefined || v === null || v === "") continue;
    if (typeof v !== "string" || v.length > 200) return { ok: false, field: key };
    let u: URL; try { u = new URL(v); } catch { return { ok: false, field: key }; }
    if (u.protocol !== "https:") return { ok: false, field: key };
    const host = hosts[key]; if (host && !host.test(u.hostname.toLowerCase())) return { ok: false, field: key };
    out[key] = u.toString();
  }
  return { ok: true, links: out };
}

