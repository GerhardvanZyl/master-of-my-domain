import Link from "next/link";
import { notFound } from "next/navigation";
import {
  getProperty,
  getPropertyImages,
  getPriceHistory,
  getPropertyRatings,
  pickHero,
  pickShowcase,
  pickFloorplan,
  getSaleStatus,
} from "@/db/queries/properties";
import PhotoGrid from "@/components/PhotoGrid";
import HeroGallery from "@/components/HeroGallery";
import PropertyMap from "@/components/PropertyMap";
import MapModal from "@/components/MapModal";
import NotesEditor from "@/components/NotesEditor";
import PropertyRail from "@/components/PropertyRail";
import PropertyPager from "@/components/PropertyPager";
import MediaUploader from "@/components/MediaUploader";
import MetadataEditor from "@/components/MetadataEditor";
import ShareButton from "@/components/ShareButton";
import { listMedia } from "@/lib/media";
import { imageUrl } from "@/lib/images";
import { formatPrice, fmtAud, fmtNum, fmtDistance, fmtMinutes, isTransitEstimated, fmtSoldDateLong } from "@/lib/format";
import { formatInspection } from "@/lib/inspection";
import { commuteDestination } from "@/lib/commute";
import { isValidPropertyComAuUrl, propertyComAuSearchUrl } from "@/lib/property-com-au";
import type { ReactNode } from "react";

export const dynamic = "force-dynamic";

