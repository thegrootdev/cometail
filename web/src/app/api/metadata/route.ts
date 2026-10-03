import { NextResponse } from "next/server";
import { createHash, createPublicKey, verify } from "node:crypto";
import { PublicKey } from "@solana/web3.js";
import { objectStorage } from "@/lib/server/storage";
import { metadataProofMessage, MetadataIntent } from "@/lib/metadata-proof";
export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** The image library, loaded when needed: a native-module failure on the host becomes a designed
 *  503 instead of a crashed route. */
async function imaging() {
  if (process.env.COMETAIL_DISABLE_NATIVE_IMAGING === "1") return null; // tests of the fallback
  try { return (await import("sharp")).default; } catch (e) { console.error("sharp unavailable", e); return null; }
}

/** The dimensions and animation flag of a WebP from its header (RIFF container; VP8, VP8L or VP8X). */
export function webpInfo(b: Buffer): { width: number; height: number; animated: boolean } | null {
  if (b.length < 30 || b.toString("ascii", 0, 4) !== "RIFF" || b.toString("ascii", 8, 12) !== "WEBP") return null;
  const chunk = b.toString("ascii", 12, 16);
  if (chunk === "VP8 ") return { width: b.readUInt16LE(26) & 0x3fff, height: b.readUInt16LE(28) & 0x3fff, animated: false };
  if (chunk === "VP8L") { const b0 = b[21], b1 = b[22], b2 = b[23], b3 = b[24]; return { width: 1 + (b0 | ((b1 & 0x3f) << 8)), height: 1 + ((b1 >> 6) | (b2 << 2) | ((b3 & 0x0f) << 10)), animated: false }; }
  if (chunk === "VP8X") return { width: 1 + b.readUIntLE(24, 3), height: 1 + b.readUIntLE(27, 3), animated: (b[20] & 0x02) !== 0 };
  return null;
}

