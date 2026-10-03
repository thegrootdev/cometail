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

export async function fetchMetadataJson(uri: string): Promise<unknown> {
  if (uri.length > 2048) throw new Error("metadata URL too long");
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout>;
  const deadline = new Promise<never>((_, reject) => { timer = setTimeout(() => {
    controller.abort(); reject(new Error("metadata timeout"));
  }, 6000); });
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
