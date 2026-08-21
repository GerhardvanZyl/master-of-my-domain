"use client";

import { memo, useCallback, useEffect, useMemo, useRef, useState } from "react";
import Link from "next/link";
import Image from "next/image";
import { useRouter } from "next/navigation";
import type { PropertyListItem } from "@/db/queries/properties";
import { imageUrl } from "@/lib/images";
import { priceLine, fmtDistance, fmtMinutes, isTransitEstimated, fmtSoldDate } from "@/lib/format";
import { formatInspection } from "@/lib/inspection";
import { commuteDestination } from "@/lib/commute";
import { DEFAULT_VIBE_CONFIG, loadVibeConfig, vibeScore } from "@/lib/vibes";
import { useVibeConfig } from "@/lib/use-vibe-config";
import { SHORTLIST_TAGS, useProfile } from "@/lib/profile";
import { useDebounced } from "@/lib/useDebounced";
import {
  NEW_FOR_MS,
  PRICE_MAX,
  VIEWED_FILTERS,
  filterKey,
  filterProperties,
  isRatedProperty,
  parseFilterState,
} from "@/lib/property-filters";
import MultiSelect from "./MultiSelect";
import StaticMap from "./StaticMap";
import ShareButton from "./ShareButton";

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
  { key: "transit", label: "Transit to CBD: fastest", num: (p) => p.ptMinutesToFlinders, dir: "asc" },
  { key: "station", label: "Train station: nearest", num: (p) => p.stationDistanceM, dir: "asc" },
  { key: "coles", label: "Coles: nearest", num: (p) => p.colesDistanceM, dir: "asc" },
  { key: "playgrounds", label: "Playgrounds ≤500m: most", num: (p) => p.playgrounds500m, dir: "desc" },
  { key: "greencross", label: "Green Cross vet: nearest", num: (p) => p.greenCrossDistanceM, dir: "asc" },
  { key: "eaves", label: "Eaves: has them first", num: (p) => p.hasEaves, dir: "desc" },
  { key: "master", label: "Master bedroom: biggest", num: (p) => p.masterBedSqm, dir: "desc" },
];

const PRICE_MIN = 400_000;
const PRICE_STEP = 25_000; // PRICE_MAX ("no cap") comes from @/lib/property-filters — the filter needs it too
const fmtK = (n: number) => (n >= PRICE_MAX ? "any" : `$${(n / 1000).toFixed(0)}k`);

// Vibe rating buttons shown on each tile. Values and point deltas must stay in
// step with DEFAULT_VIBE_CONFIG (lib/vibes.ts) and the rating route's VOCAB.
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

function TriChip({
  value,
  onChange,
  label,
  exLabel,
}: {
  value: string;
  onChange: (v: string) => void;
  label: string;
  exLabel: string;
}) {
  const next = value === "off" ? "in" : value === "in" ? "ex" : "off";
  return (
    <button
      type="button"
      onClick={() => onChange(next)}
      title={next === "in" ? `Show only ${label.toLowerCase()}` : next === "ex" ? `Hide ${label.toLowerCase()}` : "Show all"}
      className={`chip whitespace-nowrap ${value === "in" ? "chip-on" : value === "ex" ? "chip-ex" : "hover:border-forest"}`}
    >
      {value === "ex" ? exLabel : label}
    </button>
  );
}

/** The one inspection-state filter: off → viewed → to-view → none → off.
 *  Not a TriChip — the three states are mutually exclusive, so "exclude" has
 *  no single meaning; you pick the one you want to see. */
function ViewedChip({ value, onChange }: { value: string; onChange: (v: string) => void }) {
  const i = VIEWED_FILTERS.indexOf(value as (typeof VIEWED_FILTERS)[number]);
  const next = VIEWED_FILTERS[(i < 0 ? 0 : i + 1) % VIEWED_FILTERS.length];
  const label: Record<string, string> = {
    off: "Viewed",
    viewed: "Viewed",
    "to-view": "To view",
    none: "Not viewed",
  };
  return (
    <button
      type="button"
      onClick={() => onChange(next)}
      title={next === "off" ? "Show all" : `Show only ${label[next].toLowerCase()}`}
      className={`chip whitespace-nowrap ${value === "off" ? "hover:border-forest" : value === "none" ? "chip-ex" : "chip-on"}`}
    >
      {label[value] ?? "Viewed"}
    </button>
  );
}

/** "Viewed 26 Jul" — fixed locale + timezone so server/client markup agree. */
function fmtVisited(iso: string): string {
  return new Intl.DateTimeFormat("en-AU", {
    timeZone: "Australia/Melbourne",
    day: "numeric",
    month: "short",
  }).format(new Date(iso));
}

// Elements a card-body click shouldn't hijack — its own controls, and the h3
// link itself (which needs a real navigation for ctrl/middle-click/prefetch).
const INTERACTIVE_SEL = "a, button, input, select, label, textarea, iframe, img[usemap]";

interface CardClickEvent {
  defaultPrevented: boolean;
  target: EventTarget | null;
  metaKey: boolean;
  ctrlKey: boolean;
  shiftKey: boolean;
  button: number;
}

