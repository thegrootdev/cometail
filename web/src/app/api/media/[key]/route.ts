import { readFile } from "node:fs/promises";
import path from "node:path";
export const runtime = "nodejs";
export async function GET(
  _request: Request,
  { params }: { params: Promise<{ key: string }> },
) {
  if (
    process.env.COMETAIL_STORAGE_PROVIDER !== "local" ||
    process.env.NODE_ENV === "production"
  )
    return new Response(null, { status: 404 });
  const { key } = await params;
  if (!/^[a-f0-9]{64}\.(webp|json)$/.test(key))
    return new Response(null, { status: 404 });
  try {
    const data = await readFile(
      path.join(process.cwd(), ".local", "media", key),
    );
    return new Response(data, {
      headers: {
        "Content-Type": key.endsWith(".json")
          ? "application/json"
          : "image/webp",
        "X-Content-Type-Options": "nosniff",
        "Cache-Control": "public,max-age=31536000,immutable",
      },
    });
  } catch {
    return new Response(null, { status: 404 });
  }
}
