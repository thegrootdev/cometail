// Untrusted on-chain metadata may name any URL. Resolve only public addresses, pin
// that resolution to the socket, and bound redirects, bytes and total elapsed time.
import http from "http";
import https from "https";
import { lookup } from "dns/promises";
import { isIP } from "net";

export const METADATA_MAX_BYTES = 256 * 1024;
export function publicAddress(address: string): boolean {
  if (isIP(address) === 4) {
    const [a, b, c] = address.split(".").map(Number);
    return !(a === 0 || a === 10 || a === 127 || a >= 224 ||
      (a === 100 && b >= 64 && b <= 127) || (a === 169 && b === 254) ||
      (a === 172 && b >= 16 && b <= 31) || (a === 192 && (b === 0 || b === 168 || (b === 88 && c === 99))) ||
      (a === 198 && (b === 18 || b === 19 || (b === 51 && c === 100))) || (a === 203 && b === 0 && c === 113));
  }
  if (isIP(address) !== 6) return false;
  const [first, second = "0"] = address.toLowerCase().split(":");
  const a = parseInt(first, 16), b = parseInt(second || "0", 16);
  // Global unicast only; exclude special-purpose, documentation and transition ranges.
  return a >= 0x2000 && a <= 0x3fff && a !== 0x2002 && a !== 0x3fff &&
    !(a === 0x2001 && (b < 0x200 || b === 0xdb8));
}

async function readUrl(url: URL, signal: AbortSignal): Promise<{ body?: Buffer; redirect?: string }> {
  if (!["https:", "http:"].includes(url.protocol) || url.username || url.password ||
      (url.port && url.port !== "80" && url.port !== "443")) throw new Error("unsupported metadata URL");
  const host = url.hostname.replace(/^\[|\]$/g, "");
  const resolved = isIP(host) ? [{ address: host, family: isIP(host) }] : await lookup(host, { all: true, verbatim: true });
  signal.throwIfAborted();
  if (!resolved.length || resolved.some((r) => !publicAddress(r.address))) throw new Error("non-public metadata destination");
  const selected = resolved[0];
  return new Promise((resolve, reject) => {
    const req = (url.protocol === "https:" ? https : http).get(url, {
      signal, agent: false, headers: { accept: "application/json", "accept-encoding": "identity" },
      // This socket cannot perform a second DNS lookup after validation.
      lookup: ((_host: string, options: any, cb: any) => options?.all
        ? cb(null, [selected]) : cb(null, selected.address, selected.family)) as any,
    }, (res) => {
      const status = res.statusCode ?? 0;
      if ([301, 302, 303, 307, 308].includes(status) && res.headers.location) {
        const redirect = res.headers.location; res.destroy(); resolve({ redirect }); return;
      }
      if (status !== 200 || (res.headers["content-encoding"] && res.headers["content-encoding"] !== "identity") ||
          Number(res.headers["content-length"] ?? 0) > METADATA_MAX_BYTES) {
        res.destroy(); reject(new Error("metadata response rejected")); return;
      }
      let size = 0; const chunks: Buffer[] = [];
      res.on("data", (chunk: Buffer) => {
        size += chunk.length;
        if (size > METADATA_MAX_BYTES) { res.destroy(); reject(new Error("metadata too large")); return; }
        chunks.push(chunk);
      });
      res.on("end", () => resolve({ body: Buffer.concat(chunks) }));
      res.on("error", reject);
      res.on("aborted", () => reject(new Error("metadata response interrupted")));
    });
    req.on("error", reject);
  });
}

export async function fetchMetadataJson(uri: string, timeoutMs = 6000): Promise<unknown> {
  if (uri.length > 2048) throw new Error("metadata URL too long");
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout>;
  const deadline = new Promise<never>((_, reject) => { timer = setTimeout(() => {
    controller.abort(); reject(new Error("metadata timeout"));
  }, timeoutMs); });
  try {
    return await Promise.race([deadline, (async () => {
      let url = new URL(uri);
      for (let hop = 0; hop <= 3; hop++) {
        const response = await readUrl(url, controller.signal);
        if (response.redirect) { url = new URL(response.redirect, url); continue; }
        return JSON.parse(response.body!.toString("utf8"));
      }
      throw new Error("too many metadata redirects");
    })()]);
  } finally { clearTimeout(timer!); controller.abort(); }
}

