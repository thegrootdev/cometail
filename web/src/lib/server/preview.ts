// Link previews: which coin images a token page may name as its preview image.

/** An image URL from our own media origin, as uploads name them; null for anything else. */
export function ownLogo(url: unknown, mediaOrigin = process.env.COMETAIL_MEDIA_ORIGIN): string | null {
  if (typeof url !== "string" || !mediaOrigin) return null;
  try {
    const u = new URL(url), origin = new URL(mediaOrigin);
    return u.protocol === "https:" && u.origin === origin.origin && /^\/[a-f0-9]{64}\.webp$/.test(u.pathname) && !u.search && !u.hash && !u.username && !u.password ? u.href : null;
  } catch { return null; }
}
