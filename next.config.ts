import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // better-sqlite3 and playwright-core are native/server-only; keep them external
  // so Next doesn't try to bundle them into the server build.
  serverExternalPackages: [
    "better-sqlite3",
    "playwright-core",
    "probe-image-size",
  ],
};

export default nextConfig;