/** What the launch pages check before the form: is storage configured and is the image library loadable? */
export async function GET() {
  const provider = process.env.COMETAIL_STORAGE_PROVIDER;
  const local = provider === "local" && process.env.NODE_ENV !== "production";
  const r2 = provider === "r2" && !!process.env.R2_ACCOUNT_ID && !!process.env.R2_ACCESS_KEY_ID && !!process.env.R2_SECRET_ACCESS_KEY && !!process.env.R2_BUCKET && /^https:\/\//.test(process.env.COMETAIL_MEDIA_ORIGIN ?? "");
  const image = !!(await imaging());
  // uploads are ready whenever storage is: the browser crop is accepted even without the native library
  return NextResponse.json({ ready: local || r2, storage: r2 ? "r2" : local ? "local" : "unconfigured", imaging: image }, { headers: { "cache-control": "no-store" } });
}
const MAX_BODY = 6 * 1024 * 1024;
const recent = new Map<string, { count: number; until: number }>();
function fail(error: string, status = 400) {
  return NextResponse.json({ error }, { status });
}
export async function POST(request: Request) {
  const expected =
    process.env.COMETAIL_APP_ORIGIN ?? new URL(request.url).origin;
  if (request.headers.get("origin") !== expected)
    return fail("Upload origin is not allowed.", 403);
  if (Number(request.headers.get("content-length") ?? 0) > MAX_BODY)
    return fail("Image upload is too large.", 413);
  try {
    const reader = request.body?.getReader();
    if (!reader) return fail("Choose an image.");
    const chunks: Uint8Array[] = [];
    let size = 0;
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > MAX_BODY) {
        await reader.cancel();
        return fail("Image upload is too large.", 413);
      }
      chunks.push(value);
    }
    const form = await new Response(Buffer.concat(chunks), {
      headers: { "content-type": request.headers.get("content-type") ?? "" },
    }).formData();
    const image = form.get("image");
    if (
      !(image instanceof File) ||
      image.size > 5 * 1024 * 1024 ||
      !["image/png", "image/jpeg", "image/webp"].includes(image.type)
    )
      return fail("Choose a PNG, JPEG or WebP image smaller than 5 MB.");
    const intent = JSON.parse(String(form.get("intent"))) as MetadataIntent;
    if (
      typeof intent.name !== "string" ||
      !intent.name.trim() ||
      Buffer.byteLength(intent.name) > 32 ||
      typeof intent.symbol !== "string" ||
      !intent.symbol ||
      Buffer.byteLength(intent.symbol) > 10 ||
      typeof intent.description !== "string" ||
      intent.description.length > 500 ||
      intent.origin !== expected ||
      !Number.isSafeInteger(intent.issuedAt) ||
      Math.abs(Date.now() - intent.issuedAt) > 300000
    )
      return fail(
        "The token identity or upload authorization is invalid. Please try again.",
      );
    const bytes = Buffer.from(await image.arrayBuffer());
    if (createHash("sha256").update(bytes).digest("hex") !== intent.imageHash)
      return fail("The image changed after authorization.", 403);
    const signature = Buffer.from(String(form.get("signature")), "base64");
    const key = createPublicKey({
      format: "der",
      type: "spki",
      key: Buffer.concat([
        Buffer.from("302a300506032b6570032100", "hex"),
        new PublicKey(intent.owner).toBuffer(),
      ]),
    });
    if (
      signature.length !== 64 ||
      !verify(null, Buffer.from(metadataProofMessage(intent)), key, signature)
    )
      return fail("Wallet authorization could not be verified.", 403);
    // Per-wallet and per-address budgets, process-local (each server instance keeps its own
    // table; an edge rate limit in front is the shared one). The table is bounded by
    // evicting the oldest entries, never by refusing everyone: wallets cost nothing to
    // make, so a full table must not become a way to lock uploads for every creator.
    const now = Date.now();
    for (const [key, value] of recent)
      if (value.until < now) recent.delete(key);
    while (recent.size > 10000) recent.delete(recent.keys().next().value as string);
    const address =
      request.headers.get("x-real-ip") ??
      request.headers.get("x-forwarded-for")?.split(",")[0].trim() ??
      "";
    const budgets: [string, number][] = [
      ["wallet:" + intent.owner, 12],
      ["address:" + address, 40],
    ];
    for (const [key, max] of budgets) {
      const quota = recent.get(key) ?? { count: 0, until: now + 3600000 };
      if (quota.count >= max)
        return fail("Upload limit reached. Please try again later.", 429);
      quota.count++;
      recent.set(key, quota);
    }
    const storage = objectStorage();
    const sharp = await imaging();
    // without the native library, the browser's own crop (a 512 x 512 still WebP, which is what
    // the identity component produces) is accepted after its header is checked; anything else
    // needs the library and is refused with a designed message
    let normalized: Buffer;
    if (!sharp) {
      const info = webpInfo(bytes);
      if (image.type !== "image/webp" || !info || info.animated || info.width !== 512 || info.height !== 512 || bytes.length > 1_500_000)
        return fail("Image processing is limited on this deployment right now: use the crop tool so the image is a 512 × 512 WebP, then try again.", 422);
      normalized = bytes;
    } else {
    const decoder = sharp(bytes, {
      limitInputPixels: 16777216,
      animated: false,
    });
    const info = await decoder.metadata();
    if (
      !info.width ||
      !info.height ||
      info.width < 128 ||
      info.height < 128 ||
      info.width > 8192 ||
      info.height > 8192 ||
      !["png", "jpeg", "webp"].includes(info.format ?? "") ||
      (info.pages ?? 1) > 1
    )
      return fail(
        "Use a single PNG, JPEG or WebP image between 128 and 8192 pixels.",
      );
    normalized = await decoder
      .rotate()
      .resize(512, 512, { fit: "cover" })
      .webp({ quality: 90 })
      .toBuffer();
    }
    const imageKey =
      createHash("sha256").update(normalized).digest("hex") + ".webp";
    const imageUrl = await storage.put(imageKey, normalized, "image/webp");
    const metadata = Buffer.from(
      JSON.stringify({
        name: intent.name,
        symbol: intent.symbol,
        description: intent.description,
        image: imageUrl,
        properties: {
          files: [{ uri: imageUrl, type: "image/webp" }],
          category: "image",
        },
      }),
    );
    const uri = await storage.put(
      createHash("sha256").update(metadata).digest("hex") + ".json",
      metadata,
      "application/json",
    );
    if (uri.length > 200)
      return fail(
        "The storage URL is too long for this token. Contact the operator.",
        503,
      );
    return NextResponse.json({ uri, image: imageUrl });
  } catch (error) {
    const message = error instanceof Error ? error.message : "";
    if (message.startsWith("STORAGE_"))
      return fail(
        "Image storage is not ready on this deployment. Please try again later.",
        503,
      );
    return fail(
      "The upload could not be processed. Check your image and try again.",
    );
  }
}
