"use client";

import { useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import type { PropertyListItem } from "@/db/queries/properties";
import { imageUrl } from "@/lib/images";
import { formatPrice, fmtDistance, fmtMinutes, isTransitEstimated } from "@/lib/format";
import { formatInspection } from "@/lib/inspection";
import { DEFAULT_VIBE_CONFIG, loadVibeConfig, saveVibeConfig, vibeScore } from "@/lib/vibes";
import { SHORTLIST_TAGS, useProfile } from "@/lib/profile";
import MultiSelect from "./MultiSelect";

type NumGetter = (p: PropertyListItem) => number | null;

// Sort options. "priority" keeps the server's ranking (price near $850k + beds).
// "vibes" is handled specially (needs the configurable score), so no num getter.
const SORTS: { key: string; label: string; num?: NumGetter; dir: "asc" | "desc" }[] = [
  { key: "vibes", label: "Vibes: best first (default)", dir: "desc" },
  { key: "priority", label: "Priority", dir: "asc" },
  { key: "score", label: "Your score: best first", dir: "desc" },
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

// Vibe rating buttons shown on each tile (mirror RatingControls' VIBE row).
const VIBE_OPTS = [
  { v: "like", emoji: "😍", label: "Like" },
  { v: "meh", emoji: "😐", label: "Meh" },
  { v: "dislike", emoji: "🙁", label: "Dislike" },
  { v: "hate", emoji: "🤮", label: "Hate" },
] as const;

// Map-tile size overlay widths. Medium = the old 1/4 tile enlarged 50%.
const MAP_SIZES: Record<string, string> = {
  sm: "w-1/4",
  md: "w-[37.5%]",
  lg: "w-1/2",
};

// Sale status is only in the free-text price_display (no dedicated column).
const isAuction = (p: PropertyListItem) => /auction/i.test(p.priceDisplay ?? "");
const isUnderOffer = (p: PropertyListItem) =>
  /under\s*offer|under\s*contract/i.test(p.priceDisplay ?? "");

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

  // Filter + sort state. Vibes score is the default ranking.
  const [sort, setSort] = useState("vibes");
  const [suburb, setSuburb] = useState<string[]>([]);
  const [minBeds, setMinBeds] = useState(0);
  const [minBaths, setMinBaths] = useState(0);
  const [minParking, setMinParking] = useState(0);
  const [maxPrice, setMaxPrice] = useState(PRICE_MAX);
  const [idealPrice, setIdealPrice] = useState(DEFAULT_VIBE_CONFIG.idealPrice);
  const [q, setQ] = useState("");
  const [mapSize, setMapSize] = useState("sm"); // off | sm | md | lg
  const [layout, setLayout] = useState("gallery"); // gallery | compact | list
  const [tagFilter, setTagFilter] = useState(""); // "" = all
  const [hideAuction, setHideAuction] = useState(false);
  const [hideUnderOffer, setHideUnderOffer] = useState(false);
  // Task 15: pin the filter bar to the top, collapse it to chips on scroll.
  const [pinned, setPinned] = useState(false);
  const [scrolled, setScrolled] = useState(false);
  const [forceOpen, setForceOpen] = useState(false);
  const { profile } = useProfile();

  // Filter/sort state persists per profile (task 17); "default" bucket when none.
  const fkey = `filters:${profile ?? "default"}`;

  // Hydrate the saved vibe-weight config after mount. Reading localStorage
  // DURING a render makes the client markup disagree with the server's and
  // React throws a hydration error, so the config lives in state.
  const [savedCfg, setSavedCfg] = useState(DEFAULT_VIBE_CONFIG);
  useEffect(() => setSavedCfg(loadVibeConfig()), []);

  // Load the last-used filter/sort for the active profile, on mount + switch.
  useEffect(() => {
    let s: Record<string, unknown> = {};
    try {
      s = JSON.parse(localStorage.getItem(fkey) || "{}");
    } catch {
      /* ignore */
    }
    setSort(typeof s.sort === "string" ? s.sort : "vibes");
    // Back-compat: old saved value was a single suburb string.
    setSuburb(
      Array.isArray(s.suburb)
        ? (s.suburb as string[])
        : typeof s.suburb === "string" && s.suburb
          ? [s.suburb]
          : [],
    );
    setMinBeds(typeof s.minBeds === "number" ? s.minBeds : 0);
    setMinBaths(typeof s.minBaths === "number" ? s.minBaths : 0);
    setMinParking(typeof s.minParking === "number" ? s.minParking : 0);
    setMaxPrice(typeof s.maxPrice === "number" ? s.maxPrice : PRICE_MAX);
    setQ(typeof s.q === "string" ? s.q : "");
    setMapSize(typeof s.mapSize === "string" ? s.mapSize : "sm");
    setLayout(typeof s.layout === "string" ? s.layout : "gallery");
    setTagFilter(typeof s.tagFilter === "string" ? s.tagFilter : "");
    setHideAuction(!!s.hideAuction);
    setHideUnderOffer(!!s.hideUnderOffer);
    setPinned(!!s.pinned);
    setIdealPrice(typeof s.idealPrice === "number" ? s.idealPrice : loadVibeConfig().idealPrice);
  }, [fkey]);

  // Persist on any change, keyed by profile.
  useEffect(() => {
    try {
      localStorage.setItem(
        fkey,
        JSON.stringify({ sort, suburb, minBeds, minBaths, minParking, maxPrice, idealPrice, q, mapSize, layout, tagFilter, hideAuction, hideUnderOffer, pinned }),
      );
    } catch {
      /* ignore */
    }
  }, [fkey, sort, suburb, minBeds, minBaths, minParking, maxPrice, idealPrice, q, mapSize, layout, tagFilter, hideAuction, hideUnderOffer, pinned]);

  // Once pinned, collapse the bar after the user scrolls down a little.
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
  const vibeCfg = useMemo(() => ({ ...savedCfg, idealPrice }), [savedCfg, idealPrice]);
  const scoreOf = useMemo(() => {
    const m = new Map<string, number>();
    for (const p of properties) m.set(p.id, vibeScore(p, p.ratings, vibeCfg));
    return m;
  }, [properties, vibeCfg]);

  // Your own 0–10 score, from the active profile's rating row.
  const myScore = (p: PropertyListItem) =>
    p.ratings.find((r) => r.profile === profile)?.score ?? null;

  const view = useMemo(() => {
    const maxP = maxPrice >= PRICE_MAX ? null : maxPrice;
    const needle = q.trim().toLowerCase();
    let list = properties.filter((p) => {
      if (tagFilter && p.shortlistTag !== tagFilter) return false;
      if (suburb.length && (!p.suburb || !suburb.includes(p.suburb))) return false;
      if (minBeds && (p.beds ?? 0) < minBeds) return false;
      if (minBaths && (p.baths ?? 0) < minBaths) return false;
      if (minParking && (p.parking ?? 0) < minParking) return false;
      if (maxP != null && (p.priceNumeric ?? Infinity) > maxP) return false;
      if (needle && !(p.address ?? "").toLowerCase().includes(needle)) return false;
      if (hideAuction && isAuction(p)) return false;
      if (hideUnderOffer && isUnderOffer(p)) return false;
      return true;
    });
    if (sort === "vibes") {
      list = [...list].sort((a, b) => (scoreOf.get(b.id) ?? 0) - (scoreOf.get(a.id) ?? 0));
    } else if (sort === "score") {
      list = [...list].sort(byNum(myScore, "desc"));
    } else {
      const cfg = SORTS.find((s) => s.key === sort);
      if (cfg?.num) list = [...list].sort(byNum(cfg.num, cfg.dir));
    }
    return list;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [properties, suburb, minBeds, minBaths, minParking, maxPrice, q, sort, scoreOf, tagFilter, hideAuction, hideUnderOffer, profile]);

  function toggle(id: string) {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else if (next.size < 4) next.add(id); // compare view caps at 4
      return next;
    });
  }

  // Rate a property's "vibe" for the active profile straight from its tile.
  // Clicking the current choice again clears it. Feeds the Vibes score.
  async function setVibe(id: string, current: string | null, v: string) {
    if (!profile || busy) return;
    const next = current === v ? "" : v;
    setBusy(id);
    try {
      await fetch(`/api/properties/${id}/rating`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ profile, vibe: next }),
      });
      router.refresh();
    } finally {
      setBusy(null);
    }
  }

  if (properties.length === 0) {
    return (
      <p className="rounded-2xl border border-dashed border-line bg-paper p-16 text-center text-mute">
        No properties yet. Browse a Domain or realestate.com.au listing with the
        capture extension installed to add one.
      </p>
    );
  }

  const compareIds = [...selected];

  // Only the filters the user has actually set — shown as chips when collapsed.
  const activeChips = [
    sort !== "vibes" && SORTS.find((s) => s.key === sort)?.label,
    suburb.length > 0 && (suburb.length <= 2 ? suburb.join(", ") : `${suburb.length} suburbs`),
    minBeds > 0 && `${minBeds}+ bd`,
    minBaths > 0 && `${minBaths}+ ba`,
    minParking > 0 && `${minParking}+ car`,
    maxPrice < PRICE_MAX && `≤ ${fmtK(maxPrice)}`,
    tagFilter && SHORTLIST_TAGS.find((t) => t.id === tagFilter)?.label,
    hideUnderOffer && "no under-offer",
    hideAuction && "no auction",
    q.trim() && `“${q.trim()}”`,
  ].filter(Boolean) as string[];

  const pinBtn = (
    <button
      type="button"
      onClick={() => setPinned((v) => !v)}
      title={pinned ? "Unpin filters" : "Pin filters (stays at top when scrolling)"}
      aria-label={pinned ? "Unpin filters" : "Pin filters"}
      className={`rounded px-1.5 py-0.5 ${pinned ? "text-forest" : "text-mute hover:text-body"}`}
    >
      📌
    </button>
  );

  return (
    <>
      <div className="mb-6 flex items-end justify-between gap-6">
        <div>
          <h1 className="font-serif text-[40px] leading-none">Tracked properties</h1>
        </div>
        <div className="pb-1 text-right">
          <div className="font-serif text-[34px] leading-none">
            {view.length}
            <span className="text-base text-mute"> / {properties.length}</span>
          </div>
          <div className="text-xs tracking-wide text-mute">shown</div>
        </div>
      </div>

      <div
        className={
          pinned
            ? "sticky top-0 z-20 -mx-8 mb-7 border-b border-line bg-linen/95 px-8 py-3 backdrop-blur"
            : "mb-7"
        }
      >
        {collapsed ? (
          // Collapsed: slim bar of only the set filters, with a re-expand.
          <div className="flex max-h-[4.5rem] flex-wrap items-center gap-2 overflow-y-auto text-sm sm:max-h-none">
            {pinBtn}
            {activeChips.length === 0 ? (
              <span className="text-mute">No filters set</span>
            ) : (
              activeChips.map((c) => (
                <span key={c} className="rounded-full bg-hairline px-2.5 py-1 text-xs text-body">
                  {c}
                </span>
              ))
            )}
            <button
              type="button"
              onClick={() => setForceOpen(true)}
              className="rounded border border-line px-2 py-0.5 text-xs hover:bg-paper"
            >
              Filters ▾
            </button>
            <span className="ml-auto text-xs text-mute">{view.length} shown</span>
          </div>
        ) : (
      <div className="flex flex-wrap items-center gap-x-5 gap-y-3.5 rounded-2xl border border-line bg-paper p-4 shadow-[0_1px_2px_rgba(0,0,0,.03)]">
        {pinBtn}
        <label className="label-cap flex w-full items-center gap-2 sm:w-auto">
          <span className="w-16 shrink-0 sm:w-auto">Sort</span>
          <select value={sort} onChange={(e) => setSort(e.target.value)} className="field min-w-0 flex-1 sm:flex-none">
            {SORTS.map((s) => (
              <option key={s.key} value={s.key}>
                {s.label}
              </option>
            ))}
          </select>
        </label>
        <div className="label-cap flex w-full items-center gap-2 sm:w-auto">
          <span className="w-16 shrink-0 sm:w-auto">Suburb</span>
          <MultiSelect options={suburbs} value={suburb} onChange={setSuburb} />
        </div>
        <label className="label-cap flex w-full items-center gap-2 sm:w-auto">
          <span className="w-16 shrink-0 sm:w-auto">Beds ≥</span>
          <select value={minBeds} onChange={(e) => setMinBeds(Number(e.target.value))} className="field min-w-0 flex-1 sm:flex-none">
            {[0, 1, 2, 3, 4, 5].map((n) => (
              <option key={n} value={n}>
                {n || "any"}
              </option>
            ))}
          </select>
        </label>
        <label className="label-cap flex w-full items-center gap-2 sm:w-auto">
          <span className="w-16 shrink-0 sm:w-auto">Baths ≥</span>
          <select value={minBaths} onChange={(e) => setMinBaths(Number(e.target.value))} className="field min-w-0 flex-1 sm:flex-none">
            {[0, 1, 2, 3, 4].map((n) => (
              <option key={n} value={n}>
                {n || "any"}
              </option>
            ))}
          </select>
        </label>
        <label className="label-cap flex w-full items-center gap-2 sm:w-auto">
          <span className="w-16 shrink-0 sm:w-auto">Car ≥</span>
          <select value={minParking} onChange={(e) => setMinParking(Number(e.target.value))} className="field min-w-0 flex-1 sm:flex-none">
            {[0, 1, 2, 3, 4].map((n) => (
              <option key={n} value={n}>
                {n || "any"}
              </option>
            ))}
          </select>
        </label>
        <div className="hidden h-6 w-px bg-line sm:block" />
        <label className="label-cap flex w-full items-center gap-2 sm:w-auto">
          <span className="w-16 shrink-0 sm:w-auto">Max</span>
          <span className="w-10 tabular-nums text-body sm:mr-1">{fmtK(maxPrice)}</span>
          <input
            type="range"
            min={PRICE_MIN}
            max={PRICE_MAX}
            step={PRICE_STEP}
            value={maxPrice}
            onChange={(e) => setMaxPrice(Number(e.target.value))}
            className="min-w-0 flex-1 accent-[#1F4A3A] sm:w-28 sm:flex-none"
          />
        </label>
        <label
          className="label-cap flex w-full items-center gap-2 sm:w-auto"
          title="Target price used by the Vibes score"
        >
          <span className="w-16 shrink-0 sm:w-auto">Ideal</span>
          <span className="w-10 tabular-nums text-body sm:mr-1">{fmtK(idealPrice)}</span>
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
            className="min-w-0 flex-1 accent-[#B9762A] sm:w-28 sm:flex-none"
          />
        </label>
        <div className="hidden h-6 w-px bg-line sm:block" />
        <div className="flex w-full flex-col gap-2 sm:w-auto sm:flex-row sm:items-center">
          <span className="label-cap">Shortlist</span>
          <div className="flex flex-nowrap items-center gap-2">
            {SHORTLIST_TAGS.map((t) => {
              const on = tagFilter === t.id;
              return (
                <button
                  key={t.id}
                  onClick={() => setTagFilter(on ? "" : t.id)}
                  className={`chip whitespace-nowrap ${on ? "chip-on" : "hover:border-forest"}`}
                >
                  <span
                    className="h-[7px] w-[7px] shrink-0 rounded-full"
                    style={{ background: on ? "#fff" : t.colour }}
                  />
                  {t.label}
                </button>
              );
            })}
          </div>
        </div>
        <div className="hidden h-6 w-px bg-line sm:block" />
        <div className="flex w-full flex-wrap items-center gap-2 sm:w-auto">
          <span className="label-cap">Hide</span>
          <button
            onClick={() => setHideUnderOffer((v) => !v)}
            className={`chip ${hideUnderOffer ? "chip-on" : "hover:border-forest"}`}
          >
            Under offer
          </button>
          <button
            onClick={() => setHideAuction((v) => !v)}
            className={`chip ${hideAuction ? "chip-on" : "hover:border-forest"}`}
          >
            Auction
          </button>
        </div>
        <div className="flex w-full flex-wrap items-center gap-2 sm:ml-auto sm:w-auto sm:flex-nowrap">
          <div className="flex rounded-[10px] border border-line bg-hairline p-[3px]">
            {[
              ["gallery", "Gallery"],
              ["compact", "Compact"],
              ["list", "List"],
            ].map(([l, label]) => (
              <button
                key={l}
                onClick={() => setLayout(l)}
                className={`rounded-[7px] px-3 py-1.5 text-[12.5px] font-semibold ${
                  layout === l ? "bg-white text-forest shadow-sm" : "text-mute"
                }`}
              >
                {label}
              </button>
            ))}
          </div>
          <input
            value={q}
            onChange={(e) => setQ(e.target.value)}
            placeholder="Search address…"
            className="field w-full min-w-0 font-normal placeholder:text-soft sm:w-44 sm:flex-none"
          />
          <label className="label-cap flex w-full items-center gap-2 sm:w-auto">
            <span className="w-16 shrink-0 sm:w-auto">Map</span>
            <select value={mapSize} onChange={(e) => setMapSize(e.target.value)} className="field min-w-0 flex-1 sm:flex-none">
              <option value="off">off</option>
              <option value="sm">S</option>
              <option value="md">M</option>
              <option value="lg">L</option>
            </select>
          </label>
        </div>
      </div>
        )}
      </div>

      {layout === "list" ? (
        <div className="overflow-hidden rounded-2xl border border-line bg-white">
          {view.map((p) => {
            const isSel = selected.has(p.id);
            const tag = SHORTLIST_TAGS.find((t) => t.id === p.shortlistTag);
            const isNew = Date.now() - new Date(p.createdAt).getTime() < 7 * 86400_000;
            const inspect = formatInspection(p.nextInspection);
            return (
              <div
                key={p.id}
                className="flex items-center gap-4 border-b border-hairline px-4 py-3 last:border-0"
              >
                <div className="h-[70px] w-24 shrink-0 overflow-hidden rounded-[10px] bg-fill">
                  {p.thumbPath && (
                    // eslint-disable-next-line @next/next/no-img-element
                    <img
                      src={imageUrl({ localPath: p.thumbPath })}
                      alt={p.address ?? "property"}
                      loading="lazy"
                      className={`h-full w-full object-cover ${
                        p.delisted ? "opacity-60 grayscale" : ""
                      }`}
                    />
                  )}
                </div>
                <span className="flex h-[34px] w-[34px] shrink-0 items-center justify-center rounded-[9px] bg-amber font-serif text-base text-white">
                  {scoreOf.get(p.id) ?? 0}
                </span>
                <Link href={`/property/${p.id}`} className="min-w-0 flex-[1.4]">
                  <span className="flex items-center gap-2">
                    <span className="truncate font-serif text-lg">
                      {p.address ?? p.listingUrl}
                    </span>
                    {tag && (
                      <span
                        className="shrink-0 rounded px-1.5 py-0.5 text-[10px] font-bold text-white"
                        style={{ background: tag.colour }}
                      >
                        {tag.label}
                      </span>
                    )}
                    {p.delisted && (
                      <span className="shrink-0 rounded bg-[#B84A3A] px-1.5 py-0.5 text-[10px] font-bold uppercase text-white">
                        {p.saleStatus === "sold"
                          ? "Sold"
                          : p.saleStatus === "withdrawn"
                            ? "Withdrawn"
                            : "Off-market"}
                      </span>
                    )}
                    {isNew && !p.delisted && (
                      <span className="shrink-0 rounded bg-forest px-1.5 py-0.5 text-[10px] font-bold uppercase text-white">
                        New
                      </span>
                    )}
                  </span>
                  <span className="flex items-center gap-2 text-xs text-mute">
                    {p.suburb ?? "—"}
                    {inspect?.upcoming && (
                      <span className="font-semibold text-forest">📅 {inspect.label}</span>
                    )}
                  </span>
                </Link>
                <span className="flex-1 text-sm font-semibold text-forest">
                  {formatPrice(p.priceDisplay, p.priceNumeric)}
                </span>
                <span className="flex-1 text-[13px] text-body">
                  {p.beds ?? "—"} bd · {p.baths ?? "—"} ba · {p.parking ?? "—"} car
                </span>
                <span className="flex-[1.3] truncate text-[12.5px] text-[#5B5A52]">
                  {p.nearestStation
                    ? `${p.nearestStation} · ${fmtDistance(p.stationDistanceM)}`
                    : "—"}
                </span>
                <span className="flex-[0.8] text-[12.5px] text-[#5B5A52]">
                  {fmtMinutes(p.ptMinutesToFlinders)}
                  {isTransitEstimated(p.ptSteps) && (
                    <span title="Estimated from the nearest tracked property">*</span>
                  )}
                </span>
                <button
                  onClick={() => toggle(p.id)}
                  disabled={!isSel && selected.size >= 4}
                  className={`shrink-0 rounded-[9px] px-3 py-1.5 text-xs font-bold disabled:opacity-40 ${
                    isSel ? "bg-forest text-linen" : "border border-line bg-white text-forest"
                  }`}
                >
                  {isSel ? "✓ Added" : "Compare"}
                </button>
              </div>
            );
          })}
        </div>
      ) : (
      <div
        className={`grid grid-cols-1 gap-5 sm:grid-cols-2 ${
          layout === "compact" ? "lg:grid-cols-4" : "lg:grid-cols-3"
        }`}
      >
        {view.map((p) => {
          const isSel = selected.has(p.id);
          const tag = SHORTLIST_TAGS.find((t) => t.id === p.shortlistTag);
          const isNew = Date.now() - new Date(p.createdAt).getTime() < 7 * 86400_000;
          const inspect = formatInspection(p.nextInspection);
          return (
            <article
              key={p.id}
              className={`overflow-hidden rounded-2xl border bg-white shadow-[0_1px_3px_rgba(0,0,0,.05)] transition-shadow hover:shadow-[0_6px_20px_rgba(0,0,0,.08)] ${
                isSel ? "border-forest" : "border-line"
              }`}
            >
              <div
                className={`relative bg-fill ${
                  layout === "compact" ? "h-[188px]" : "h-[263px]"
                }`}
              >
                <Link href={`/property/${p.id}`} className="block h-full w-full">
                  {p.thumbPath ? (
                    // eslint-disable-next-line @next/next/no-img-element
                    <img
                      src={imageUrl({ localPath: p.thumbPath })}
                      alt={p.address ?? "property"}
                      loading="lazy"
                      className={`h-full w-full object-cover ${
                        p.delisted ? "opacity-60 grayscale" : ""
                      }`}
                    />
                  ) : (
                    <div className="flex h-full items-center justify-center text-sm text-mute">
                      {p.scrapeStatus === "error" ? "scrape error" : "no image"}
                    </div>
                  )}
                </Link>
                <div className="pointer-events-none absolute inset-0 bg-[linear-gradient(to_bottom,rgba(0,0,0,.18),transparent_30%,transparent_60%,rgba(0,0,0,.28))]">
                  <div className="absolute left-2.5 top-2.5 flex items-center gap-1.5">
                    <span className="rounded-md bg-[rgba(28,28,25,.72)] px-2 py-1 text-[10.5px] font-semibold uppercase tracking-wide text-white">
                      {p.sourceSite}
                    </span>
                    {tag && (
                      <span
                        className="rounded-md px-2 py-1 text-[10.5px] font-bold text-white"
                        style={{ background: tag.colour }}
                      >
                        {tag.label}
                      </span>
                    )}
                    {p.delisted && (
                      <span className="rounded-md bg-[#B84A3A] px-2 py-1 text-[10.5px] font-bold uppercase tracking-wide text-white">
                        {p.saleStatus === "sold"
                          ? "Sold"
                          : p.saleStatus === "withdrawn"
                            ? "Withdrawn"
                            : "No longer listed"}
                      </span>
                    )}
                    {isNew && !p.delisted && (
                      <span className="rounded-md bg-forest px-2 py-1 text-[10.5px] font-bold uppercase tracking-wide text-white">
                        New
                      </span>
                    )}
                  </div>
                  <span className="absolute right-2.5 top-2.5 rounded-md bg-[rgba(28,28,25,.72)] px-2 py-1 text-[10.5px] font-semibold text-white">
                    {p.imageCount} photos
                  </span>
                  <div className="absolute bottom-2.5 left-2.5 flex items-center gap-2">
                    <span
                      title="Vibes score (configurable)"
                      className="flex items-center gap-1.5 rounded-[9px] bg-amber px-2.5 py-1 text-white shadow-[0_2px_8px_rgba(185,118,42,.4)]"
                    >
                      <span className="text-xs">✨</span>
                      <span className="font-serif text-lg leading-none">
                        {scoreOf.get(p.id) ?? 0}
                      </span>
                    </span>
                    <span className="text-[10px] uppercase tracking-widest text-white/85">
                      vibes
                    </span>
                  </div>
                </div>
                {mapSize !== "off" && p.latitude != null && p.longitude != null && (
                  <iframe
                    title={`Map of ${p.address ?? "property"}`}
                    src={`https://maps.google.com/maps?q=${p.latitude},${p.longitude}&z=13&output=embed`}
                    loading="lazy"
                    // pointer-events-none: it's just a preview and would otherwise
                    // swallow clicks meant for the card.
                    className={`pointer-events-none absolute -bottom-3 right-1.5 aspect-square ${MAP_SIZES[mapSize]} rounded-md border-2 border-white bg-white shadow-md`}
                  />
                )}
              </div>

              <div className="p-4">
                <Link href={`/property/${p.id}`} className="block">
                  <h3 className="mb-1 font-serif text-[21px] leading-tight">
                    {p.address ?? p.listingUrl}
                  </h3>
                </Link>
                <div className="mb-2.5 flex flex-wrap items-baseline gap-2.5">
                  <span className="font-semibold text-forest">
                    {formatPrice(p.priceDisplay, p.priceNumeric)}
                  </span>
                  {p.advPricePrevious && (
                    <span className="text-[11.5px] text-[#a05a2c]">
                      was <span className="line-through">{p.advPricePrevious}</span>
                      {p.advPricePreviousLabel
                        ? ` · ${p.advPricePreviousLabel.replace(/^Price /, "")}`
                        : ""}
                    </span>
                  )}
                </div>
                {inspect?.upcoming && (
                  <div className="mb-2.5 inline-flex items-center gap-1.5 rounded-full bg-forest/10 px-2.5 py-1 text-[12px] font-semibold text-forest">
                    📅 Inspect {inspect.label}
                  </div>
                )}
                <div className="mb-2.5 flex items-center gap-3.5 border-y border-hairline py-2 text-[13px] text-body">
                  <span>
                    <b className="font-semibold">{p.beds ?? "—"}</b> bd
                  </span>
                  <span>
                    <b className="font-semibold">{p.baths ?? "—"}</b> ba
                  </span>
                  <span>
                    <b className="font-semibold">{p.parking ?? "—"}</b> car
                  </span>
                  {p.landSizeSqm != null && (
                    <span className="ml-auto text-xs text-mute">{p.landSizeSqm} m²</span>
                  )}
                </div>
                <div className="flex flex-col gap-3 sm:flex-row sm:items-end sm:gap-2">
                  <div className="flex min-w-0 flex-col gap-1.5 text-[12.5px] text-[#5B5A52]">
                    {p.nearestStation && (
                      <div className="truncate">
                        🚉 {p.nearestStation} · {fmtDistance(p.stationDistanceM)}
                      </div>
                    )}
                    {p.ptMinutesToFlinders != null && (
                      <div>
                        🕑 {fmtMinutes(p.ptMinutesToFlinders)}
                        {isTransitEstimated(p.ptSteps) && (
                          <span title="Estimated from the nearest tracked property">*</span>
                        )}{" "}
                        to Flinders St
                      </div>
                    )}
                    {(p.colesDistanceM != null || p.playgrounds500m != null) && (
                      <div>
                        {p.colesDistanceM != null && `🛒 ${fmtDistance(p.colesDistanceM)}`}
                        {p.colesDistanceM != null && p.playgrounds500m != null && " · "}
                        {p.playgrounds500m != null && `🛝 ${p.playgrounds500m} ≤500m`}
                      </div>
                    )}
                  </div>
                  {/* Emotes + Compare: their own full-width row on mobile (so the
                      distance text above isn't crushed), inline ≥sm. */}
                  <div className="flex shrink-0 items-center justify-between gap-1.5 sm:ml-auto sm:justify-normal">
                    <div className="flex items-center gap-1.5">
                    {(() => {
                      const myVibe = profile
                        ? p.ratings.find((r) => r.profile === profile)?.vibe ?? null
                        : null;
                      return VIBE_OPTS.map((o) => {
                        const on = myVibe === o.v;
                        return (
                          <button
                            key={o.v}
                            onClick={() => setVibe(p.id, myVibe, o.v)}
                            disabled={busy === p.id || !profile}
                            title={o.label}
                            aria-label={o.label}
                            className={`rounded-full border px-1.5 py-0.5 text-sm leading-none transition ${
                              on ? "border-forest bg-forest/15" : "border-line hover:bg-paper"
                            } ${busy === p.id ? "opacity-50" : ""}`}
                          >
                            {o.emoji}
                          </button>
                        );
                      });
                    })()}
                    </div>
                    <button
                      onClick={() => toggle(p.id)}
                      disabled={!isSel && selected.size >= 4}
                      title="Add to compare"
                      className={`shrink-0 rounded-[9px] border px-3 py-1.5 text-xs font-bold transition disabled:opacity-40 ${
                        isSel
                          ? "border-forest bg-forest text-linen"
                          : "border-line bg-white text-forest hover:border-forest"
                      }`}
                    >
                      {isSel ? "✓ Added" : "Compare"}
                    </button>
                  </div>
                </div>
              </div>
            </article>
          );
        })}
      </div>
      )}

      {compareIds.length >= 2 && (
        <div className="sticky bottom-5 mt-6 flex justify-center">
          <Link
            href={`/compare?ids=${compareIds.join(",")}`}
            className="rounded-full bg-forest px-7 py-3.5 text-sm font-semibold text-linen shadow-lg"
          >
            Compare {compareIds.length} properties →
          </Link>
        </div>
      )}
    </>
  );
}
