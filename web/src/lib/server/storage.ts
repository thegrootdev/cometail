import "server-only";
import { AwsClient } from "aws4fetch";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
export interface ObjectStorage {
  put(key: string, body: Uint8Array, contentType: string): Promise<string>;
}
export function objectStorage(): ObjectStorage {
  const provider = process.env.COMETAIL_STORAGE_PROVIDER;
  if (provider === "local" && process.env.NODE_ENV !== "production") {
    const origin = process.env.COMETAIL_MEDIA_ORIGIN ?? "http://localhost:3100";
    return {
      async put(key, body) {
        if (!/^[a-f0-9]{64}\.(webp|json)$/.test(key))
          throw Error("Invalid object key");
        await mkdir(path.join(process.cwd(), ".local", "media"), {
          recursive: true,
        });
        await writeFile(
          path.join(process.cwd(), ".local", "media", key),
          body,
          { flag: "w" },
        );
        return `${origin}/api/media/${key}`;
      },
    };
  }
  const {
    R2_ACCOUNT_ID,
    R2_ACCESS_KEY_ID,
    R2_SECRET_ACCESS_KEY,
    R2_BUCKET,
    COMETAIL_MEDIA_ORIGIN,
  } = process.env;
  if (
    provider !== "r2" ||
    !R2_ACCOUNT_ID ||
    !R2_ACCESS_KEY_ID ||
    !R2_SECRET_ACCESS_KEY ||
    !R2_BUCKET ||
    !COMETAIL_MEDIA_ORIGIN
  )
    throw Error("STORAGE_NOT_CONFIGURED");
  let publicOrigin: URL;
  try {
    publicOrigin = new URL(COMETAIL_MEDIA_ORIGIN);
  } catch {
    throw Error("STORAGE_NOT_CONFIGURED");
  }
  if (publicOrigin.protocol !== "https:") throw Error("STORAGE_NOT_CONFIGURED");
  const client = new AwsClient({
    accessKeyId: R2_ACCESS_KEY_ID,
    secretAccessKey: R2_SECRET_ACCESS_KEY,
    service: "s3",
    region: "auto",
    retries: 2,
  });
  return {
    async put(key, body, contentType) {
      if (!/^[a-f0-9]{64}\.(webp|json)$/.test(key))
        throw Error("Invalid object key");
      let response: Response;
      try {
        response = await client.fetch(
          `https://${R2_ACCOUNT_ID}.r2.cloudflarestorage.com/${encodeURIComponent(R2_BUCKET)}/${key}`,
          {
            method: "PUT",
            signal: AbortSignal.timeout(20000),
            headers: {
              "Content-Type": contentType,
              // the host's fetch streams a body without a length and R2 answers 411 MissingContentLength;
              // the length is known, so it is sent
              "Content-Length": String(body.byteLength),
              "Cache-Control": "public,max-age=31536000,immutable",
            },
            body: Buffer.from(body),
          },
        );
      } catch (e) {
        console.error("storage write: request failed", String((e as Error).message ?? e));
        throw Error("STORAGE_WRITE_FAILED:request");
      }
      if (!response.ok) {
        // the operator reads the status and the service's error code from the logs and the answer; no
        // key material is ever in either
        const body = await response.text().catch(() => "");
        const code = /<Code>([^<]+)<\/Code>/.exec(body)?.[1] ?? "";
        console.error("storage write: rejected", { status: response.status, code, bucket: R2_BUCKET, key });
        throw Error(`STORAGE_WRITE_FAILED:${response.status}:${code}`);
      }
      return `${publicOrigin.toString().replace(/\/$/, "")}/${key}`;
    },
  };
}
