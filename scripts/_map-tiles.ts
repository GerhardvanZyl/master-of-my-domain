/**
 * Cache the Google map tiles the card thumbnails need, into public/maptiles/.
 *
 * StaticMap used CARTO's keyless Voyager tiles; CARTO now stamps
 * "API KEY REQUIRED" across them. Rather than swap in another third party that
 * can do the same thing again, this pulls Google's own roadmap tiles ONCE and
 * serves them from our own origin, so the card map has no render-time
 * dependency on anybody.
 *
 * Why tiles and not a screenshot per property: the properties cluster into four
 * suburbs, so 605 of them share only ~169 distinct z15 tiles. Capturing one
 * image per property would fetch the same ground 600+ times, cost hours of
 * browser driving, and produce ~60MB instead of ~1.5MB.
 *
 * public/, not data/: these are static shared assets that must ship WITH the
 * code. docker-compose bind-mounts ${LIVE_DATA} over /app/data on the live box,
 * so anything written to data/ in this repo never reaches it; public/ arrives
 * on the same `git pull` as the code, and Next serves it with no route needed.
 *
 * Idempotent: an already-cached tile is skipped, so re-running each round only
 * tops up the tiles new listings introduced. Run it whenever a round adds
 * properties in ground we haven't covered.
 *
 * Usage: npx tsx scripts/_map-tiles.ts [--force]
 *        PROPS_JSON=<file> npx tsx scripts/_map-tiles.ts   (else reads the live app)
 */
import fs from "node:fs";
import path from "node:path";
import { MAP_ZOOM, TILE, project } from "@/lib/mercator";
import { getAllLiveProperties } from "./_live-http.mjs";

const BASE = process.env.LIVE_BASE ?? "http://192.168.68.125:3225";
const OUT = path.resolve("public/maptiles", String(MAP_ZOOM));
const FORCE = process.argv.includes("--force");

interface Geo {
  latitude: number | null;
  longitude: number | null;
}

const src = process.env.PROPS_JSON;
const props: Geo[] = src
  ? JSON.parse(fs.readFileSync(src, "utf8"))
  : ((await getAllLiveProperties(BASE)) as Geo[]);

// The 2x2 block StaticMap composites around each point. Same arithmetic as the
// component (x0 = round(x/TILE) - 1), so the set cached here is exactly the set
// requested at render time — derived from the same project()/TILE/MAP_ZOOM.
const want = new Set<string>();
for (const p of props) {
  if (p.latitude == null || p.longitude == null) continue;
  const { x, y } = project(p.latitude, p.longitude, MAP_ZOOM);
  const x0 = Math.round(x / TILE) - 1;
  const y0 = Math.round(y / TILE) - 1;
  for (let dy = 0; dy < 2; dy++) for (let dx = 0; dx < 2; dx++) want.add(`${x0 + dx}/${y0 + dy}`);
}

const todo = [...want].filter((t) => FORCE || !fs.existsSync(path.join(OUT, `${t}.png`)));
console.log(`properties: ${props.length}  tiles needed: ${want.size}  to fetch: ${todo.length}`);

let ok = 0;
const failed: string[] = [];
for (const [i, t] of todo.entries()) {
  const [x, y] = t.split("/");
  // mt0-3 are Google's four tile hosts; spreading across them is how a browser
  // loads a map, and keeps us off a single host. lyrs=m is the roadmap style.
  const url = `https://mt${i % 4}.google.com/vt/lyrs=m&x=${x}&y=${y}&z=${MAP_ZOOM}`;
  try {
    const r = await fetch(url, {
      headers: {
        "User-Agent":
          "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0 Safari/537.36",
        Referer: "https://www.google.com/maps",
      },
    });
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    const buf = Buffer.from(await r.arrayBuffer());
    // Validate the PNG signature, NOT the size. A tile that is entirely water
    // compresses to ~200B and is perfectly valid — three coastal tiles (two off
    // Sydney, one off Torquay) are exactly that, and a size floor rejected them,
    // which the idempotent skip would then have made permanent. An actual
    // failure shows up as a non-200 or a non-PNG body, both caught here.
    if (!buf.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) {
      throw new Error(`not a PNG (${buf.length}B, ${r.headers.get("content-type")})`);
    }
    fs.mkdirSync(path.join(OUT, x), { recursive: true });
    fs.writeFileSync(path.join(OUT, `${x}/${y}.png`), buf);
    ok++;
  } catch (e) {
    failed.push(`${t}: ${String(e instanceof Error ? e.message : e)}`);
  }
  if (i % 25 === 24) console.log(`  ...${i + 1}/${todo.length}`);
  await new Promise((r) => setTimeout(r, 120));
}

const bytes = [...want]
  .map((t) => {
    try {
      return fs.statSync(path.join(OUT, `${t}.png`)).size;
    } catch {
      return 0;
    }
  })
  .reduce((a, b) => a + b, 0);
const missing = [...want].filter((t) => !fs.existsSync(path.join(OUT, `${t}.png`)));
console.log(
  JSON.stringify({ fetched: ok, failed: failed.length, cached: want.size - missing.length, missing: missing.length, kb: Math.round(bytes / 1024) }),
);
if (failed.length) console.log("failures:\n  " + failed.slice(0, 20).join("\n  "));
