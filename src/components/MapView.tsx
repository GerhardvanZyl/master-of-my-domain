"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import type { PropertyListItem } from "@/db/queries/properties";
import { formatPrice } from "@/lib/format";
import { DEFAULT_VIBE_CONFIG, loadVibeConfig, vibeScore } from "@/lib/vibes";
import { TILE, project } from "@/lib/mercator";

const HEIGHT = 600;

// "Highlight near" filters — a property lights up when it passes the test.
const AMENITIES: { key: string; label: string; ok: (p: PropertyListItem) => boolean }[] = [
  { key: "station", label: "Station ≤800 m", ok: (p) => (p.stationDistanceM ?? Infinity) <= 800 },
  { key: "coles", label: "Coles ≤1 km", ok: (p) => (p.colesDistanceM ?? Infinity) <= 1000 },
  { key: "play", label: "Playground ≤500 m", ok: (p) => (p.playgrounds500m ?? 0) > 0 },
  { key: "vet", label: "Vet ≤10 km", ok: (p) => (p.greenCrossDistanceM ?? Infinity) <= 10_000 },
  { key: "transit", label: "Flinders ≤60 min", ok: (p) => (p.ptMinutesToFlinders ?? Infinity) <= 60 },
];

export default function MapView({ properties }: { properties: PropertyListItem[] }) {
  const router = useRouter();
  const box = useRef<HTMLDivElement>(null);
  const [width, setWidth] = useState(1200);
  const [zoomAdj, setZoomAdj] = useState(0);
  const [amen, setAmen] = useState<string[]>([]);

  useEffect(() => {
    const el = box.current;
    if (!el) return;
    const ro = new ResizeObserver(([e]) => setWidth(e.contentRect.width));
    ro.observe(el);
    setWidth(el.clientWidth);
    return () => ro.disconnect();
  }, []);

  const pins = properties.filter((p) => p.latitude != null && p.longitude != null);

  // Same rule as the grid: localStorage only after mount, never during render.
  const [cfg, setCfg] = useState(DEFAULT_VIBE_CONFIG);
  useEffect(() => setCfg(loadVibeConfig()), []);

  // Auto-fit: largest integer zoom where every pin still fits, then user nudge.
  const view = useMemo(() => {
    if (pins.length === 0) return null;
    const lats = pins.map((p) => p.latitude!);
    const lngs = pins.map((p) => p.longitude!);
    const centre = {
      lat: (Math.min(...lats) + Math.max(...lats)) / 2,
      lng: (Math.min(...lngs) + Math.max(...lngs)) / 2,
    };
    const pad = 90; // px of breathing room for the pin bubbles
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
            return (
              <button
                key={p.id}
                onClick={() => router.push(`/property/${p.id}`)}
                title={p.address ?? ""}
                className="absolute -translate-x-1/2 -translate-y-full transition-opacity"
                style={{
                  left: px.x - view.originX,
                  top: px.y - view.originY,
                  opacity: on ? 1 : 0.25,
                  zIndex: on ? 2 : 1,
                }}
              >
                <span className="flex flex-col items-center">
                  <span className="flex items-center gap-1.5 whitespace-nowrap rounded-full border-2 border-forest bg-white px-2.5 py-1 shadow-md">
                    <span className="flex h-4 w-4 items-center justify-center rounded-full bg-amber text-[9px] text-white">
                      ✨
                    </span>
                    <span className="text-xs font-bold">
                      {formatPrice(p.priceDisplay, p.priceNumeric)}
                    </span>
                    <span className="text-[11px] text-mute">
                      {vibeScore(p, p.ratings, cfg)}
                    </span>
                  </span>
                  <span className="h-2 w-0.5 bg-forest" />
                </span>
              </button>
            );
          })}

        <span className="absolute bottom-1.5 right-2 rounded bg-white/80 px-1.5 text-[10px] text-mute">
          © OpenStreetMap contributors
        </span>
      </div>

      {pins.length < properties.length && (
        <p className="text-xs text-mute">
          {properties.length - pins.length} propert
          {properties.length - pins.length === 1 ? "y has" : "ies have"} no
          coordinates and aren&apos;t plotted.
        </p>
      )}
    </section>
  );
}