function shouldSkipCardNav(e: CardClickEvent): boolean {
  if (e.defaultPrevented) return true;
  if ((e.target as HTMLElement).closest?.(INTERACTIVE_SEL)) return true;
  if ((window.getSelection()?.toString() ?? "").trim()) return true;
  // New-tab intent (ctrl/cmd/shift/middle-click) — let the h3's real <a> handle it.
  if (e.metaKey || e.ctrlKey || e.shiftKey || e.button === 1) return true;
  return false;
}

/**
 * Card-body click → navigate, used by both PropertyCard and PropertyRow.
 *
 * Drag-selecting is free: by `click` the selection exists, so shouldSkipCardNav
 * sees it. Double-click word-select is the awkward one — the first click fires
 * `click` before the browser has selected anything (word-selection lands on the
 * second mousedown), so nothing to check yet. Fix: defer that one navigation and
 * let `onDoubleClick` cancel it.
 *
 * The deferral is scoped to the card's text block (`[data-selectable]`) — a
 * quarter-second of dead time on every click is exactly the sluggishness we're
 * trying to remove, and nobody double-clicks a photo to select it. Photo and
 * padding clicks, which are most of the card's area, navigate on the same tick.
 */
const DBLCLICK_GRACE_MS = 250;

function useCardNav(href: string) {
  const router = useRouter();
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => () => void (timer.current && clearTimeout(timer.current)), []);
  return {
    onClick: (e: CardClickEvent) => {
      if (shouldSkipCardNav(e)) return;
      if (!(e.target as HTMLElement).closest?.("[data-selectable]")) {
        router.push(href); // instant: no text here to double-click
        return;
      }
      if (timer.current) clearTimeout(timer.current);
      timer.current = setTimeout(() => {
        timer.current = null;
        if ((window.getSelection()?.toString() ?? "").trim()) return;
        router.push(href);
      }, DBLCLICK_GRACE_MS);
    },
    onDoubleClick: () => {
      if (timer.current) {
        clearTimeout(timer.current);
        timer.current = null;
      }
    },
  };
}

interface TileProps {
  p: PropertyListItem;
  score: number;
  isSel: boolean;
  /** Compare tray is full — non-selected tiles disable their button. */
  selectFull: boolean;
  myVibe: string | null;
  canVibe: boolean;
  /** "viewed" | "to-view" | null, overlaid with any unsaved local edit. */
  viewed: string | null;
  shortlist: string | null;
  /** Passed down from the grid's top-level `useProfile()` so ~290 tiles don't
   *  each mount their own hook just for ShareButton — see ShareButton.tsx. */
  profile: string | null;
  onToggle: (id: string) => void;
  onVibe: (id: string, current: string | null, v: string) => void;
  onViewed: (id: string, current: string | null, value: string) => void;
}

/**
 * One grid card. memo'd because typing in the search box, dragging a slider or
 * toggling one card's selection would otherwise re-render all ~290 subtrees.
 * Every prop is a primitive or a stable callback, so the comparison is cheap.
 */
