/**
 * Shared Overpass API helper for compute-stations.ts / compute-metadata.ts.
 *
 * Properties can live in geographically distant clusters (e.g. Melbourne
 * west, Torquay/Surf Coast, Sydney). Rather than one Overpass query over a
 * bbox spanning all of them (which would cover most of two states), this
 * clusters property coordinates with greedy single-link clustering, queries
 * Overpass once per (POI type, cluster) with an appropriate padding, and
 * merges the results.
 *
 * Every coordinate returned by getPois() comes from a live (or cached) live
 * Overpass response — nothing here is hand-entered.
 */
import fs from "node:fs";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

export type Point = { lat: number; lng: number };

export type OverpassElement = {
  key: string; // `${osmType}/${osmId}`, unique across a query
  lat: number;
  lng: number;
  tags: Record<string, string>;
};

export type PoiType = "station" | "playground" | "coles" | "vet";

const CACHE_PATH = path.resolve(process.cwd(), "data/harvest/poi-cache.json");
const OVERPASS_URL = "https://overpass-api.de/api/interpreter";
const POLITE_DELAY_MS = 2000;

type CacheFile = Record<string, { fetchedAt: string; elements: OverpassElement[] }>;

function loadCache(): CacheFile {
  try {
    return JSON.parse(fs.readFileSync(CACHE_PATH, "utf8")) as CacheFile;
  } catch {
    return {};
  }
}

function saveCache(cache: CacheFile) {
  fs.mkdirSync(path.dirname(CACHE_PATH), { recursive: true });
  fs.writeFileSync(CACHE_PATH, JSON.stringify(cache, null, 2));
}

export function haversineM(aLat: number, aLng: number, bLat: number, bLng: number): number {
  const R = 6371000;
  const toRad = (d: number) => (d * Math.PI) / 180;
  const dLat = toRad(bLat - aLat);
  const dLng = toRad(bLng - aLng);
  const s =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(aLat)) * Math.cos(toRad(bLat)) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(s));
}

/**
 * Greedy single-link clustering: start a cluster from an unassigned point,
 * absorb any remaining point within `thresholdKm` of ANY current member,
 * repeat until the cluster stops growing, then start the next cluster.
 * Derives cluster count/locations from the data every run — nothing is
 * hardcoded about how many clusters or where they are.
 */
export function clusterProperties(points: Point[], thresholdKm = 30): Point[][] {
  const thresholdM = thresholdKm * 1000;
  const remaining = points.slice();
  const clusters: Point[][] = [];
  while (remaining.length) {
    const cluster = [remaining.shift()!];
    let grew = true;
    while (grew) {
      grew = false;
      for (let i = remaining.length - 1; i >= 0; i--) {
        const p = remaining[i];
        if (cluster.some((c) => haversineM(c.lat, c.lng, p.lat, p.lng) <= thresholdM)) {
          cluster.push(p);
          remaining.splice(i, 1);
          grew = true;
        }
      }
    }
    clusters.push(cluster);
  }
  return clusters;
}

export type Bbox = { minLat: number; minLng: number; maxLat: number; maxLng: number };

export function paddedBbox(cluster: Point[], paddingKm: number): Bbox {
  const lats = cluster.map((p) => p.lat);
  const lngs = cluster.map((p) => p.lng);
  const minLat = Math.min(...lats);
  const maxLat = Math.max(...lats);
  const minLng = Math.min(...lngs);
  const maxLng = Math.max(...lngs);
  const midLat = (minLat + maxLat) / 2;
  const latPad = paddingKm / 111;
  const lngPad = paddingKm / (111 * Math.max(0.1, Math.cos((midLat * Math.PI) / 180)));
  return {
    minLat: minLat - latPad,
    maxLat: maxLat + latPad,
    minLng: minLng - lngPad,
    maxLng: maxLng + lngPad,
  };
}

function overpassFilterFor(type: PoiType): string {
  switch (type) {
    case "station":
      return '["railway"="station"]["station"!="subway"]';
    case "playground":
      return '["leisure"="playground"]';
    case "coles":
      return '["shop"="supermarket"]["name"~"Coles",i]';
    case "vet":
      return '["amenity"="veterinary"]';
  }
}

function buildQuery(type: PoiType, bbox: Bbox): string {
  const bboxStr = `${bbox.minLat},${bbox.minLng},${bbox.maxLat},${bbox.maxLng}`;
  const filter = overpassFilterFor(type);
  return `[out:json][timeout:60];
(
  node${filter}(${bboxStr});
  way${filter}(${bboxStr});
  relation${filter}(${bboxStr});
);
out center;`;
}

const execFileAsync = promisify(execFile);

