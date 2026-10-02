import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // the client package is TypeScript source in the workspace
  experimental: { cpus: 1 },
  transpilePackages: ["@cometail/client"],
};

export default nextConfig;