const PropertyCard = memo(function PropertyCard({
  p,
  score,
  isSel,
  selectFull,
  myVibe,
  canVibe,
  viewed,
  shortlist,
  profile,
  compact,
  mapSize,
  onToggle,
  onVibe,
  onViewed,
}: TileProps & { compact: boolean; mapSize: string }) {
  const nav = useCardNav(`/property/${p.id}`);
  const tag = SHORTLIST_TAGS.find((t) => t.id === shortlist);
  const isNew = Date.now() - new Date(p.createdAt).getTime() < NEW_FOR_MS;
  const inspect = formatInspection(p.nextInspection);
  const price = priceLine(p);

  return (
    <article
      onClick={nav.onClick}
      onDoubleClick={nav.onDoubleClick}
      className={`skip-offscreen relative cursor-pointer overflow-hidden rounded-2xl border bg-white shadow-[0_1px_3px_rgba(0,0,0,.05)] transition-shadow hover:shadow-[0_6px_20px_rgba(0,0,0,.08)] ${
        isSel ? "border-forest" : "border-line"
      }`}
    >
      <div className={`relative bg-fill ${compact ? "h-[188px]" : "h-[263px]"}`}>
        {p.thumbPath ? (
          // Served through next/image: the stored heroes are 1620×1080 originals
          // (~300KB) and the browser was decoding all of that into a ~400px box,
          // ~290 times. Resized + webp puts it around 20–45KB.
          <Image
            src={imageUrl({ localPath: p.thumbPath })}
            alt={p.address ?? "property"}
            fill
            sizes="(max-width: 640px) 100vw, (max-width: 1024px) 50vw, 420px"
            className={`object-cover ${p.delisted ? "opacity-60 grayscale" : ""}`}
          />
        ) : (
          <div className="flex h-full items-center justify-center text-sm text-mute">
            {p.scrapeStatus === "error" ? "scrape error" : "no image"}
          </div>
        )}
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
                  ? `Sold${fmtSoldDate(p.soldDate) ? ` · ${fmtSoldDate(p.soldDate)}` : ""}`
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
          <Link
            href="/config"
            title="Vibes: starts at 100, then adds and deducts for price fit, beds, transit time, amenities and both of your ratings. Click to see and tune the weights."
            className="pointer-events-auto absolute bottom-2.5 left-2.5 flex items-center gap-2"
          >
            <span className="flex items-center gap-1.5 rounded-[9px] bg-amber px-2.5 py-1 text-white shadow-[0_2px_8px_rgba(185,118,42,.4)]">
              <span className="text-xs">✨</span>
              <span className="font-serif text-lg leading-none">{score}</span>
            </span>
            <span className="text-[10px] uppercase tracking-widest text-white/85">
              vibes
            </span>
          </Link>
        </div>
        {mapSize !== "off" && p.latitude != null && p.longitude != null && (
          <StaticMap
            lat={p.latitude}
            lng={p.longitude}
            className={`pointer-events-none absolute -bottom-3 right-1.5 aspect-square ${MAP_SIZES[mapSize]} rounded-md border-2 border-white bg-white shadow-md`}
          />
        )}
      </div>

      {/* data-selectable: the card's text. Clicks here wait out a possible
          double-click so you can select an address to copy (see useCardNav).
          ponytail: not marked on PropertyRow — a list row is one line of
          truncated text, drag-select already works there, and word-select is
          not worth making every row click feel late. */}
      <div data-selectable className="p-4">
        {/* Right-aligned under the map thumbnail (which overhangs the photo by
            -bottom-3). Floated, not a flex sibling of the h3: a float only
            shortens the line boxes it actually overlaps, so the address keeps
            its position AND its full width from line 2 on. As a flex row it
            cost the address ~90px on every line and wrapped it to 3 lines at
            mobile card width (test/ui.test.ts guards that). Native checkbox
            rather than a toggle button — it is a multi-select, and
            `label`/`input` are already in INTERACTIVE_SEL so the card-nav click
            handler leaves it alone. */}
        <label
          title={!isSel && selectFull ? "Max 4 — remove one to add another" : "Add to compare"}
          className={`float-right ml-2 mt-1 flex items-center gap-1.5 text-xs font-bold ${
            !isSel && selectFull ? "cursor-not-allowed text-mute" : "cursor-pointer text-forest"
          }`}
        >
          Compare
          <input
            type="checkbox"
            checked={isSel}
            disabled={!isSel && selectFull}
            onChange={() => onToggle(p.id)}
            className="h-4 w-4 accent-forest"
          />
        </label>
        <h3 className="mb-1 font-serif text-[21px] leading-tight">
          <Link
            href={`/property/${p.id}`}
            className="rounded focus-visible:outline focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-forest"
          >
            {p.address ?? p.listingUrl}
          </Link>
        </h3>
        <div className="mb-2.5 flex flex-wrap items-baseline gap-2.5">
          <span className="font-semibold text-forest">{price.text}</span>
          {price.note && <span className="text-[11.5px] text-mute">{price.note}</span>}
          {p.advPricePrevious && (
            <span className="text-[11.5px] text-[#a05a2c]">
              was <span className="line-through">{p.advPricePrevious}</span>
              {p.advPricePreviousLabel
                ? ` · ${p.advPricePreviousLabel.replace(/^Price /, "")}`
                : ""}
            </span>
          )}
        </div>
        {/* State from the overlaid prop so an optimistic click flips it; the
            date itself only exists once the server has stamped it. */}
        {viewed === "viewed" && p.viewedAt && (
          <div className="mb-2.5 text-[11.5px] text-mute">Viewed {fmtVisited(p.viewedAt)}</div>
        )}
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
        {/* Wraps on CARD width, not viewport width: at ~900px the 2-col grid
            makes cards narrow enough to crush this row even though `sm:` says
            "roomy". flex-wrap + a min width on the text column self-corrects. */}
        <div className="flex flex-wrap items-end gap-x-2 gap-y-3">
          <div className="flex min-w-[190px] flex-1 flex-col gap-1.5 text-[12.5px] text-[#5B5A52]">
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
                to {commuteDestination(p)}
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
          {/* Emotes + the viewed/to-view pair + Share. Always its own full-width row
              and free to wrap onto a second line: they don't fit beside the
              distance text at card width, and the old shrink-0 + sm:w-auto made
              them overflow the card instead. (Compare moved up to a checkbox
              under the map.) */}
          <div className="flex w-full flex-wrap items-center justify-end gap-1.5">
            <div className="mr-auto flex items-center gap-1.5">
              {VIBE_OPTS.map((o) => {
                const on = myVibe === o.v;
                return (
                  <button
                    key={o.v}
                    onClick={() => onVibe(p.id, myVibe, o.v)}
                    disabled={!canVibe}
                    title={canVibe ? o.label : "Pick a profile to rate"}
                    aria-label={o.label}
                    aria-pressed={on}
                    className={`rounded-full border px-2 py-1 text-sm leading-none transition ${
                      on ? "border-forest bg-forest/15" : "border-line hover:bg-paper"
                    } ${canVibe ? "" : "opacity-40"}`}
                  >
                    {o.emoji}
                  </button>
                );
              })}
            </div>
            {([
              ["to-view", "To view"],
              ["viewed", "Viewed"],
            ] as const).map(([value, label]) => {
              const on = viewed === value;
              return (
                <button
                  key={value}
                  onClick={() => onViewed(p.id, viewed, value)}
                  aria-pressed={on}
                  title={on ? `Clear “${label}”` : `Mark as “${label}”`}
                  className={`shrink-0 rounded-[9px] border px-3 py-1.5 text-xs font-bold transition ${
                    on
                      ? "border-forest bg-forest/15 text-forest"
                      : "border-line bg-white text-body hover:border-forest"
                  }`}
                >
                  {on ? `✓ ${label}` : label}
                </button>
              );
            })}
            <ShareButton propertyId={p.id} profile={profile} />
          </div>
        </div>
      </div>
    </article>
  );
});

