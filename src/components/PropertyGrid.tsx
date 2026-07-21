"use client";

import { useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import type { PropertyListItem } from "@/db/queries/properties";
import { imageUrl } from "@/lib/images";
import { formatPrice, bedBathCar, fmtDistance, fmtMinutes } from "@/lib/format";
import { DEFAULT_VIBE_CONFIG, loadVibeConfig, saveVibeConfig, vibeScore } from "@/lib/vibes";
import { useProfile } from "@/components/Profile";
import VibeSettings from "@/components/VibeSettings";

type NumGetter = (p: PropertyListItem) => number | null;

// Sort options. "priority" keeps the server's ranking (price near $850k + beds).
// "vibes" is handled specially (needs the configurable score), so no num getter.
const SORTS: { key: string; label: string; num?: NumGetter; dir: "asc" | "desc" }[] = [
  { key: "priority", label: "Priority (default)", dir: "asc" },
  { key: "vibes", label: "Vibes: best first", dir: "desc" },
  { key: "price-asc", label: "Price: low → high", num: (p) => p.priceNumeric, dir: "asc" },
  { key: "price-desc", label: "Price: high → low", num: (p) => p.priceNumeric, dir: "desc" },
  { key: "beds", label: "Beds: most first", num: (p) => p.beds, dir: "desc" },
  { key: "transit", label: "Transit to Flinders: fastest", num: (p) => p.ptMinutesToFlinders, dir: "asc" },
  { key: "station", label: "Train station: nearest", num: (p) => p.stationDistanceM, dir: "asc" },
  { key: "coles", label: "Coles: nearest", num: (p) => p.colesDistanceM, dir: "asc" },
  { key: "playgrounds", label: "Playgrounds ≤500m: most", num: (p) => p.playgrounds500m, dir: "desc" },
  { key: "greencross", label: "Green Cross vet: nearest", num: (p) => p.greenCrossDistanceM, dir: "asc" },
  { key: "eaves", label: "Eaves: has them first", num: (p) => p.hasEaves, dir: "desc" },
  { key: "master", label: "Master bedroom: biggest", num: (p) => p.masterBedSqm, dir: "desc" },
];

const PRICE_MIN = 400_000;
const PRICE_MAX = 1_500_000; // slider top = "no cap"
const PRICE_STEP = 25_000;
const fmtK = (n: number) => (n >= PRICE_MAX ? "any" : `$${(n / 1000).toFixed(0)}k`);

// Map-tile size overlay widths. Medium = the old 1/4 tile enlarged 50%.
const MAP_SIZES: Record<string, string> = {
  sm: "w-1/4",
  md: "w-[37.5%]",
  lg: "w-1/2",
};

// Nulls always sort last, regardless of direction.
function byNum(num: NumGetter, dir: "asc" | "desc") {
  return (a: PropertyListItem, b: PropertyListItem) => {
    const av = num(a);
    const bv = num(b);
    if (av == null && bv == null) return 0;
    if (av == null) return 1;
    if (bv == null) return -1;
    return dir === "asc" ? av - bv : bv - av;
  };
}

export default function PropertyGrid({
  properties,
}: {
  properties: PropertyListItem[];
}) {
  const router = useRouter();
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [busy, setBusy] = useState<string | null>(null);

  // Filter + sort state.
  const [sort, setSort] = useState("priority");
  const [suburb, setSuburb] = useState("");
  const [minBeds, setMinBeds] = useState(0);
  const [minBaths, setMinBaths] = useState(0);
  const [minParking, setMinParking] = useState(0);
  const [maxPrice, setMaxPrice] = useState(PRICE_MAX);
  const [idealPrice, setIdealPrice] = useState(DEFAULT_VIBE_CONFIG.idealPrice);
  const [q, setQ] = useState("");
  const [mapSize, setMapSize] = useState("md"); // off | sm | md | lg
  const [pinned, setPinned] = useState(false);
  const [scrolled, setScrolled] = useState(false);
  const [forceOpen, setForceOpen] = useState(false);

  const { profile } = useProfile();
  const fkey = `filters:${profile ?? "default"}`;

  // Task 17: load the last-used filter/sort for the active profile (or the
  // shared "default" bucket when none picked). Runs on mount and profile switch.
  useEffect(() => {
    let s: Record<string, unknown> = {};
    try {
      s = JSON.parse(localStorage.getItem(fkey) || "{}");
    } catch {
      /* ignore */
    }
    setSort(typeof s.sort === "string" ? s.sort : "priority");
    setSuburb(typeof s.suburb === "string" ? s.suburb : "");
    setMinBeds(typeof s.minBeds === "number" ? s.minBeds : 0);
    setMinBaths(typeof s.minBaths === "number" ? s.minBaths : 0);
    setMinParking(typeof s.minParking === "number" ? s.minParking : 0);
    setMaxPrice(typeof s.maxPrice === "number" ? s.maxPrice : PRICE_MAX);
    setQ(typeof s.q === "string" ? s.q : "");
    setMapSize(typeof s.mapSize === "string" ? s.mapSize : "md");
    setPinned(!!s.pinned);
    setIdealPrice(typeof s.idealPrice === "number" ? s.idealPrice : loadVibeConfig().idealPrice);
  }, [fkey]);

  // Persist on any change, keyed by profile.
  useEffect(() => {
    try {
      localStorage.setItem(
        fkey,
        JSON.stringify({ sort, suburb, minBeds, minBaths, minParking, maxPrice, idealPrice, q, mapSize, pinned }),
      );
    } catch {
      /* ignore */
    }
  }, [fkey, sort, suburb, minBeds, minBaths, minParking, maxPrice, idealPrice, q, mapSize, pinned]);

  // Task 15: once pinned, collapse the bar after the user scrolls down a little.
  useEffect(() => {
    const onScroll = () => {
      const y = window.scrollY;
      setScrolled(y > 140);
      if (y <= 140) setForceOpen(false); // back at top → reset the expand
    };
    window.addEventListener("scroll", onScroll, { passive: true });
    return () => window.removeEventListener("scroll", onScroll);
  }, []);
  const collapsed = pinned && scrolled && !forceOpen;

  const suburbs = useMemo(
    () =>
      [...new Set(properties.map((p) => p.suburb).filter(Boolean))].sort() as string[],
    [properties],
  );

  // Vibe score per property, using the live ideal-price slider (rest of the
  // config comes from localStorage / defaults).
  const vibeCfg = useMemo(() => ({ ...loadVibeConfig(), idealPrice }), [idealPrice]);
  const scoreOf = useMemo(() => {
    const m = new Map<string, number>();
    for (const p of properties) m.set(p.id, vibeScore(p, p.ratings, vibeCfg));
    return m;
  }, [properties, vibeCfg]);

  const view = useMemo(() => {
    const maxP = maxPrice >= PRICE_MAX ? null : maxPrice;
    const needle = q.trim().toLowerCase();
    let list = properties.filter((p) => {
      if (suburb && p.suburb !== suburb) return false;
      if (minBeds && (p.beds ?? 0) < minBeds) return false;
      if (minBaths && (p.baths ?? 0) < minBaths) return false;
      if (minParking && (p.parking ?? 0) < minParking) return false;
      if (maxP != null && (p.priceNumeric ?? Infinity) > maxP) return false;
      if (needle && !(p.address ?? "").toLowerCase().includes(needle)) return false;
      return true;
    });
    if (sort === "vibes") {
      list = [...list].sort((a, b) => (scoreOf.get(b.id) ?? 0) - (scoreOf.get(a.id) ?? 0));
    } else {
      const cfg = SORTS.find((s) => s.key === sort);
      if (cfg?.num) list = [...list].sort(byNum(cfg.num, cfg.dir));
    }
    return list;
  }, [properties, suburb, minBeds, minBaths, minParking, maxPrice, q, sort, scoreOf]);

  function toggle(id: string) {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else if (next.size < 4) next.add(id); // compare view caps at 4
      return next;
    });
  }

  async function remove(id: string) {
    if (!confirm("Remove this property and its images?")) return;
    setBusy(id);
    try {
      const res = await fetch(`/api/properties?id=${encodeURIComponent(id)}`, {
        method: "DELETE",
      });
      if (!res.ok) throw new Error(`delete failed (${res.status})`);
      setSelected((prev) => {
        const next = new Set(prev);
        next.delete(id);
        return next;
      });
      router.refresh();
    } catch (err) {
      alert(`Could not remove property: ${err instanceof Error ? err.message : err}`);
    } finally {
      setBusy(null);
    }
  }

  if (properties.length === 0) {
    return (
      <p className="rounded-lg border border-dashed border-neutral-300 p-8 text-center text-neutral-500 dark:border-neutral-700">
        No properties yet. Browse a Domain or realestate.com.au listing with the capture extension installed to add one.
      </p>
    );
  }

  const compareIds = [...selected];
  const selCls =
    "rounded border border-neutral-300 bg-transparent px-2 py-1 dark:border-neutral-700";

  // Only the filters the user has actually set — shown as chips when collapsed.
  const activeChips = [
    sort !== "priority" && SORTS.find((s) => s.key === sort)?.label,
    suburb || false,
    minBeds > 0 && `${minBeds}+ bd`,
    minBaths > 0 && `${minBaths}+ ba`,
    minParking > 0 && `${minParking}+ car`,
    maxPrice < PRICE_MAX && `≤ ${fmtK(maxPrice)}`,
    q.trim() && `“${q.trim()}”`,
  ].filter(Boolean) as string[];

  const pinBtn = (
    <button
      type="button"
      onClick={() => setPinned((v) => !v)}
      title={pinned ? "Unpin filters" : "Pin filters (stays at top when scrolling)"}
      aria-label={pinned ? "Unpin filters" : "Pin filters"}
      className={`rounded px-1.5 py-0.5 ${pinned ? "text-blue-600" : "text-neutral-400 hover:text-neutral-600"}`}
    >
      📌
    </button>
  );

  return (
    <>
      <div
        className={
          pinned
            ? "sticky top-0 z-20 -mx-6 border-b border-neutral-200 bg-white/95 px-6 py-2 backdrop-blur dark:border-neutral-800 dark:bg-neutral-950/95"
            : ""
        }
      >
        {collapsed ? (
          // Collapsed: slim bar of only the set filters. Capped to ~3 lines on
          // mobile so a pinned bar never eats the screen.
          <div className="flex max-h-[4.5rem] flex-wrap items-center gap-2 overflow-y-auto text-sm sm:max-h-none">
            {pinBtn}
            {activeChips.length === 0 ? (
              <span className="text-neutral-400">No filters set</span>
            ) : (
              activeChips.map((c) => (
                <span
                  key={c}
                  className="rounded-full bg-neutral-100 px-2 py-0.5 text-xs text-neutral-600 dark:bg-neutral-800 dark:text-neutral-300"
                >
                  {c}
                </span>
              ))
            )}
            <button
              type="button"
              onClick={() => setForceOpen(true)}
              className="rounded border border-neutral-300 px-2 py-0.5 text-xs hover:bg-neutral-100 dark:border-neutral-700 dark:hover:bg-neutral-800"
            >
              Filters ▾
            </button>
            <span className="ml-auto text-xs text-neutral-400">{view.length} shown</span>
          </div>
        ) : (
      <div className="flex flex-wrap items-center gap-x-4 gap-y-2 rounded-lg border border-neutral-200 p-3 text-sm dark:border-neutral-800">
        {pinBtn}
        <VibeSettings />
        <label className="flex items-center gap-1">
          Sort
          <select value={sort} onChange={(e) => setSort(e.target.value)} className={selCls}>
            {SORTS.map((s) => (
              <option key={s.key} value={s.key}>
                {s.label}
              </option>
            ))}
          </select>
        </label>
        <label className="flex items-center gap-1">
          Suburb
          <select value={suburb} onChange={(e) => setSuburb(e.target.value)} className={selCls}>
            <option value="">any</option>
            {suburbs.map((s) => (
              <option key={s} value={s}>
                {s}
              </option>
            ))}
          </select>
        </label>
        <label className="flex items-center gap-1">
          Beds ≥
          <select value={minBeds} onChange={(e) => setMinBeds(Number(e.target.value))} className={selCls}>
            {[0, 1, 2, 3, 4, 5].map((n) => (
              <option key={n} value={n}>
                {n || "any"}
              </option>
            ))}
          </select>
        </label>
        <label className="flex items-center gap-1">
          Baths ≥
          <select value={minBaths} onChange={(e) => setMinBaths(Number(e.target.value))} className={selCls}>
            {[0, 1, 2, 3, 4].map((n) => (
              <option key={n} value={n}>
                {n || "any"}
              </option>
            ))}
          </select>
        </label>
        <label className="flex items-center gap-1">
          Car ≥
          <select value={minParking} onChange={(e) => setMinParking(Number(e.target.value))} className={selCls}>
            {[0, 1, 2, 3, 4].map((n) => (
              <option key={n} value={n}>
                {n || "any"}
              </option>
            ))}
          </select>
        </label>
        <label className="flex items-center gap-1">
          Max <span className="w-10 tabular-nums text-neutral-500">{fmtK(maxPrice)}</span>
          <input
            type="range"
            min={PRICE_MIN}
            max={PRICE_MAX}
            step={PRICE_STEP}
            value={maxPrice}
            onChange={(e) => setMaxPrice(Number(e.target.value))}
            className="w-28"
          />
        </label>
        <label className="flex items-center gap-1" title="Target price used by the Vibes score">
          Ideal <span className="w-10 tabular-nums text-neutral-500">{fmtK(idealPrice)}</span>
          <input
            type="range"
            min={PRICE_MIN}
            max={PRICE_MAX}
            step={PRICE_STEP}
            value={idealPrice}
            onChange={(e) => {
              const v = Number(e.target.value);
              setIdealPrice(v);
              saveVibeConfig({ ...loadVibeConfig(), idealPrice: v });
            }}
            className="w-28"
          />
        </label>
        <label className="flex items-center gap-1">
          Address
          <input
            value={q}
            onChange={(e) => setQ(e.target.value)}
            placeholder="search…"
            className="rounded border border-neutral-300 bg-transparent px-2 py-1 dark:border-neutral-700"
          />
        </label>
        <label className="flex items-center gap-1">
          Map
          <select value={mapSize} onChange={(e) => setMapSize(e.target.value)} className={selCls}>
            <option value="off">off</option>
            <option value="sm">S</option>
            <option value="md">M</option>
            <option value="lg">L</option>
          </select>
        </label>
        <span className="ml-auto text-neutral-400">{view.length} shown</span>
      </div>
        )}
      </div>

      <div className="grid grid-cols-1 gap-4 pt-4 sm:grid-cols-2 lg:grid-cols-3">
        {view.map((p) => (
          <div
            key={p.id}
            className={`overflow-hidden rounded-lg border bg-white dark:bg-neutral-900 ${
              selected.has(p.id)
                ? "border-blue-500 ring-2 ring-blue-500/40"
                : "border-neutral-200 dark:border-neutral-800"
            }`}
          >
            <div className="relative aspect-[4/3] bg-neutral-100 dark:bg-neutral-800">
              <Link href={`/property/${p.id}`} className="block h-full w-full">
                {p.thumbPath ? (
                  // eslint-disable-next-line @next/next/no-img-element
                  <img
                    src={imageUrl({ localPath: p.thumbPath })}
                    alt={p.address ?? "property"}
                    loading="lazy"
                    className="h-full w-full object-cover"
                  />
                ) : (
                  <div className="flex h-full items-center justify-center text-sm text-neutral-400">
                    {p.scrapeStatus === "error" ? "scrape error" : "no image"}
                  </div>
                )}
              </Link>
              {mapSize !== "off" && p.latitude != null && p.longitude != null && (
                <iframe
                  title={`Map of ${p.address ?? "property"}`}
                  src={`https://maps.google.com/maps?q=${p.latitude},${p.longitude}&z=13&output=embed`}
                  loading="lazy"
                  className={`absolute bottom-1.5 right-1.5 aspect-square ${MAP_SIZES[mapSize]} rounded-md border-2 border-white bg-white shadow-md dark:border-neutral-900`}
                />
              )}
            </div>
            <div className="space-y-1 p-3">
              <div className="flex items-start justify-between gap-2">
                <span className="text-xs uppercase tracking-wide text-neutral-400">
                  {p.sourceSite}
                </span>
                <label className="flex items-center gap-1 text-xs">
                  <input
                    type="checkbox"
                    checked={selected.has(p.id)}
                    disabled={!selected.has(p.id) && selected.size >= 4}
                    onChange={() => toggle(p.id)}
                  />
                  compare
                </label>
              </div>
              <Link href={`/property/${p.id}`} className="block font-medium hover:underline">
                {p.address ?? p.listingUrl}
              </Link>
              <div className="font-semibold">
                {formatPrice(p.priceDisplay, p.priceNumeric)}
              </div>
              {p.advPricePrevious && (
                <div className="text-xs text-amber-700 dark:text-amber-500">
                  was <span className="line-through">{p.advPricePrevious}</span>
                  {p.advPricePreviousLabel
                    ? ` · ${p.advPricePreviousLabel.replace(/^Price /, "")}`
                    : ""}
                </div>
              )}
              <div className="flex items-center gap-2 text-sm text-neutral-500">
                <span>{bedBathCar(p.beds, p.baths, p.parking)} · {p.imageCount} photos</span>
                <span
                  className="ml-auto rounded-full bg-purple-100 px-2 py-0.5 text-xs font-medium text-purple-700 dark:bg-purple-900/40 dark:text-purple-300"
                  title="Vibes score (configurable)"
                >
                  ✨ {scoreOf.get(p.id) ?? 0}
                </span>
              </div>
              {p.nearestStation && (
                <div className="text-xs text-neutral-500">
                  🚉 {p.nearestStation} · {fmtDistance(p.stationDistanceM)}
                  {p.ptMinutesToFlinders != null &&
                    ` · ${fmtMinutes(p.ptMinutesToFlinders)} to Flinders St`}
                </div>
              )}
              {(p.colesDistanceM != null || p.playgrounds500m != null) && (
                <div className="text-xs text-neutral-500">
                  {p.colesDistanceM != null && `🛒 ${fmtDistance(p.colesDistanceM)}`}
                  {p.colesDistanceM != null && p.playgrounds500m != null && " · "}
                  {p.playgrounds500m != null && `🛝 ${p.playgrounds500m} ≤500m`}
                </div>
              )}
              {/* Deduced from photos (tasks 5 & 10) — omitted until harvested. */}
              {(p.hasEaves != null || p.hasLawn != null || p.masterBedSqm != null) && (
                <div className="text-xs text-neutral-500">
                  {[
                    p.hasEaves != null && (p.hasEaves ? "🏠 eaves" : "🏠 no eaves"),
                    p.hasLawn != null &&
                      (p.hasLawn ? `🌱 ${p.lawnType ?? "lawn"}` : "🌱 no lawn"),
                    p.masterBedSqm != null && `🛏 ${p.masterBedSqm} m²`,
                  ]
                    .filter(Boolean)
                    .join(" · ")}
                </div>
              )}
              <div className="flex gap-3 pt-1 text-xs text-neutral-500">
                <button
                  onClick={() => remove(p.id)}
                  disabled={busy === p.id}
                  className="text-red-600 hover:underline"
                >
                  remove
                </button>
              </div>
            </div>
          </div>
        ))}
      </div>

      {compareIds.length >= 2 && (
        <div className="sticky bottom-4 mt-4 flex justify-center">
          <Link
            href={`/compare?ids=${compareIds.join(",")}`}
            className="rounded-full bg-blue-600 px-6 py-3 text-sm font-medium text-white shadow-lg"
          >
            Compare {compareIds.length} properties →
          </Link>
        </div>
      )}
    </>
  );
}
