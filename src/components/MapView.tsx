"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import Image from "next/image";
import Link from "next/link";
import type { PropertyListItem } from "@/db/queries/properties";
import { imageUrl } from "@/lib/images";
import { formatPrice } from "@/lib/format";
import { vibeScore } from "@/lib/vibes";
import { useVibeConfig } from "@/lib/use-vibe-config";
import { TILE, project } from "@/lib/mercator";
import { useProfile } from "@/lib/profile";
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

// px of pointer movement before a pointerdown-move-up sequence counts as a
// drag rather than a click. Below this, a pin's onClick still fires — without
// it, the unavoidable few pixels of jitter in a real click would silently eat
// every pin tap once drag-to-pan existed.
const DRAG_SLOP = 6;

// One notch of a standard mouse wheel reports deltaY ~100-120; trackpads
// report many small deltaY events (often single digits) per swipe. Both are
// summed into this accumulator and consumed a whole WHEEL_STEP at a time, so
// a trackpad swipe takes several events to produce the same one zoom level a
// single mouse-wheel click produces immediately — see the wheel handler.
const WHEEL_STEP = 120;

// Popup layout. Width is fixed so horizontal clamping is a plain min/max; the
// "must fit above" threshold is a ceiling on the popup's own rendered height
// (fixed-height image + two lines of truncated text), not a measurement — see
// the placement calc below.
const POPUP_W = 208;
const POPUP_MARGIN = 8;
const POPUP_MIN_SPACE_ABOVE = 190;

interface ViewState {
  z: number;
  originX: number;
  originY: number;
}

// Fallback map centre when nothing on the page has coordinates at all, keyed
// by region so a NSW-only route (/sydney/map) doesn't fall back to Melbourne
// under its own "no coordinates" notice. Exported only so the cheap
// same-file test below can assert on it directly, without needing a fixture
// with zero geocoded NSW properties.
export const REGION_FALLBACK_CENTRE: Record<string, { lat: number; lng: number }> = {
  vic: { lat: -37.8136, lng: 144.9631 }, // Melbourne CBD
  nsw: { lat: -33.8688, lng: 151.2093 }, // Sydney CBD
};

// Guards against non-finite view state ever reaching render. A synthetic
// event with e.g. Infinity in deltaY/clientX (unreachable from real mouse or
// trackpad hardware, but reachable from a script already running in the
// page) would otherwise leak into z/originX/originY, and the tile loop's
// bounds (`Math.floor(originX / TILE) ... <= Math.floor((originX + width) /
// TILE)`) never terminate once one of those is Infinity or NaN. Checked at
// every setView call site so no future one can reintroduce the class of bug.
function isFiniteView(v: ViewState): boolean {
  return Number.isFinite(v.z) && Number.isFinite(v.originX) && Number.isFinite(v.originY);
}