/**
 * List-layout row. memo'd for the same reason as PropertyCard. Exported so
 * /inbox can reuse the exact same row rendering rather than writing a third
 * card variant — it wraps this with its own share-metadata strip.
 *
 * `showCompare` defaults on for the grid's own list layout; /inbox passes
 * `false` because it has no compare tray to add to — a wired-up-to-nothing
 * "Compare" button there would be a visible dead control.
 */
export const PropertyRow = memo(function PropertyRow({
  p,
  score,
  isSel,
  selectFull,
  onToggle,
  profile,
  showCompare = true,
}: Pick<TileProps, "p" | "score" | "isSel" | "selectFull" | "onToggle" | "profile"> & {
  showCompare?: boolean;
}) {
  const nav = useCardNav(`/property/${p.id}`);
  const tag = SHORTLIST_TAGS.find((t) => t.id === p.shortlistTag);
  const isNew = Date.now() - new Date(p.createdAt).getTime() < NEW_FOR_MS;
  const inspect = formatInspection(p.nextInspection);
  const price = priceLine(p);

  return (
    <div
      onClick={nav.onClick}
      onDoubleClick={nav.onDoubleClick}
      className="skip-offscreen-row flex cursor-pointer items-center gap-4 border-b border-hairline px-4 py-3 last:border-0 hover:bg-paper"
    >
      <div className="relative h-[70px] w-24 shrink-0 overflow-hidden rounded-[10px] bg-fill">
        {p.thumbPath && (
          <Image
            src={imageUrl({ localPath: p.thumbPath })}
            alt={p.address ?? "property"}
            fill
            sizes="96px"
            className={`object-cover ${p.delisted ? "opacity-60 grayscale" : ""}`}
          />
        )}
      </div>
      <span className="flex h-[34px] w-[34px] shrink-0 items-center justify-center rounded-[9px] bg-amber font-serif text-base text-white">
        {score}
      </span>
      <div className="min-w-0 flex-[1.4]">
        <span className="flex items-center gap-2">
          <Link
            href={`/property/${p.id}`}
            className="truncate rounded font-serif text-lg focus-visible:outline focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-forest"
          >
            {p.address ?? p.listingUrl}
          </Link>
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
                ? `Sold${fmtSoldDate(p.soldDate) ? ` · ${fmtSoldDate(p.soldDate)}` : ""}`
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
      </div>
      <span className="flex-1 text-sm">
        <span className="font-semibold text-forest">{price.text}</span>
        {price.note && <span className="ml-1 text-[11px] text-mute">{price.note}</span>}
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
      <ShareButton propertyId={p.id} iconOnly profile={profile} />
      {showCompare && (
        <button
          onClick={() => onToggle(p.id)}
          disabled={!isSel && selectFull}
          title={!isSel && selectFull ? "Max 4 — remove one to add another" : "Add to compare"}
          className={`shrink-0 rounded-[9px] px-3 py-1.5 text-xs font-bold disabled:opacity-40 ${
            isSel ? "bg-forest text-linen" : "border border-line bg-white text-forest"
          }`}
        >
          {isSel ? "✓ Added" : "Compare"}
        </button>
      )}
    </div>
  );
});

