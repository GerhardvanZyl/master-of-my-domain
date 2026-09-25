import { MAP_ZOOM as ZOOM, TILE, project } from "@/lib/mercator";

// Google's own roadmap tiles, cached under public/maptiles by
// scripts/_map-tiles.ts and served from our origin.
//
// This was CARTO Voyager, chosen because it put OSM data on a light,
// Google-ish palette that survives being shrunk into a ~150px card corner
// (plain openstreetmap.org tiles carry far too much label and POI ink at that
// size). CARTO then began stamping "API KEY REQUIRED" across every tile.
// Serving our own copy means no third party can do that to the card again.
//
// A tile only exists if _map-tiles.ts has been run since the property was
// added, so onError below degrades to the backdrop rather than a broken image.
const tileUrl = (x: number, y: number) => `/maptiles/${ZOOM}/${x}/${y}.png`;

/**
 * Keyless map preview: a 2×2 block of cached raster tiles, translated so the
 * property sits dead centre under the pin — like a Google Maps static image,
 * and unlike a live Maps iframe per card (~290 of those pinned the main thread
 * and ate hundreds of MB). The block, not a single tile, is what lets the pin
 * be centred: a lone tile would have to render the point wherever it happened
 * to fall, including hard against an edge.
 * `className` carries all sizing/position (caller keeps MAP_SIZES).
 */
export default function StaticMap({
  lat,
  lng,
  className,
}: {
  lat: number;
  lng: number;
  className: string;
}) {
  const { x, y } = project(lat, lng, ZOOM);
  // Origin of the 2×2 block whose centre is nearest the point, so the point
  // always lands in the middle half of the block (fraction 0.25–0.75).
  const x0 = Math.round(x / TILE) - 1;
  const y0 = Math.round(y / TILE) - 1;
  // Grid is 200% of the box, so the box shows one tile's worth of map. Shift it
  // to put the point at the box's 50%/50%.
  const left = 50 - (200 * (x - x0 * TILE)) / (2 * TILE);
  const top = 50 - (200 * (y - y0 * TILE)) / (2 * TILE);

  return (
    // The pin anchors to the inner wrapper, not the outer box: callers position
    // the outer one (`absolute …`), and adding `relative` here as well would
    // silently win — Tailwind resolves colliding position utilities by
    // stylesheet order, not by the order they appear in the class string, so
    // the map jumped from bottom-right back into the flow at top-left.
    <div className={`${className} overflow-hidden`}>
      <div className="relative h-full w-full bg-[#e8e4de]">
        <div
          className="absolute grid h-[200%] w-[200%] grid-cols-2"
          // Rounded: raw float64 %s serialize differently server vs client and
          // React flags it as a hydration mismatch. 4dp is sub-pixel anyway.
          style={{ left: `${left.toFixed(4)}%`, top: `${top.toFixed(4)}%` }}
        >
          {[0, 1].map((dy) =>
            [0, 1].map((dx) => (
              <img
                key={`${dx}${dy}`}
                src={tileUrl(x0 + dx, y0 + dy)}
                alt=""
                loading="lazy"
                decoding="async"
                // An uncached tile (a listing in ground no round has covered
                // yet) would otherwise render as a broken-image glyph in the
                // corner of the card; hide it and let the backdrop show.
                onError={(e) => {
                  e.currentTarget.style.visibility = "hidden";
                }}
                className="h-full w-full"
              />
            )),
          )}
        </div>
        {/* Teardrop pin, centred on its tip. */}
        <svg
          aria-hidden
          viewBox="0 0 24 24"
          className="absolute left-1/2 top-1/2 h-6 w-6 -translate-x-1/2 -translate-y-full drop-shadow-[0_1px_2px_rgba(0,0,0,.45)]"
        >
          <path
            d="M12 23c0 0-8-9.2-8-14a8 8 0 1 1 16 0c0 4.8-8 14-8 14z"
            fill="#B9762A"
            stroke="#fff"
            strokeWidth="1.5"
          />
          <circle cx="12" cy="9" r="2.6" fill="#fff" />
        </svg>
      </div>
    </div>
  );
}
