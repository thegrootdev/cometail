import type { NextConfig } from "next";
import path from "node:path";

const nextConfig: NextConfig = {
  // the client package is TypeScript source in the workspace
  experimental: { cpus: 1 },
  transpilePackages: ["@cometail/client"],
  // the app lives in a pnpm workspace: trace server files from the repository root so the
  // deployment ships the native image library and its platform packages
  outputFileTracingRoot: path.join(__dirname, ".."),
  serverExternalPackages: ["sharp"],
  // the native image library is optional at run time (the upload route accepts the browser's own
  // crop without it), so no tracing includes reach outside the project root
  // one host: anything that arrives on www goes to the same path on the apex with a 308, pages
  // and API routes alike (config redirects run before the file system, so /api is covered).
  // The query string is carried over. Vercel's own apex -> www redirect must be off, or the
  // two would loop.
  async redirects() {
    return [
      {
        source: "/:path*",
        has: [{ type: "host", value: "www.cometail.fun" }],
        destination: "https://cometail.fun/:path*",
        permanent: true,
      },
    ];
  },
};

export default nextConfig;