export default function PropertyGrid({
  properties,
  region = "vic",
}: {
  properties: PropertyListItem[];
  region?: string;
}) {
  const [selected, setSelected] = useState<Set<string>>(new Set());
  // Local vibe writes, id -> vibe ("" = cleared). Applied on top of the server's
  // ratings so a click paints on the next frame. It used to call
  // router.refresh(), which re-rendered all ~290 cards on the server (~1.2s of
  // dead time) and re-sorted the grid out from under the cursor.
  const [vibeEdits, setVibeEdits] = useState<Record<string, string>>({});
  // Local inspection-state writes, id -> "viewed" | "to-view" | null. Same
  // optimistic pattern. One map, because it is one mutually exclusive state.
  const [viewedEdits, setViewedEdits] = useState<Record<string, string | null>>({});
  // Transient "cap reached" message shown in the compare tray for ~3s.
  const [capMsg, setCapMsg] = useState<string | null>(null);
  const capMsgTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

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
  const [hideDelisted, setHideDelisted] = useState(false);
  // Tri-state chips (see TriChip): "off" | "in" (only these) | "ex" (hide these).
  const [inspectingFilter, setInspectingFilter] = useState("off");
  // "off" | "viewed" | "to-view" | "none" — see ViewedChip / VIEWED_FILTERS.
  const [viewedFilter, setViewedFilter] = useState("off");
  const [ratedFilter, setRatedFilter] = useState("off");
  // "off" | "1w".."4w" — created within the last N weeks (NEW_FOR_MS-based).
  const [newFilter, setNewFilter] = useState("off");
  // Task 15: pin the filter bar to the top, collapse it to chips on scroll.
  const [pinned, setPinned] = useState(false);
  const [scrolled, setScrolled] = useState(false);
  const [forceOpen, setForceOpen] = useState(false);
  const { profile } = useProfile();

  // Filter/sort state persists per profile (task 17); "default" bucket when none.
  // Per region too — suburb lists are disjoint, so a saved Melbourne suburb
  // would blank out the Sydney grid. "vic" keeps the pre-existing key. Shared
  // with MapView (a reader of the same key) via property-filters.ts, so the
  // format has one definition.
  const fkey = filterKey(region, profile);

  // Shared, DB-backed vibe-weight config (localStorage cache + offline
  // fallback, per-device opt-out) — see use-vibe-config.ts. Hydrated after
  // mount for the same reason it always was: reading it DURING a render would
  // make the client markup disagree with the server's and React would throw a
  // hydration error.
  const { cfg: savedCfg, save: saveVibeConfig } = useVibeConfig();

  // `profile` hydrates in an effect, so fkey flips default→<profile> right after
  // mount. Without this guard the save effect fires on that flip carrying the
  // still-default state and stomps the saved filters under the new key.
  const loaded = useRef<string | null>(null);

  // Load the last-used filter/sort for the active profile, on mount + switch.
  useEffect(() => {
    let raw: unknown = {};
    try {
      raw = JSON.parse(localStorage.getItem(fkey) || "{}");
    } catch {
      /* ignore */
    }
    const s = (raw && typeof raw === "object" ? raw : {}) as Record<string, unknown>;
    setSort(typeof s.sort === "string" ? s.sort : "vibes");
    // The 15 fields that decide set membership: one parser, shared with
    // MapView, so a back-compat rule added here can't be missed there.
    const f = parseFilterState(s);
    setSuburb(f.suburb);
    setMinBeds(f.minBeds);
    setMinBaths(f.minBaths);
    setMinParking(f.minParking);
    setMaxPrice(f.maxPrice);
    setQ(f.q);
    setMapSize(typeof s.mapSize === "string" ? s.mapSize : "sm");
    setLayout(typeof s.layout === "string" ? s.layout : "gallery");
    setTagFilter(f.tagFilter);
    setHideAuction(f.hideAuction);
    setHideUnderOffer(f.hideUnderOffer);
    setHideDelisted(f.hideDelisted);
    setInspectingFilter(f.inspectingFilter);
    setViewedFilter(f.viewedFilter);
    setRatedFilter(f.ratedFilter);
    setNewFilter(f.newFilter);
    setPinned(!!s.pinned);
    // Read the cache imperatively, NOT savedCfg: this effect runs once on
    // mount (loaded.current gates it), while savedCfg is still the default —
    // the hook hydrates in a later commit, which this would never see.
    setIdealPrice(typeof s.idealPrice === "number" ? s.idealPrice : loadVibeConfig().idealPrice);
    loaded.current = fkey;
  }, [fkey]);

  // Persist on any change, keyed by profile. Debounced: localStorage writes are
  // synchronous, and one JSON.stringify + write per keystroke/slider tick lands
  // straight on the main thread mid-interaction.
  useEffect(() => {
    if (loaded.current !== fkey) return; // not restored yet — nothing worth saving
    const t = setTimeout(() => {
      try {
        localStorage.setItem(
          fkey,
          JSON.stringify({ sort, suburb, minBeds, minBaths, minParking, maxPrice, idealPrice, q, mapSize, layout, tagFilter, hideAuction, hideUnderOffer, hideDelisted, inspectingFilter, viewedFilter, ratedFilter, newFilter, pinned }),
        );
      } catch (e) {
        console.warn("filter save failed", e); // quota/private mode — don't fail silently
      }
    }, 400);
    return () => clearTimeout(t);
  }, [fkey, sort, suburb, minBeds, minBaths, minParking, maxPrice, idealPrice, q, mapSize, layout, tagFilter, hideAuction, hideUnderOffer, hideDelisted, inspectingFilter, viewedFilter, ratedFilter, newFilter, pinned]);

  // Compare selection persists per region, independent of the profile filter
  // bucket above — you might switch profiles mid-compare.
  const skey = `compare:${region}`;
  const selLoaded = useRef<string | null>(null);
  useEffect(() => {
    let ids: unknown = [];
    try {
      ids = JSON.parse(localStorage.getItem(skey) || "[]");
    } catch {
      /* ignore */
    }
    const valid = new Set(properties.map((p) => p.id));
    setSelected(
      new Set(
        Array.isArray(ids)
          ? ids.filter((id): id is string => typeof id === "string" && valid.has(id))
          : [],
      ),
    );
    selLoaded.current = skey;
    // eslint-disable-next-line react-hooks/exhaustive-deps -- restore once per
    // region on mount; `properties` is only read to drop stale ids, not to
    // re-trigger a restore that would clobber a selection made since mount.
  }, [skey]);

  useEffect(() => {
    if (selLoaded.current !== skey) return; // not restored yet
    const t = setTimeout(() => {
      try {
        localStorage.setItem(skey, JSON.stringify([...selected]));
      } catch (e) {
        console.warn("compare selection save failed", e); // quota/private mode
      }
    }, 400);
    return () => clearTimeout(t);
  }, [skey, selected]);

  // Once pinned, collapse the bar after the user scrolls down a little.
  // rAF-coalesced: scroll fires far more often than we can usefully react, and
  // this handler sits in front of every scroll frame on the page.
  useEffect(() => {
    let raf = 0;
    const onScroll = () => {
      if (raf) return;
      raf = requestAnimationFrame(() => {
        raf = 0;
        const y = window.scrollY;
        setScrolled(y > 140);
        if (y <= 140) setForceOpen(false); // back at top → reset the expand
      });
    };
    window.addEventListener("scroll", onScroll, { passive: true });
    return () => {
      window.removeEventListener("scroll", onScroll);
      cancelAnimationFrame(raf);
    };
  }, []);
  const collapsed = pinned && scrolled && !forceOpen;

  const suburbs = useMemo(
    () =>
      [...new Set(properties.map((p) => p.suburb).filter(Boolean))].sort() as string[],
    [properties],
  );

  // Re-scoring + re-filtering every property is too slow to run on every
  // keystroke or slider tick — it starved the label next to the thumb, so the
  // number only landed on release. The controls read the raw state (instant);
  // the grid reads these settled values.
  const dMaxPrice = useDebounced(maxPrice, 120);
  const dIdealPrice = useDebounced(idealPrice, 120);
  const dQ = useDebounced(q, 180);

  // Vibe score per property, using the live ideal-price slider (rest of the
  // config comes from localStorage / defaults).
  const vibeCfg = useMemo(() => ({ ...savedCfg, idealPrice: dIdealPrice }), [savedCfg, dIdealPrice]);
  const scoreOf = useMemo(() => {
    const m = new Map<string, number>();
    for (const p of properties) m.set(p.id, vibeScore(p, p.ratings, vibeCfg));
    return m;
  }, [properties, vibeCfg]);

  // The vibe shown on a tile: local edit if there is one, else the server's.
  const vibeOf = useCallback(
    (p: PropertyListItem) =>
      p.id in vibeEdits
        ? vibeEdits[p.id] || null
        : profile
          ? p.ratings.find((r) => r.profile === profile)?.vibe ?? null
          : null,
    [vibeEdits, profile],
  );

  // A vibe edit moves the score too, so recompute — but only for edited rows.
  // Sorting deliberately keeps reading `scoreOf` (server data) so tiles don't
  // leap around while you're rating them.
  const scoreShown = useCallback(
    (p: PropertyListItem) => {
      if (!(p.id in vibeEdits) || !profile) return scoreOf.get(p.id) ?? 0;
      const mine = p.ratings.find((r) => r.profile === profile);
      return vibeScore(
        p,
        [
          ...p.ratings.filter((r) => r.profile !== profile),
          { ...mine, profile, vibe: vibeEdits[p.id] || null } as (typeof p.ratings)[number],
        ],
        vibeCfg,
      );
    },
    [vibeEdits, profile, scoreOf, vibeCfg],
  );

  // Your own 0–10 score / vibe, from the active profile's rating row.
  const myScore = useCallback(
    (p: PropertyListItem) => p.ratings.find((r) => r.profile === profile)?.score ?? null,
    [profile],
  );

  // The attendance shown on a tile: local edit if there is one, else the server's.
  const viewedOf = useCallback(
    (p: PropertyListItem) => (p.id in viewedEdits ? viewedEdits[p.id] : p.viewed),
    [viewedEdits],
  );

  // The shortlist tag shown on a tile. Read-only here now: the grid's only
  // shortlist writer was the "must-see" button, which is `viewed` these days.
  const shortlistOf = useCallback((p: PropertyListItem) => p.shortlistTag, []);

  // "Rated" = the user has expressed ANY opinion, from EITHER profile — the
  // shared definition (@/lib/property-filters), fed MY vibe via vibeOf() so a
  // click on the grid's emoji row (which only updates vibeEdits, not
  // p.ratings) is picked up immediately. MapView has no edits to overlay, so
  // it calls the same function without an override.
  const isRated = useCallback(
    (p: PropertyListItem) => isRatedProperty(p, profile, vibeOf(p)),
    [profile, vibeOf],
  );

  const view = useMemo(() => {
    let list = filterProperties(
      properties,
      {
        suburb,
        minBeds,
        minBaths,
        minParking,
        maxPrice: dMaxPrice,
        q: dQ,
        tagFilter,
        hideAuction,
        hideUnderOffer,
        hideDelisted,
        inspectingFilter,
        viewedFilter,
        ratedFilter,
        newFilter,
      },
      { shortlistOf, viewedOf, isRated },
    );
    if (sort === "vibes") {
      list = [...list].sort((a, b) => (scoreOf.get(b.id) ?? 0) - (scoreOf.get(a.id) ?? 0));
    } else if (sort === "score") {
      list = [...list].sort(byNum(myScore, "desc"));
    } else {
      const cfg = SORTS.find((s) => s.key === sort);
      if (cfg?.num) list = [...list].sort(byNum(cfg.num, cfg.dir));
    }
    return list;
  }, [properties, suburb, minBeds, minBaths, minParking, dMaxPrice, dQ, sort, scoreOf, tagFilter, hideAuction, hideUnderOffer, hideDelisted, inspectingFilter, shortlistOf, myScore, viewedFilter, viewedOf, ratedFilter, isRated, newFilter]);

  // Hand the current on-screen order to the detail page's prev/next pager, so
  // stepping through listings follows the filter+sort you're actually looking
  // at. Debounced: `view` changes on every keystroke and slider tick.
  // ponytail: localStorage rather than a URL param or a store — the pager is
  // the only reader and a stale order is harmless (it renders nothing if the
  // current id isn't in the list).
  useEffect(() => {
    const t = setTimeout(() => {
      try {
        localStorage.setItem("nav:order", JSON.stringify(view.map((p) => p.id)));
      } catch (e) {
        console.warn("nav order save failed", e);
      }
    }, 400);
    return () => clearTimeout(t);
  }, [view]);

  // Stable identity — a changing callback would defeat memo() on every card.
  const toggle = useCallback((id: string) => {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) {
        next.delete(id);
      } else if (next.size < 4) {
        next.add(id); // compare view caps at 4
      } else {
        setCapMsg("Max 4 to compare — remove one first");
        if (capMsgTimer.current) clearTimeout(capMsgTimer.current);
        capMsgTimer.current = setTimeout(() => setCapMsg(null), 3000);
      }
      return next;
    });
  }, []);

  // Set the inspection state for a tile. Clicking the active value clears it,
  // so the three states cycle without ever overlapping. Optimistic and
  // fire-and-forget, same as setVibe below — no router.refresh().
  const setViewedState = useCallback((id: string, current: string | null, value: string) => {
    const next = current === value ? null : value;
    setViewedEdits((prev) => ({ ...prev, [id]: next }));
    fetch(`/api/properties/${id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ viewed: next }),
    }).catch((e) => console.warn("viewed save failed", e));
  }, []);

  // Rate a property's "vibe" for the active profile straight from its tile.
  // Clicking the current choice again clears it. Feeds the Vibes score.
  // Fire-and-forget: the local edit is the truth until the next navigation, and
  // nothing else on the page can contradict it.
  const setVibe = useCallback(
    (id: string, current: string | null, v: string) => {
      if (!profile) return;
      const next = current === v ? "" : v;
      setVibeEdits((prev) => ({ ...prev, [id]: next }));
      fetch(`/api/properties/${id}/rating`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ profile, vibe: next }),
      }).catch((e) => console.warn("rating save failed", e));
    },
    [profile],
  );

  if (properties.length === 0) {
    return (
      <p className="rounded-2xl border border-dashed border-line bg-paper p-16 text-center text-mute">
        No properties yet. Browse a Domain or realestate.com.au listing with the
        capture extension installed to add one.
      </p>
    );
  }

  const compareIds = [...selected];
  const selectFull = selected.size >= 4;

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
    hideDelisted && "no sold",
    inspectingFilter !== "off" &&
      (inspectingFilter === "in" ? "inspecting this weekend" : "not inspecting this weekend"),
    viewedFilter !== "off" &&
      (viewedFilter === "viewed" ? "viewed" : viewedFilter === "to-view" ? "to view" : "not viewed"),
    ratedFilter !== "off" && (ratedFilter === "in" ? "rated" : "unrated"),
    newFilter !== "off" &&
      (newFilter === "1w" ? "new this week" : `new these ${parseInt(newFilter, 10)} weeks`),
    q.trim() && `“${q.trim()}”`,
  ].filter(Boolean) as string[];

  // Task 2: return every filter to its default. Layout/mapSize/pinned/
  // idealPrice are display prefs, not filters, so they're untouched.
  const resetFilters = () => {
    setSort("vibes");
    setSuburb([]);
    setMinBeds(0);
    setMinBaths(0);
    setMinParking(0);
    setMaxPrice(PRICE_MAX);
    setQ("");
    setTagFilter("");
    setHideAuction(false);
    setHideUnderOffer(false);
    setHideDelisted(false);
    setViewedFilter("off");
    setRatedFilter("off");
    setNewFilter("off");
    setInspectingFilter("off");
  };

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
            onChange={(e) => setIdealPrice(Number(e.target.value))}
            // Was saving on every tick of the drag, which blocked the paint.
            // Once on release is enough. Goes through the hook so it reaches
            // the shared server config too, not just this browser's cache.
            onPointerUp={() => saveVibeConfig({ ...savedCfg, idealPrice })}
            onKeyUp={() => saveVibeConfig({ ...savedCfg, idealPrice })}
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
          <button
            onClick={() => setHideDelisted((v) => !v)}
            className={`chip ${hideDelisted ? "chip-on" : "hover:border-forest"}`}
          >
            Sold / off-market
          </button>
        </div>
        <button
          type="button"
          onClick={resetFilters}
          disabled={activeChips.length === 0}
          title="Reset filters to defaults"
          className="rounded-full border border-line px-3 py-1.5 text-xs font-semibold text-body transition hover:border-forest disabled:cursor-not-allowed disabled:opacity-40"
        >
          Reset
        </button>
        <div className="hidden h-6 w-px bg-line sm:block" />
        <div className="flex w-full flex-wrap items-center gap-2 sm:w-auto">
          <span className="label-cap">Filter</span>
          <TriChip
            value={inspectingFilter}
            onChange={setInspectingFilter}
            label="Inspecting this weekend"
            exLabel="Not inspecting this weekend"
          />
          <ViewedChip value={viewedFilter} onChange={setViewedFilter} />
          <TriChip value={ratedFilter} onChange={setRatedFilter} label="Rated" exLabel="Unrated" />
          {/* New is include-only, so it just cycles 1→4 weeks and back off. */}
          <button
            type="button"
            onClick={() => setNewFilter((v) => (v === "off" ? "1w" : v === "4w" ? "off" : `${parseInt(v, 10) + 1}w`))}
            title={newFilter === "4w" ? "Show all" : `Show only new (last ${newFilter === "off" ? 1 : parseInt(newFilter, 10) + 1} week${newFilter === "off" ? "" : "s"})`}
            className={`chip whitespace-nowrap ${newFilter !== "off" ? "chip-on" : "hover:border-forest"}`}
          >
            {newFilter === "off" ? "New" : `New (${parseInt(newFilter, 10)}wk)`}
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
          {view.map((p) => (
            <PropertyRow
              key={p.id}
              p={p}
              score={scoreShown(p)}
              isSel={selected.has(p.id)}
              selectFull={selectFull}
              onToggle={toggle}
              profile={profile}
            />
          ))}
        </div>
      ) : (
        <div
          className={`grid grid-cols-1 gap-5 sm:grid-cols-2 ${
            layout === "compact" ? "lg:grid-cols-4" : "lg:grid-cols-3"
          }`}
        >
          {view.map((p) => (
            <PropertyCard
              key={p.id}
              p={p}
              score={scoreShown(p)}
              isSel={selected.has(p.id)}
              selectFull={selectFull}
              compact={layout === "compact"}
              mapSize={mapSize}
              canVibe={!!profile}
              profile={profile}
              myVibe={vibeOf(p)}
              viewed={viewedOf(p)}
              shortlist={shortlistOf(p)}
              onToggle={toggle}
              onVibe={setVibe}
              onViewed={setViewedState}
            />
          ))}
        </div>
      )}

      {mapSize !== "off" && (
        <p className="mt-3 text-center text-[10px] text-mute">Map tiles © OpenStreetMap contributors</p>
      )}

      {selected.size >= 1 && (
        <div className="sticky bottom-5 z-30 mt-6 flex justify-center px-4">
          <div className="flex max-w-full flex-wrap items-center gap-2.5 rounded-2xl border border-line bg-white px-4 py-3 shadow-lg">
            {compareIds.map((id) => {
              const p = properties.find((x) => x.id === id);
              if (!p) return null;
              return (
                <span
                  key={id}
                  className="flex items-center gap-1.5 rounded-full bg-hairline py-1 pl-3 pr-1.5 text-xs font-medium text-body"
                >
                  <span className="max-w-[140px] truncate">{p.address ?? p.listingUrl}</span>
                  <button
                    type="button"
                    onClick={() => toggle(id)}
                    aria-label={`Remove ${p.address ?? "property"} from compare`}
                    className="rounded-full px-1 leading-none text-mute hover:bg-line hover:text-body"
                  >
                    ×
                  </button>
                </span>
              );
            })}
            {capMsg && (
              <span className="text-xs font-semibold text-[#B84A3A]">{capMsg}</span>
            )}
            <button
              type="button"
              onClick={() => setSelected(new Set())}
              className="text-xs font-semibold text-mute hover:text-body"
            >
              Clear all
            </button>
            {compareIds.length >= 2 ? (
              <Link
                href={`/compare?ids=${compareIds.join(",")}`}
                className="shrink-0 rounded-full bg-forest px-4 py-2 text-xs font-bold text-linen shadow-sm"
              >
                Compare {compareIds.length} properties →
              </Link>
            ) : (
              <span
                title="Select at least 2 to compare"
                className="shrink-0 rounded-full bg-hairline px-4 py-2 text-xs font-bold text-mute"
              >
                Compare {compareIds.length} {compareIds.length === 1 ? "property" : "properties"} →
              </span>
            )}
          </div>
        </div>
      )}
    </>
  );
}
