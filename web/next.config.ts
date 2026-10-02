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
};

export default nextConfig;
