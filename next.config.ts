import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // Lets the UI test suite run its own dev server without fighting the one you
  // have open over the shared .next directory.
  distDir: process.env.NEXT_DIST_DIR ?? ".next",
  images: {
    // Default is 8 device widths + 8 image widths, and every <Image fill> emits
    // the whole ladder as a srcset — on a ~290-card grid that was ~230KB of
    // attribute text per page. Three widths is plenty for 1x/2x of the sizes
    // this app actually renders, and it means fewer sharp variants to generate.
    deviceSizes: [640, 1080, 1920],
    imageSizes: [96, 200, 420],
    // Local files, no CDN in front: cache optimised variants for a year.
    minimumCacheTTL: 31536000,
  },
  // better-sqlite3 and playwright-core are native/server-only; keep them external
  // so Next doesn't try to bundle them into the server build.
  serverExternalPackages: [
    "better-sqlite3",
    "playwright-core",
    "probe-image-size",
  ],
};

export default nextConfig;
