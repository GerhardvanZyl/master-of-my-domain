export const TILE = 256;

/** Web Mercator: lat/lng → world pixel coords at zoom `z` (same convention as
 *  the OSM tile grid, so tile (x,y) covers pixels [x*256,(x+1)*256)). */
export function project(lat: number, lng: number, z: number) {
  const scale = TILE * 2 ** z;
  // Clamp near the poles — the log blows up at ±90°.
  const s = Math.min(Math.max(Math.sin((lat * Math.PI) / 180), -0.9999), 0.9999);
  return {
    x: ((lng + 180) / 360) * scale,
    y: (0.5 - Math.log((1 + s) / (1 - s)) / (4 * Math.PI)) * scale,
  };
}

/** Zoom for the card thumbnail's cached Google tiles. The capture script and
 *  StaticMap MUST agree: a mismatch requests a z-level that was never cached
 *  and every tile 404s, so this is the single source of truth for both. */
export const MAP_ZOOM = 15;
