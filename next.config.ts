import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // Lets the UI test suite run its own dev server without fighting the one you
  // have open over the shared .next directory.
  distDir: process.env.NEXT_DIST_DIR ?? ".next",
  // better-sqlite3 and playwright-core are native/server-only; keep them external
  // so Next doesn't try to bundle them into the server build.
  serverExternalPackages: [
    "better-sqlite3",
    "playwright-core",
    "probe-image-size",
  ],
};

export default nextConfig;