// IPFS. Coins name their files on IPFS gateways, and the public ipfs.io family stopped serving them
// (429, sunset 2026-09-21); dedicated *.mypinata.cloud gateways refuse outside readers. A file on IPFS
// is read through the gateways below instead, and a logo on IPFS is stored under the first one that
// actually serves it as an image.
const DEAD_IPFS_HOSTS = /^(ipfs\.io|gateway\.ipfs\.io|dweb\.link|w3s\.link|nftstorage\.link|cloudflare-ipfs\.com|cf-ipfs\.com)$/i;
/** A host of the stopped ipfs.io family, path-style (dweb.link) or subdomain-style (<cid>.ipfs.dweb.link). */
export function deadIpfsHost(hostname: string): boolean {
  return DEAD_IPFS_HOSTS.test(hostname) || DEAD_IPFS_HOSTS.test(hostname.replace(/^[a-z0-9]+\.ipfs\./i, ""));
}
export const IPFS_GATEWAYS = ["https://ipfs.filebase.io/ipfs/", "https://ipfs.orbitor.dev/ipfs/", "https://gateway.pinata.cloud/ipfs/"];
const CID = /^(Qm[1-9A-HJ-NP-Za-km-z]{44}|b[a-z2-7]{20,})$/;
/** "<cid>[/path]" when the address names an IPFS file (ipfs://, a /ipfs/ path, or a <cid>.ipfs.<host> subdomain); else null. */
export function ipfsPath(address: string): string | null {
  try {
    if (address.startsWith("ipfs://")) { const p = address.slice(7).replace(/^ipfs\//, ""); return CID.test(p.split("/")[0]) ? p : null; }
    const u = new URL(address);
    if (u.protocol !== "https:" && u.protocol !== "http:") return null;
    const m = u.pathname.match(/^\/ipfs\/([^/?#]+)(\/[^?#]*)?$/);
    if (m && CID.test(m[1])) return m[1] + (m[2] ?? "");
    const sub = u.hostname.match(/^([a-z0-9]+)\.ipfs\./i);
    if (sub && CID.test(sub[1])) return sub[1] + (u.pathname === "/" ? "" : u.pathname);
    return null;
  } catch { return null; }
}
/** Where to read a metadata file from, in order: its own address unless that is a dead IPFS gateway, then the live gateways. */
export function metadataCandidates(uri: string): string[] {
  const path = ipfsPath(uri);
  if (!path) return [uri];
  let own: string | null = uri;
  try { if (uri.startsWith("ipfs://") || deadIpfsHost(new URL(uri).hostname)) own = null; } catch { own = null; }
  return [...(own ? [own] : []), ...IPFS_GATEWAYS.map((g) => g + path)];
}
/** A metadata file from the first candidate that answers. */
export async function fetchMetadataJsonAny(uri: string): Promise<unknown> {
  let last: unknown = new Error("no metadata address");
  for (const u of metadataCandidates(uri)) { try { return await fetchMetadataJson(u, 8000); } catch (e) { last = e; } }
  throw last;
}
/** A logo address a browser can load: an https address on a live host as it is; on a dead IPFS gateway
 *  or ipfs://, the first live gateway that serves it as an image (null when none does). Only the fixed
 *  gateways are probed. */
export async function liveImage(image: string, probe: (url: string) => Promise<boolean> = probeImage): Promise<string | null> {
  const https = /^https:\/\/[^\s"'<>]{4,1024}$/.test(image);
  const path = ipfsPath(image);
  // off IPFS, or on a gateway that still serves (a coin's own dedicated gateway): as it is
  if (!path || (https && !deadIpfsHost(new URL(image).hostname))) return https ? image : null;
  for (const g of IPFS_GATEWAYS) { if (await probe(g + path)) return g + path; }
  return null;
}
async function probeImage(url: string): Promise<boolean> {
  try {
    const r = await fetch(url, { method: "HEAD", redirect: "follow", signal: AbortSignal.timeout(8000) });
    return r.ok && /^image\//i.test(r.headers.get("content-type") ?? "");
  } catch { return false; }
}