export default async function PropertyDetail({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  const property = getProperty(id);
  if (!property) notFound();
  const images = getPropertyImages(id);
  const history = getPriceHistory(id);
  const ratings = getPropertyRatings(id);
  const media = listMedia(id);

  // Location card rows (left column) vs listing metadata (right rail).
  const locationFacts: [string, string][] = [
    [
      "Nearest station",
      property.nearestStation
        ? `${property.nearestStation} · ${fmtDistance(property.stationDistanceM)}`
        : "—",
    ],
    [
      "Next-closest station",
      property.secondStation
        ? `${property.secondStation} · ${fmtDistance(property.secondStationDistanceM)}`
        : "—",
    ],
    [
      `Transit to ${commuteDestination(property)} (7:30am)`,
      property.ptMinutesToFlinders != null
        ? fmtMinutes(property.ptMinutesToFlinders) +
          (isTransitEstimated(property.ptSteps) ? "*" : "") +
          (property.ptRouteSummary ? ` · ${property.ptRouteSummary}` : "")
        : "—",
    ],
    [
      "Nearest Coles",
      property.colesDistanceM != null
        ? `${property.colesName ?? "Coles"} · ${fmtDistance(property.colesDistanceM)}`
        : "—",
    ],
    ["Playgrounds ≤500m", fmtNum(property.playgrounds500m)],
    ["Green Cross vet (Werribee)", fmtDistance(property.greenCrossDistanceM)],
  ];

  const listingFacts: [string, ReactNode][] = [
    ["Property type", property.propertyType ?? "—"],
    ["Suburb", [property.suburb, property.state, property.postcode].filter(Boolean).join(" ") || "—"],
    ["Agent", [property.agentName, property.agencyName].filter(Boolean).join(", ") || "—"],
    ["Source", property.sourceSite],
    ["Status", property.scrapeStatus],
  ];
  // Both null for every row on day one (no backfill yet) — pushed only when
  // present, so there's no "Unknown"/"—" row and no layout shift while empty.
  if (property.yearBuilt != null) {
    listingFacts.push(["Year built", String(property.yearBuilt)]);
  }
  // Re-validated here (not just trusted from the DB) — it's untrusted,
  // externally sourced data rendered as a live href.
  if (isValidPropertyComAuUrl(property.propertyComAuUrl)) {
    listingFacts.push([
      "property.com.au",
      <a
        key="property-com-au"
        href={property.propertyComAuUrl}
        target="_blank"
        rel="noreferrer"
        className="text-forest hover:underline"
      >
        View listing ↗
      </a>,
    ]);
  } else {
    // No backfilled URL (true for every row on the live app today) — fall
    // back to a Google search so the row still gives the user somewhere to
    // click. Wording says "Search", not "View listing", so it can't be read
    // as a confirmed link to a listing that was never found.
    const searchUrl = propertyComAuSearchUrl(
      property.address,
      property.suburb,
      property.state,
      property.postcode,
    );
    if (searchUrl) {
      listingFacts.push([
        "property.com.au",
        <a
          key="property-com-au"
          href={searchUrl}
          target="_blank"
          rel="noreferrer"
          className="text-forest hover:underline"
        >
          Search property.com.au ↗
        </a>,
      ]);
    }
  }

  // Deduced-from-photos metadata (display + correction). null → "—".
  const yesNo = (v: number | null) => (v == null ? "—" : v ? "Yes" : "No");
  const homeFacts: [string, string][] = [
    ["All-around eaves", yesNo(property.hasEaves)],
    ["Master bedroom", fmtNum(property.masterBedSqm, " m²")],
    ["Other bedrooms (avg)", fmtNum(property.avgOtherBedSqm, " m²")],
    ["Common areas", fmtNum(property.commonAreasCount)],
    ["Balcony", fmtNum(property.balconySqm, " m²")],
    ["Back garden", fmtNum(property.backGardenSqm, " m²")],
    ["Covered pergola/deck", yesNo(property.pergolaCovered)],
    [
      "Lawn",
      property.hasLawn == null
        ? "—"
        : property.hasLawn
          ? property.lawnType
            ? `Yes · ${property.lawnType}`
            : "Yes"
          : "No",
    ],
    ["Altitude", fmtNum(property.altitudeM, " m")],
    ["Flood overlay", yesNo(property.floodOverlay)],
    ["Bushfire overlay", yesNo(property.bushfireOverlay)],
  ];

  const stats: [string, string][] = [
    ["Beds", fmtNum(property.beds)],
    ["Baths", fmtNum(property.baths)],
    ["Car", fmtNum(property.parking)],
    ["Land", fmtNum(property.landSizeSqm, " m²")],
  ];

  const hero = pickHero(images);
  const showcase = pickShowcase(images, hero, 3);
  const heroIndex = hero ? images.indexOf(hero) : 0;
  const showcaseIndices = showcase.map((s) => images.indexOf(s));
  const floorplan = pickFloorplan(images);
  const saleStatus = getSaleStatus(property.listingUrl);
  const delisted = saleStatus !== null;
  // getPriceHistory returns oldest-first; the property's own historical sale
  // timeline (previous owners, e.g. "Sold - PRIVATE TREATY") also matches
  // /sold/i, so take the MOST RECENT match — this listing's own sale, not a
  // 2015 entry that happens to appear earlier in the array.
  const soldRow = [...history].reverse().find((h) => /sold/i.test(h.event ?? ""));
  const soldDateText = soldRow?.date ? fmtSoldDateLong(soldRow.date) : null;

  // ponytail: adv price strings are plain "$X,XXX,XXX" guides (no k/m
  // shorthand in this dataset) — a plain digit scrape is enough to compute
  // the ▲/▼ delta against the next row down, no need for a real parser.
  const parseDollars = (s: string | null | undefined): number | null => {
    if (!s) return null;
    const m = s.match(/[\d,]{4,}/);
    if (!m) return null;
    const n = Number(m[0].replace(/,/g, ""));
    return Number.isFinite(n) && n > 0 ? n : null;
  };

  type PriceRow = {
    key: string;
    date: string | null;
    event: string;
    priceText: ReactNode;
    priceNumeric: number | null;
  };

  const priceRows: PriceRow[] = [];
  if (property.advPriceCurrent) {
    priceRows.push({
      key: "adv-current",
      date: null,
      event: "Current guide",
      priceText: property.advPriceCurrent,
      priceNumeric: parseDollars(property.advPriceCurrent),
    });
  }
  if (property.advPricePrevious) {
    priceRows.push({
      key: "adv-previous",
      date: null,
      event: property.advPricePreviousLabel?.replace(/^Price /, "") || "Previous guide",
      priceText: (
        <>
          was <span className="line-through">{property.advPricePrevious}</span>
        </>
      ),
      priceNumeric: parseDollars(property.advPricePrevious),
    });
  }
  for (const h of [...history].reverse()) {
    // getPriceHistory orders ascending by date — reverse for newest-first.
    priceRows.push({
      key: h.id,
      date: h.date,
      event: h.event ?? "—",
      priceText: h.priceDisplay || (h.priceNumeric ? fmtAud(h.priceNumeric) : "—"),
      priceNumeric: h.priceNumeric,
    });
  }
  const priceRowsWithChange = priceRows.map((r, i) => {
    const older = priceRows[i + 1];
    let change: { text: string; up: boolean } | null = null;
    if (r.priceNumeric != null && older?.priceNumeric != null && older.priceNumeric !== r.priceNumeric) {
      const delta = r.priceNumeric - older.priceNumeric;
      const pct = (Math.abs(delta) / older.priceNumeric) * 100;
      change = {
        text: `${delta > 0 ? "▲" : "▼"} ${fmtAud(Math.abs(delta))} (${pct.toFixed(1)}%)`,
        up: delta > 0,
      };
    }
    return { ...r, change };
  });

  const viewedLabel = property.viewedAt
    ? new Intl.DateTimeFormat("en-AU", {
        timeZone: "Australia/Melbourne",
        day: "numeric",
        month: "short",
        year: "numeric",
      }).format(new Date(property.viewedAt))
    : null;

  return (
    <section className="rise">
      <div className="mb-4 flex flex-wrap items-center justify-between gap-3">
        <Link
          href="/"
          className="inline-block text-[13px] font-medium text-[#5B5A52] hover:text-forest"
        >
          ← All properties
        </Link>
        <div className="flex items-center gap-2.5">
          <ShareButton propertyId={property.id} />
          <PropertyPager currentId={property.id} />
        </div>
      </div>

      {delisted && (
        <div className="mb-4 flex items-center gap-2 rounded-xl border border-[#e0b4ac] bg-[#fbeeeb] px-4 py-3 text-sm font-medium text-[#B84A3A]">
          <span className="text-base">⚠</span>
          {saleStatus === "sold" ? (
            <span>
              {soldDateText ? (
                <>
                  Sold {soldDateText} — no longer listed on Domain
                  {soldRow?.priceDisplay
                    ? ` (${soldRow.priceDisplay.replace(/^sold\s*-\s*/i, "")})`
                    : ""}
                  . Your ratings and notes are kept.
                </>
              ) : (
                <>
                  Sold — no longer listed on Domain
                  {soldRow?.priceDisplay ? ` (${soldRow.priceDisplay})` : ""}. Your
                  ratings and notes are kept.
                </>
              )}
            </span>
          ) : saleStatus === "withdrawn" ? (
            <span>
              Withdrawn — no longer listed on Domain. Your ratings and notes are
              kept.
            </span>
          ) : (
            <span>
              No longer listed on Domain — this listing appears to be sold or
              withdrawn. Your ratings and notes are kept.
            </span>
          )}
        </div>
      )}

      {/* Single column. The two rails below are `display: contents`, so every
          section inside them is a direct flex child of this column and the
          inline `order` on each one interleaves them freely. */}
      <div className="flex flex-col gap-7">
        {/* LEFT */}
        <div className="contents">
          {/* HeroGallery takes no style/className prop, so the `order` for
              experimental mode lives on this wrapper instead. */}
          <div style={{ order: 1 }}>
            <HeroGallery
              images={images}
              heroIndex={heroIndex}
              showcaseIndices={showcaseIndices}
              alt={property.address ?? "property"}
            />
          </div>

          {property.scrapeStatus === "error" && (
            <div
              style={{ order: 1 }}
              className="rounded-xl border border-[#e0b4ac] bg-[#fbeeeb] p-3 text-sm text-[#B84A3A]"
            >
              Scrape error: {property.scrapeError ?? "unknown"}
            </div>
          )}

          <div style={{ order: 4 }} className="card p-[18px]">
            <div className="mb-3.5 flex flex-wrap items-center justify-between gap-3">
              <h2 className="font-serif text-[22px]">Location &amp; commute</h2>
              <MapModal
                lat={property.latitude}
                lng={property.longitude}
                address={property.address}
              />
            </div>
            <div className="mb-3.5">
              <PropertyMap
                lat={property.latitude}
                lng={property.longitude}
                address={property.address}
                className="h-[220px]"
              />
            </div>
            <dl className="flex flex-col gap-2.5 text-[13.5px]">
              {locationFacts.map(([k, v], i) => (
                <div
                  key={k}
                  className={`flex justify-between gap-4 ${
                    i < locationFacts.length - 1 ? "border-b border-hairline pb-2.5" : ""
                  }`}
                >
                  <dt className="min-w-0 text-mute">{k}</dt>
                  <dd className="min-w-0 break-words text-right font-medium">{v}</dd>
                </div>
              ))}
            </dl>
            {property.ptSteps && (
              <p className="mt-3.5 rounded-[10px] bg-sand px-3.5 py-3 text-[12.5px] leading-relaxed text-[#5a5344]">
                {property.ptSteps}
              </p>
            )}
          </div>

          <div style={{ order: 6 }} className="card p-4">
            <div className="mb-2.5 flex items-center justify-between">
              <h2 className="font-serif text-lg">Listing photos</h2>
              <span className="text-[11.5px] text-mute">
                {images.length} photos · click to zoom &amp; correct the room tag
              </span>
            </div>
            <PhotoGrid images={images} />
          </div>

          {/* MediaUploader takes no style prop, so wrap it for the order hook. */}
          <div style={{ order: 8 }}>
            <MediaUploader propertyId={property.id} initial={media} />
          </div>

          {property.description && (
            <div style={{ order: 10 }} className="card p-[18px]">
              <h2 className="mb-2 font-serif text-[22px]">Listing description</h2>
              <p className="whitespace-pre-line text-sm leading-relaxed text-[#5B5A52]">
                {property.description}
              </p>
            </div>
          )}

          {priceRowsWithChange.length > 0 && (
            <div style={{ order: 12 }} className="card p-[18px]">
              <h2 className="mb-2.5 font-serif text-[22px]">Price history</h2>
              <table className="w-full text-sm">
                <tbody>
                  {priceRowsWithChange.map((r) => (
                    <tr key={r.key} className="border-b border-hairline last:border-0">
                      <td className="py-1.5 pr-4 text-mute">{r.date ?? "—"}</td>
                      <td className="py-1.5 pr-4">
                        {r.event}
                        {r.change && (
                          <span
                            className={`ml-2 text-[11.5px] font-medium ${
                              r.change.up ? "text-forest" : "text-[#B84A3A]"
                            }`}
                          >
                            {r.change.text}
                          </span>
                        )}
                      </td>
                      <td className="py-1.5 text-right font-medium">{r.priceText}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>

        {/* RIGHT RAIL */}
        <div className="contents">
          <div style={{ order: 2 }}>
            <span className="text-[11px] uppercase tracking-widest text-mute">
              {property.sourceSite}
              {property.suburb ? ` · ${property.suburb}` : ""}
            </span>
            <h1 className="my-1 break-words font-serif text-[32px] leading-tight">
              {property.address ?? property.listingUrl}
            </h1>
            <div className="flex flex-wrap items-baseline gap-3">
              <span className="font-serif text-[26px] text-forest">
                {formatPrice(property.priceDisplay, property.priceNumeric)}
              </span>
              {property.advPricePrevious && (
                <span className="text-xs text-[#a05a2c]">
                  was{" "}
                  <span className="line-through">{property.advPricePrevious}</span>
                  {property.advPricePreviousLabel
                    ? ` · ${property.advPricePreviousLabel.replace(/^Price /, "")}`
                    : ""}
                </span>
              )}
            </div>
            {(() => {
              const inspect = formatInspection(property.nextInspection);
              return inspect?.upcoming ? (
                <div className="mt-2 inline-flex items-center gap-1.5 rounded-full bg-forest/10 px-3 py-1 text-[13px] font-semibold text-forest">
                  📅 Next inspection · {inspect.label}
                </div>
              ) : null;
            })()}
            {property.viewed === "viewed" && (
              <div className="mt-2 inline-flex items-center gap-1.5 rounded-full bg-sand px-3 py-1 text-[13px] font-medium text-mute">
                ✓ Viewed{viewedLabel ? ` ${viewedLabel}` : ""}
              </div>
            )}
            <a
              href={property.listingUrl}
              target="_blank"
              rel="noreferrer"
              className="mt-1 block truncate text-xs text-mute hover:text-forest"
            >
              {property.listingUrl}
            </a>
          </div>

          <div style={{ order: 3 }} className="flex gap-2.5">
            {stats.map(([k, v]) => (
              <div key={k} className="flex-1 rounded-xl border border-line bg-white p-3 text-center">
                <div className="font-serif text-2xl leading-tight">{v}</div>
                <div className="text-[11px] text-mute">{k}</div>
              </div>
            ))}
          </div>

          {floorplan && (
            <div style={{ order: 5 }} className="card p-4">
              <div className="label-cap mb-2.5">Floorplan</div>
              <a
                href={imageUrl(floorplan)}
                target="_blank"
                rel="noreferrer"
                className="block overflow-hidden rounded-[10px] bg-white"
              >
                {/* eslint-disable-next-line @next/next/no-img-element */}
                <img
                  src={imageUrl(floorplan)}
                  alt="Floorplan"
                  className="h-auto w-full object-contain"
                />
              </a>
            </div>
          )}

          <div style={{ order: 7 }} className="card p-4">
            <div className="label-cap mb-2.5">Home &amp; grounds</div>
            <dl className="flex flex-col gap-2.5 text-[13px]">
              {homeFacts.map(([k, v], i) => (
                <div
                  key={k}
                  className={`flex justify-between gap-4 ${
                    i < homeFacts.length - 1 ? "border-b border-hairline pb-2.5" : ""
                  }`}
                >
                  <dt className="min-w-0 text-mute">{k}</dt>
                  <dd className="min-w-0 break-words text-right font-medium">{v}</dd>
                </div>
              ))}
            </dl>
            <div className="mt-3.5">
              <MetadataEditor
                propertyId={property.id}
                initial={{
                  hasEaves: property.hasEaves,
                  masterBedSqm: property.masterBedSqm,
                  avgOtherBedSqm: property.avgOtherBedSqm,
                  commonAreasCount: property.commonAreasCount,
                  balconySqm: property.balconySqm,
                  backGardenSqm: property.backGardenSqm,
                  pergolaCovered: property.pergolaCovered,
                  hasLawn: property.hasLawn,
                  lawnType: property.lawnType,
                  floodOverlay: property.floodOverlay,
                  bushfireOverlay: property.bushfireOverlay,
                  altitudeM: property.altitudeM,
                }}
              />
            </div>
          </div>

          {/* PropertyRail takes no style prop, so wrap it for the order hook. */}
          <div style={{ order: 9 }}>
            <PropertyRail
              property={property}
              ratings={ratings}
              notes={
                <div className="card p-4">
                  <div className="label-cap mb-2.5">My notes</div>
                  <NotesEditor propertyId={property.id} initial={property.domainNotes} />
                </div>
              }
            />
          </div>

          {property.aiComment && (
            <div style={{ order: 11 }} className="rounded-[14px] border border-sand-line bg-sand p-4">
              <div className="mb-2 text-[12.5px] font-semibold uppercase text-amber">
                Claude&apos;s take
              </div>
              <p className="text-[13px] italic leading-relaxed text-[#5a5344]">
                {property.aiComment}
              </p>
            </div>
          )}

          <div style={{ order: 13 }} className="card p-4">
            <div className="label-cap mb-2.5">Listing details</div>
            <dl className="flex flex-col gap-2 text-[13px]">
              {listingFacts.map(([k, v]) => (
                <div key={k} className="flex justify-between gap-4">
                  <dt className="min-w-0 text-mute">{k}</dt>
                  <dd className="min-w-0 break-words text-right font-medium">{v}</dd>
                </div>
              ))}
            </dl>
          </div>
        </div>
      </div>
    </section>
  );
}
