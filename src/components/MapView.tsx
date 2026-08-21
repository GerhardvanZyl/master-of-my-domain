"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import type { PropertyListItem } from "@/db/queries/properties";
import { formatPrice } from "@/lib/format";
import { vibeScore } from "@/lib/vibes";
import { useVibeConfig } from "@/lib/use-vibe-config";
import { TILE, project } from "@/lib/mercator";
import { useProfile } from "@/lib/profile";
import { loadViewed } from "@/lib/viewed";
import {
  DEFAULT_FILTER_STATE,
  filterProperties,
  isRatedProperty,
  loadRegionFilters,
  type FilterState,
} from "@/lib/property-filters";
import { pinDiameterScale } from "@/lib/pin-scale";

const HEIGHT = 600;

// A 5px circle is too small to reliably tap — the button's actual hit area
// floors out at this size regardless of how small the visible dot is.
const PIN_HIT_MIN = 24;

// "Highlight near" filters — a property lights up when it passes the test.
const AMENITIES: { key: string; label: string; ok: (p: PropertyListItem) => boolean }[] = [
  { key: "station", label: "Station ≤800 m", ok: (p) => (p.stationDistanceM ?? Infinity) <= 800 },
  { key: "coles", label: "Coles ≤1 km", ok: (p) => (p.colesDistanceM ?? Infinity) <= 1000 },
  { key: "play", label: "Playground ≤500 m", ok: (p) => (p.playgrounds500m ?? 0) > 0 },
  { key: "vet", label: "Vet ≤10 km", ok: (p) => (p.greenCrossDistanceM ?? Infinity) <= 10_000 },
  { key: "transit", label: "Transit ≤60 min", ok: (p) => (p.ptMinutesToFlinders ?? Infinity) <= 60 },
];