export default function MapView({
  properties,
  region,
}: {
  properties: PropertyListItem[];
  region: string;
}) {
  const box = useRef<HTMLDivElement>(null);
  const [width, setWidth] = useState(1200);
  const [amen, setAmen] = useState<string[]>([]);
  const { profile } = useProfile();

  // Popup for the pin currently clicked. Id rather than the item itself so a
  // pin that drops out of `pins` (filters change while it's open) closes
  // itself for free — the lookup below just stops finding it.
  const [openPinId, setOpenPinId] = useState<string | null>(null);

  useEffect(() => {
    if (openPinId == null) return;
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") setOpenPinId(null);
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [openPinId]);

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

  // The grid's filters live in localStorage, per region ("vic" for /map,
  // "nsw" for /sydney/map) and per profile — see PropertyGrid's `fkey`. This
  // page is single-region (the `region` prop), so it restores just that
  // region's saved filters — reading FilterState-only, never writing it,
  // since there's no filter UI here.
  const [filters, setFilters] = useState<FilterState>(DEFAULT_FILTER_STATE);
  useEffect(() => {
    setFilters(loadRegionFilters(region, profile));
  }, [region, profile]);

  const pins = useMemo(() => {
    const ctx = {
      shortlistOf: (p: PropertyListItem) => p.shortlistTag,
      viewedOf: (p: PropertyListItem) => p.viewed,
      isRated: (p: PropertyListItem) => isRatedProperty(p, profile),
    };
    return filterProperties(pinsWithCoords, filters, ctx);
    // eslint-disable-next-line react-hooks/exhaustive-deps -- pinsWithCoords is
    // derived fresh from `properties` every render; including it would defeat
    // the memo. `properties` is the real dependency and is listed instead.
  }, [properties, filters, profile]);

  // Same rule as the grid: localStorage/server only after mount, never during render.
  const { cfg } = useVibeConfig();

  // Vibe score per plotted pin, and the diameter that maps it linearly onto
  // [PIN_MIN, PIN_MAX] across whatever range is actually present among them —
  // see src/lib/pin-scale.ts for the pure scale function this wraps.
  const scoreOf = useMemo(() => new Map(pins.map((p) => [p.id, vibeScore(p, p.ratings, cfg)])), [pins, cfg]);
  const pinDiameter = useMemo(() => pinDiameterScale([...scoreOf.values()]), [scoreOf]);

  // Auto-fit: largest integer zoom where every pin still fits. Filters
  // excluding every plotted property must not blank the whole map: the extent
  // falls back to the unfiltered pinsWithCoords (or a region-scoped CBD
  // centre if there's nothing geocoded at all — see REGION_FALLBACK_CENTRE),
  // so the basemap still renders and the "hidden by your filters" notice
  // below has something to point at instead of a featureless grey box.
  //
  // This recomputes on every relevant change (pins/width) rather than being
  // captured once, so a user who has never panned/zoomed keeps seeing a live
  // auto-fit — e.g. toggling a filter chip re-centres them. `view` below
  // overrides it the moment they interact.
  const autoView = useMemo((): ViewState => {
    const extentSource = pins.length > 0 ? pins : pinsWithCoords;
    // Region-scoped CBD — used only when nothing on the page has coordinates
    // at all, so there's still a sensible place to show the (pin-less)
    // basemap, keyed by `region` so /sydney/map doesn't fall back to
    // Melbourne. Falls back to the vic centre for an unrecognised region.
    const fallbackCentre = REGION_FALLBACK_CENTRE[region] ?? REGION_FALLBACK_CENTRE.vic;
    const lats = extentSource.length > 0 ? extentSource.map((p) => p.latitude!) : [fallbackCentre.lat];
    const lngs = extentSource.length > 0 ? extentSource.map((p) => p.longitude!) : [fallbackCentre.lng];
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
    z = Math.min(18, Math.max(3, z));
    const c = project(centre.lat, centre.lng, z);
    return { z, originX: c.x - width / 2, originY: c.y - HEIGHT / 2 };
  }, [pins, pinsWithCoords, width, region]);

  // Explicit user view, set the first time they drag or zoom. Null means
  // "not yet interacted" — the rendered view falls back to the live auto-fit
  // above, so the initial screen is always exactly the auto-fit. Once set, it
  // sticks: further filter/amenity changes no longer move the camera.
  const [view, setView] = useState<ViewState | null>(null);
  const effectiveView = view ?? autoView;

  // Applies a zoom step around a focal point (screen px, relative to the map
  // box) so the world point under the cursor/centre stays put — zooming
  // toward the mouse rather than snapping to the box centre. Returns null if
  // clamping at 3..18 means nothing actually changes.
  const zoomFrom = (cur: ViewState, delta: number, fx: number, fy: number): ViewState | null => {
    const z = Math.min(18, Math.max(3, cur.z + delta));
    if (z === cur.z) return null;
    const ratio = 2 ** (z - cur.z);
    return { z, originX: (cur.originX + fx) * ratio - fx, originY: (cur.originY + fy) * ratio - fy };
  };

  function zoomButton(delta: number) {
    const next = zoomFrom(effectiveView, delta, width / 2, HEIGHT / 2);
    if (next && isFiniteView(next)) setView(next);
  }

  // Drag-to-pan and its click-suppression. `dragRef` tracks the in-flight
  // gesture; `draggedRef` stays true from the moment a real drag is detected
  // until the click that follows pointerup has been swallowed, so a drag that
  // ends on a pin doesn't navigate — see the onClickCapture below.
  //
  // Pointer capture is deliberately NOT taken on pointerdown. Confirmed in a
  // real browser (headless Chromium): when capture is already active at
  // pointerup, the resulting click is dispatched to the CAPTURING element
  // (this box), not the element under the cursor — so a pin's own onClick
  // never fires, drag or not. Capture is instead taken the moment a real drag
  // is detected (in handlePointerMove, once DRAG_SLOP is crossed) and released
  // in endDrag, so a plain click never involves capture at all while a real
  // drag still gets it for the remainder of the gesture (needed so the pan
  // keeps tracking if the pointer leaves the element).
  const dragRef = useRef<{
    pointerId: number;
    startClientX: number;
    startClientY: number;
    startView: ViewState;
    captured: boolean;
  } | null>(null);
  const draggedRef = useRef(false);

  function handlePointerDown(e: React.PointerEvent<HTMLDivElement>) {
    if (e.pointerType === "mouse" && e.button !== 0) return; // left button / primary touch only
    // A new gesture must not inherit suppression armed by a previous drag
    // that produced no click of its own to clear it on (e.g. it ended via
    // pointercancel rather than a click-producing pointerup) — otherwise the
    // very next genuine click gets silently swallowed.
    draggedRef.current = false;
    dragRef.current = {
      pointerId: e.pointerId,
      startClientX: e.clientX,
      startClientY: e.clientY,
      startView: effectiveView,
      captured: false,
    };
  }

  function handlePointerMove(e: React.PointerEvent<HTMLDivElement>) {
    const d = dragRef.current;
    if (!d || d.pointerId !== e.pointerId) return;
    // A synthetic pointermove with a non-finite clientX/clientY (unreachable
    // from real hardware) would otherwise produce a non-finite dx/dy below,
    // and from there a non-finite originX/originY that hangs the tile loop.
    if (!Number.isFinite(e.clientX) || !Number.isFinite(e.clientY)) return;
    const dx = e.clientX - d.startClientX;
    const dy = e.clientY - d.startClientY;
    // Below DRAG_SLOP this is still "a click that wobbled a couple of
    // pixels", not a pan — don't move the map or arm the click suppression.
    if (!draggedRef.current && Math.hypot(dx, dy) < DRAG_SLOP) return;
    if (!d.captured) {
      d.captured = true;
      e.currentTarget.setPointerCapture(e.pointerId);
    }
    draggedRef.current = true;
    const next = { z: d.startView.z, originX: d.startView.originX - dx, originY: d.startView.originY - dy };
    if (isFiniteView(next)) setView(next);
  }

  function endDrag(e: React.PointerEvent<HTMLDivElement>) {
    const d = dragRef.current;
    if (!d || d.pointerId !== e.pointerId) return;
    if (d.captured) e.currentTarget.releasePointerCapture(e.pointerId);
    dragRef.current = null;
    // draggedRef is deliberately left set — the click event this pointerup
    // produces (if any) still needs to be swallowed by onClickCapture below.
  }

  // Runs before any pin's onClick (capture fires root-to-target, ahead of the
  // pin's own bubble-phase handler) and stops the click outright when it's
  // the tail end of a drag, regardless of which element it lands on.
  function handleClickCapture(e: React.MouseEvent<HTMLDivElement>) {
    if (draggedRef.current) {
      e.preventDefault();
      e.stopPropagation();
      draggedRef.current = false;
    }
  }

  // Wheel-zoom needs `e.preventDefault()` to stop the page scrolling under
  // the cursor while zooming, and React's onWheel listeners are attached
  // passive — preventDefault there is a silent no-op. A native listener with
  // `{ passive: false }` is the only way to actually block it. A ref (rather
  // than an effect dep) keeps the listener attached once for the component's
  // life while still always reading the latest view instead of a stale one.
  const effectiveViewRef = useRef(effectiveView);
  effectiveViewRef.current = effectiveView;
  const wheelAccum = useRef(0);

  useEffect(() => {
    const el = box.current;
    if (!el) return;
    function onWheel(e: WheelEvent) {
      e.preventDefault();
      // A synthetic wheel event with a non-finite deltaY (unreachable from
      // real mouse/trackpad hardware) would otherwise loop forever below —
      // `Infinity - WHEEL_STEP === Infinity` in IEEE-754 arithmetic, so the
      // while loop's terminating condition never becomes false and the
      // page's script thread hangs until the tab is force-closed.
      if (!Number.isFinite(e.deltaY)) return;
      const cur = effectiveViewRef.current;
      const rect = el!.getBoundingClientRect();
      // Normalise: deltaMode 0 (pixel — most mice and trackpads) is used as
      // reported; 1 (line, occasionally Firefox) and 2 (page) are converted
      // to an approximate pixel equivalent so both scale the same accumulator.
      const unit = e.deltaMode === 1 ? 16 : e.deltaMode === 2 ? rect.height : 1;
      wheelAccum.current += e.deltaY * unit;
      // A physical mouse-wheel notch reports ~100-120 in deltaY and crosses
      // WHEEL_STEP in one event; a trackpad reports many small deltas (often
      // single digits) per swipe that accumulate to the same step over a few
      // events — this is the "don't assume one notch per event" normalisation.
      let steps = 0;
      while (wheelAccum.current >= WHEEL_STEP) {
        steps -= 1;
        wheelAccum.current -= WHEEL_STEP;
      }
      while (wheelAccum.current <= -WHEEL_STEP) {
        steps += 1;
        wheelAccum.current += WHEEL_STEP;
      }
      if (steps === 0) return;
      const fx = e.clientX - rect.left;
      const fy = e.clientY - rect.top;
      const next = zoomFrom(cur, steps, fx, fy);
      if (next && isFiniteView(next)) setView(next);
    }
    el.addEventListener("wheel", onWheel, { passive: false });
    return () => el.removeEventListener("wheel", onWheel);
    // zoomFrom is a plain function recreated each render but has no state of
    // its own beyond its arguments — safe to omit, and refs carry the rest.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const tiles = useMemo(() => {
    const { z, originX, originY } = effectiveView;
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
  }, [effectiveView, width]);

  function toggleAmen(key: string) {
    setAmen((prev) => (prev.includes(key) ? prev.filter((k) => k !== key) : [...prev, key]));
  }
  const matches = (p: PropertyListItem) =>
    amen.every((k) => AMENITIES.find((a) => a.key === k)?.ok(p));

  // Screen position + sizing for a pin, shared by the pin button and the
  // popup anchor below so the two can never drift apart.
  function pinScreenPos(p: PropertyListItem) {
    const px = project(p.latitude!, p.longitude!, effectiveView.z);
    const score = scoreOf.get(p.id) ?? 0;
    const d = pinDiameter(score);
    const hit = Math.max(d, PIN_HIT_MIN);
    return { x: px.x - effectiveView.originX, y: px.y - effectiveView.originY, d, hit, score };
  }

  // Popup follows the open pin through pan/zoom rather than closing: its
  // position is recomputed from `pins`/`effectiveView` on every render just
  // like a pin's own position, so there's no extra logic to keep it in sync.
  const openPin = pins.find((p) => p.id === openPinId);
  const anchor = openPin ? pinScreenPos(openPin) : null;
  // Accessible name for the popup's navigate link — computed once here rather than inline so
  // the JSX attribute stays within the line-length limit.
  const popupLabel = openPin
    ? `${openPin.address ?? "Property"} — ${formatPrice(openPin.priceDisplay, openPin.priceNumeric)}`
    : "";
  let popupLeft = 0;
  let popupTop = 0;
  let popupAbove = false;
  if (anchor) {
    const rawLeft = anchor.x - POPUP_W / 2;
    popupLeft = Math.min(Math.max(rawLeft, POPUP_MARGIN), width - POPUP_W - POPUP_MARGIN);
    popupAbove = anchor.y - anchor.hit / 2 >= POPUP_MIN_SPACE_ABOVE + POPUP_MARGIN;
    popupTop = popupAbove
      ? anchor.y - anchor.hit / 2 - POPUP_MARGIN
      : anchor.y + anchor.hit / 2 + POPUP_MARGIN;
  }

  return (
    <section className="rise space-y-4">
      <div className="flex flex-wrap items-end justify-between gap-4">
        <div>
          <div className="eyebrow mb-1.5">Where they are</div>
          <h1 className="font-serif text-[38px] leading-none">Map view</h1>
        </div>
        <div className="flex items-center gap-2">
          <button onClick={() => zoomButton(-1)} className="chip" aria-label="Zoom out">
            −
          </button>
          <button onClick={() => zoomButton(1)} className="chip" aria-label="Zoom in">
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
        className="relative touch-none overflow-hidden rounded-[18px] border border-line bg-fill"
        style={{ height: HEIGHT }}
        onPointerDown={handlePointerDown}
        onPointerMove={handlePointerMove}
        onPointerUp={endDrag}
        onPointerCancel={endDrag}
        onClickCapture={handleClickCapture}
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

        {pins.map((p) => {
          const { x, y, d, hit, score } = pinScreenPos(p);
          const on = matches(p);
          return (
            <button
              key={p.id}
              data-testid="map-pin"
              onClick={() => setOpenPinId(p.id)}
              title={`${p.address ?? "Property"} — ${formatPrice(p.priceDisplay, p.priceNumeric)} · vibe ${score}`}
              className="absolute flex -translate-x-1/2 -translate-y-1/2 items-center justify-center
                transition-opacity"
              style={{
                left: x,
                top: y,
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

        {openPin && anchor && (
          <div
            data-testid="map-pin-popup"
            className="absolute z-10 w-52 overflow-hidden rounded-xl border
              border-line bg-white shadow-lg"
            style={{ left: popupLeft, top: popupTop, transform: popupAbove ? "translateY(-100%)" : undefined }}
          >
            <button
              onClick={() => setOpenPinId(null)}
              aria-label="Close"
              className="absolute right-1 top-1 z-10 rounded bg-white/80 px-1.5 text-xs
                text-mute hover:text-forest"
            >
              ✕
            </button>
            {/* The popup's only navigate surface: a real anchor, not the div above, so Tab
                reaches it and Enter/Space activate it — a bare onClick on a div does neither.
                aria-label carries the accessible name (address + price); the image is
                decorative here since that name already says what the link goes to. */}
            <Link
              href={`/property/${openPin.id}`}
              aria-label={popupLabel}
              className="block focus-visible:outline focus-visible:outline-2
                focus-visible:-outline-offset-2 focus-visible:outline-forest"
            >
              <div className="relative h-28 bg-fill">
                {openPin.thumbPath ? (
                  <Image
                    src={imageUrl({ localPath: openPin.thumbPath })}
                    alt=""
                    fill
                    sizes={`${POPUP_W}px`}
                    className="object-cover"
                  />
                ) : (
                  <div className="flex h-full items-center justify-center text-xs text-mute">no image</div>
                )}
              </div>
              <div className="space-y-0.5 p-2">
                <p className="truncate text-sm font-medium">{openPin.address ?? "Property"}</p>
                <p className="text-sm text-mute">{formatPrice(openPin.priceDisplay, openPin.priceNumeric)}</p>
              </div>
            </Link>
          </div>
        )}

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