// Node's native fetch (undici) cannot reliably reach overpass-api.de from this
// machine — it gets HTTP 406 or hangs to a connect-timeout even though `curl`
// on the same host reaches the same URL fine. Shell out to curl instead;
// everything else about the query/response handling is unchanged.
const RETRY_BACKOFF_MS = [5000, 15000]; // transient-only: overloaded public Overpass instance

async function fetchOverpass(query: string): Promise<OverpassElement[]> {
  let lastErr: unknown;
  for (let attempt = 0; attempt <= RETRY_BACKOFF_MS.length; attempt++) {
    try {
      const result = await execFileAsync(
        "curl",
        [
          "-sS",
          "-f",
          "--max-time",
          "90",
          "-X",
          "POST",
          OVERPASS_URL,
          "--data-urlencode",
          `data=${query}`,
        ],
        { maxBuffer: 1024 * 1024 * 64 },
      );
      const json = JSON.parse(result.stdout) as { elements?: Array<Record<string, unknown>> };
      return elementsFromJson(json);
    } catch (err) {
      lastErr = err;
      if (attempt < RETRY_BACKOFF_MS.length) {
        console.log(
          `    (Overpass request failed, retrying in ${RETRY_BACKOFF_MS[attempt] / 1000}s: ${
            err instanceof Error ? err.message.split("\n")[0] : String(err)
          })`,
        );
        await new Promise((r) => setTimeout(r, RETRY_BACKOFF_MS[attempt]));
      }
    }
  }
  throw new Error(
    `Overpass API request failed (curl) after ${RETRY_BACKOFF_MS.length + 1} attempts: ${
      lastErr instanceof Error ? lastErr.message : String(lastErr)
    }`,
  );
}

function elementsFromJson(json: { elements?: Array<Record<string, unknown>> }): OverpassElement[] {
  const out: OverpassElement[] = [];
  for (const el of json.elements ?? []) {
    const center = el.center as { lat?: number; lon?: number } | undefined;
    const lat = (el.lat as number | undefined) ?? center?.lat;
    const lng = (el.lon as number | undefined) ?? center?.lon;
    if (typeof lat !== "number" || typeof lng !== "number") continue;
    out.push({
      key: `${el.type as string}/${el.id as string | number}`,
      lat,
      lng,
      tags: (el.tags as Record<string, string> | undefined) ?? {},
    });
  }
  return out;
}

const round = (n: number) => Math.round(n * 1000) / 1000; // ~100m precision, stable cache keys

/**
 * Cluster the given property coordinates, query Overpass once per
 * (type, cluster) — using the cache on a hit, live Overpass on a miss — and
 * return the deduplicated, merged candidate list across every cluster.
 *
 * Throws (does not fall back to an empty list) if a live fetch fails and
 * there is no cached entry for that cluster/type — callers must let this
 * propagate and exit non-zero rather than writing placeholder output.
 */
export async function getPois(
  type: PoiType,
  points: Point[],
  opts: { paddingKm: number; clusterThresholdKm?: number },
): Promise<OverpassElement[]> {
  const clusterThresholdKm = opts.clusterThresholdKm ?? 30;
  const clusters = clusterProperties(points, clusterThresholdKm);
  const cache = loadCache();
  const merged = new Map<string, OverpassElement>();

  for (let i = 0; i < clusters.length; i++) {
    const cluster = clusters[i];
    const bbox = paddedBbox(cluster, opts.paddingKm);
    const cacheKey = `${type}:${round(bbox.minLat)},${round(bbox.minLng)},${round(bbox.maxLat)},${round(bbox.maxLng)}`;

    let elements: OverpassElement[];
    const hit = cache[cacheKey];
    if (hit) {
      elements = hit.elements;
      console.log(
        `  [${type}] cluster ${i + 1}/${clusters.length} (${cluster.length} props): cache hit (${elements.length} elements)`,
      );
    } else {
      console.log(
        `  [${type}] cluster ${i + 1}/${clusters.length} (${cluster.length} props): querying Overpass live...`,
      );
      try {
        elements = await fetchOverpass(buildQuery(type, bbox));
      } catch (err) {
        throw new Error(
          `Overpass API request failed for POI type "${type}" (cluster ${i + 1}/${clusters.length}, ` +
            `bbox ${cacheKey}) and no cached entry exists at ${CACHE_PATH}. Refusing to substitute an ` +
            `empty/placeholder result. Underlying error: ${err instanceof Error ? err.message : String(err)}`,
        );
      }
      cache[cacheKey] = { fetchedAt: new Date().toISOString(), elements };
      saveCache(cache); // persist incrementally so a later failure doesn't lose earlier work
      console.log(`    -> ${elements.length} elements from Overpass`);
      await new Promise((r) => setTimeout(r, POLITE_DELAY_MS));
    }
    for (const el of elements) merged.set(el.key, el);
  }

  return Array.from(merged.values());
}