export default function MapView({ properties }: { properties: PropertyListItem[] }) {
  const router = useRouter();
  const box = useRef<HTMLDivElement>(null);
  const [width, setWidth] = useState(1200);
  const [zoomAdj, setZoomAdj] = useState(0);
  const [amen, setAmen] = useState<string[]>([]);
  const { profile } = useProfile();

  useEffect(() => {
    const el = box.current;
    if (!el) return;
    const ro = new ResizeObserver(([e]) => setWidth(e.contentRect.width));
    ro.observe(el);
    setWidth(el.clientWidth);
    return () => ro.disconnect();
  }, []);

  // Properties with coordinates at all — the denominator for the "N have no
  // coordinates" notice below, unaffected by the grid's filters (unchanged
  // from before this change: that notice is about geocoding coverage, not
  // about what's currently filtered in).
  const pinsWithCoords = properties.filter((p) => p.latitude != null && p.longitude != null);

  // The grid's filters live in localStorage, per region ("vic" for the home
  // page, "nsw" for /sydney) and per profile — see PropertyGrid's `fkey`.
  // This page shows both regions' properties on one map, so it restores both
  // regions' saved filters and applies each to its own properties, same
  // reading FilterState-only, never writing it — there is no filter UI here.
  const [filters, setFilters] = useState<{ vic: FilterState; nsw: FilterState }>({
    vic: DEFAULT_FILTER_STATE,
    nsw: DEFAULT_FILTER_STATE,
  });
  useEffect(() => {
    setFilters({ vic: loadRegionFilters("vic", profile), nsw: loadRegionFilters("nsw", profile) });
  }, [profile]);

  // "Viewed" set backing the viewedFilter tri-chip — same per-profile
  // localStorage read PropertyGrid does, needed here for the same reason.
  const [viewedSet, setViewedSet] = useState<Set<string>>(new Set());
  useEffect(() => setViewedSet(loadViewed(profile)), [profile]);

  const pins = useMemo(() => {
    const ctx = {
      shortlistOf: (p: PropertyListItem) => p.shortlistTag,
      attendedOf: (p: PropertyListItem) => p.attendedAt,
      viewedSet,
      isRated: (p: PropertyListItem) => isRatedProperty(p, profile),
    };
    const vic = pinsWithCoords.filter((p) => p.state !== "NSW");
    const nsw = pinsWithCoords.filter((p) => p.state === "NSW");
    return [...filterProperties(vic, filters.vic, ctx), ...filterProperties(nsw, filters.nsw, ctx)];
    // eslint-disable-next-line react-hooks/exhaustive-deps -- pinsWithCoords is
    // derived fresh from `properties` every render; including it would defeat
    // the memo. `properties` is the real dependency and is listed instead.
  }, [properties, filters, viewedSet, profile]);

  // Same rule as the grid: localStorage/server only after mount, never during render.
  const { cfg } = useVibeConfig();

  // Vibe score per plotted pin, and the diameter that maps it linearly onto
  // [PIN_MIN, PIN_MAX] across whatever range is actually present among them —
  // see src/lib/pin-scale.ts for the pure scale function this wraps.
  const scoreOf = useMemo(() => new Map(pins.map((p) => [p.id, vibeScore(p, p.ratings, cfg)])), [pins, cfg]);
  const pinDiameter = useMemo(() => pinDiameterScale([...scoreOf.values()]), [scoreOf]);

  // Auto-fit: largest integer zoom where every pin still fits, then user nudge.
  // Filters excluding every plotted property must not blank the whole map: the
  // extent falls back to the unfiltered pinsWithCoords (or a fixed Melbourne
  // CBD centre if there's nothing geocoded at all), so the basemap still
  // renders and the "hidden by your filters" notice below has something to
  // point at instead of a featureless grey box.
  const view = useMemo(() => {
    const extentSource = pins.length > 0 ? pins : pinsWithCoords;
    // Melbourne CBD — used only when nothing on the page has coordinates at
    // all, so there's still a sensible place to show the (pin-less) basemap.
    const lats = extentSource.length > 0 ? extentSource.map((p) => p.latitude!) : [-37.8136];
    const lngs = extentSource.length > 0 ? extentSource.map((p) => p.longitude!) : [144.9631];
    const centre = {
      lat: (Math.min(...lats) + Math.max(...lats)) / 2,
      lng: (Math.min(...lngs) + Math.max(...lngs)) / 2,
    };
    const pad = 40; // px of breathing room for the pin markers (≤50px diameter)
    let z = 10;
    for (let cand = 18; cand >= 10; cand--) {
      const a = project(Math.max(...lats), Math.min(...lngs), cand);
      const b = project(Math.min(...lats), Math.max(...lngs), cand);
      if (b.x - a.x <= width - pad * 2 && b.y - a.y <= HEIGHT - pad * 2) {
        z = cand;
        break;
      }
    }
    z = Math.min(18, Math.max(3, z + zoomAdj));
    const c = project(centre.lat, centre.lng, z);
    return { z, originX: c.x - width / 2, originY: c.y - HEIGHT / 2 };
  }, [pins, width, zoomAdj]);

  const tiles = useMemo(() => {
    if (!view) return [];
    const { z, originX, originY } = view;
    const max = 2 ** z;
    const out: { key: string; src: string; left: number; top: number }[] = [];
    for (let tx = Math.floor(originX / TILE); tx <= Math.floor((originX + width) / TILE); tx++) {
      for (let ty = Math.floor(originY / TILE); ty <= Math.floor((originY + HEIGHT) / TILE); ty++) {
        if (ty < 0 || ty >= max) continue;
        const wx = ((tx % max) + max) % max; // wrap across the antimeridian
        out.push({
          key: `${tx}/${ty}`,
          src: `https://tile.openstreetmap.org/${z}/${wx}/${ty}.png`,
          left: tx * TILE - originX,
          top: ty * TILE - originY,
        });
      }
    }
    return out;
  }, [view, width]);

  function toggleAmen(key: string) {
    setAmen((prev) => (prev.includes(key) ? prev.filter((k) => k !== key) : [...prev, key]));
  }
  const matches = (p: PropertyListItem) =>
    amen.every((k) => AMENITIES.find((a) => a.key === k)?.ok(p));

  return (
    <section className="rise space-y-4">
      <div className="flex flex-wrap items-end justify-between gap-4">
        <div>
          <div className="eyebrow mb-1.5">Where they are</div>
          <h1 className="font-serif text-[38px] leading-none">Map view</h1>
        </div>
        <div className="flex items-center gap-2">
          <button onClick={() => setZoomAdj((z) => z - 1)} className="chip" aria-label="Zoom out">
            −
          </button>
          <button onClick={() => setZoomAdj((z) => z + 1)} className="chip" aria-label="Zoom in">
            +
          </button>
        </div>
      </div>

      <div className="flex flex-wrap items-center gap-2">
        <span className="label-cap mr-1">Highlight near</span>
        {AMENITIES.map((a) => (
          <button
            key={a.key}
            onClick={() => toggleAmen(a.key)}
            className={`chip ${amen.includes(a.key) ? "chip-on" : "hover:border-forest"}`}
          >
            {a.label}
          </button>
        ))}
        {amen.length > 0 && (
          <button onClick={() => setAmen([])} className="text-xs text-mute hover:text-forest">
            clear
          </button>
        )}
      </div>

      <div
        ref={box}
        className="relative overflow-hidden rounded-[18px] border border-line bg-fill"
        style={{ height: HEIGHT }}
      >
        {tiles.map((t) => (
          // eslint-disable-next-line @next/next/no-img-element
          <img
            key={t.key}
            src={t.src}
            alt=""
            width={TILE}
            height={TILE}
            className="pointer-events-none absolute"
            style={{ left: t.left, top: t.top }}
          />
        ))}

        {view &&
          pins.map((p) => {
            const px = project(p.latitude!, p.longitude!, view.z);
            const on = matches(p);
            const score = scoreOf.get(p.id) ?? 0;
            const d = pinDiameter(score);
            // The visible dot can be as small as 5px; the button's hit area
            // never shrinks below PIN_HIT_MIN so it stays tappable.
            const hit = Math.max(d, PIN_HIT_MIN);
            return (
              <button
                key={p.id}
                data-testid="map-pin"
                onClick={() => router.push(`/property/${p.id}`)}
                title={`${p.address ?? "Property"} — ${formatPrice(p.priceDisplay, p.priceNumeric)} · vibe ${score}`}
                className="absolute flex -translate-x-1/2 -translate-y-1/2 items-center justify-center
                  transition-opacity"
                style={{
                  left: px.x - view.originX,
                  top: px.y - view.originY,
                  width: hit,
                  height: hit,
                  opacity: on ? 1 : 0.25,
                  zIndex: on ? 2 : 1,
                }}
              >
                <span
                  className="rounded-full border-2 border-white bg-amber shadow-md"
                  style={{ width: d, height: d }}
                />
              </button>
            );
          })}

        <span className="absolute bottom-1.5 right-2 rounded bg-white/80 px-1.5 text-[10px] text-mute">
          © OpenStreetMap contributors
        </span>
      </div>

      {pinsWithCoords.length < properties.length && (
        <p className="text-xs text-mute">
          {properties.length - pinsWithCoords.length} propert
          {properties.length - pinsWithCoords.length === 1 ? "y has" : "ies have"} no
          coordinates and aren&apos;t plotted.
        </p>
      )}
      {pins.length < pinsWithCoords.length && (
        <p className="text-xs text-mute">
          {pinsWithCoords.length - pins.length} more propert
          {pinsWithCoords.length - pins.length === 1 ? "y is" : "ies are"} hidden by your grid
          filters.
        </p>
      )}
    </section>
  );
}
