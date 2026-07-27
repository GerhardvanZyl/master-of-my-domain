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
import MediaUploader from "@/components/MediaUploader";
import MetadataEditor from "@/components/MetadataEditor";
import { listMedia } from "@/lib/media";
import { imageUrl } from "@/lib/images";
import { formatPrice, fmtNum, fmtDistance, fmtMinutes, isTransitEstimated } from "@/lib/format";
import { formatInspection } from "@/lib/inspection";

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
      `Transit to ${property.state === "NSW" ? "Museum Stn" : "Flinders St"} (7:30am)`,
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

  const listingFacts: [string, string][] = [
    ["Property type", property.propertyType ?? "—"],
    ["Suburb", [property.suburb, property.state, property.postcode].filter(Boolean).join(" ") || "—"],
    ["Agent", [property.agentName, property.agencyName].filter(Boolean).join(", ") || "—"],
    ["Source", property.sourceSite],
    ["Status", property.scrapeStatus],
  ];

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
  const soldRow = history.find((h) => /sold/i.test(h.event ?? ""));

  return (
    <section className="rise">
      <Link
        href="/"
        className="mb-4 inline-block text-[13px] font-medium text-[#5B5A52] hover:text-forest"
      >
        ← All properties
      </Link>

      {delisted && (
        <div className="mb-4 flex items-center gap-2 rounded-xl border border-[#e0b4ac] bg-[#fbeeeb] px-4 py-3 text-sm font-medium text-[#B84A3A]">
          <span className="text-base">⚠</span>
          {saleStatus === "sold" ? (
            <span>
              Sold — no longer listed on Domain
              {soldRow?.priceDisplay ? ` (${soldRow.priceDisplay})` : ""}. Your
              ratings and notes are kept.
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

      <div className="grid grid-cols-1 items-start gap-7 lg:grid-cols-[1.5fr_1fr]">
        {/* LEFT */}
        <div className="space-y-4">
          <HeroGallery
            images={images}
            heroIndex={heroIndex}
            showcaseIndices={showcaseIndices}
            alt={property.address ?? "property"}
          />

          {property.scrapeStatus === "error" && (
            <div className="rounded-xl border border-[#e0b4ac] bg-[#fbeeeb] p-3 text-sm text-[#B84A3A]">
              Scrape error: {property.scrapeError ?? "unknown"}
            </div>
          )}

          <div className="card p-[18px]">
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

          <div className="card p-4">
            <div className="mb-2.5 flex items-center justify-between">
              <h2 className="font-serif text-lg">Listing photos</h2>
              <span className="text-[11.5px] text-mute">
                {images.length} photos · click to zoom &amp; correct the room tag
              </span>
            </div>
            <PhotoGrid images={images} />
          </div>

          <MediaUploader propertyId={property.id} initial={media} />

          <div className="card p-[18px]">
            <h2 className="mb-3.5 font-serif text-[22px]">Home &amp; grounds</h2>
            <dl className="flex flex-col gap-2.5 text-[13.5px]">
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

          {property.description && (
            <div className="card p-[18px]">
              <h2 className="mb-2 font-serif text-[22px]">Listing description</h2>
              <p className="whitespace-pre-line text-sm leading-relaxed text-[#5B5A52]">
                {property.description}
              </p>
            </div>
          )}

          {history.length > 0 && (
            <div className="card p-[18px]">
              <h2 className="mb-2.5 font-serif text-[22px]">Price history</h2>
              <table className="w-full text-sm">
                <tbody>
                  {history.map((h) => (
                    <tr key={h.id} className="border-b border-hairline last:border-0">
                      <td className="py-1.5 pr-4 text-mute">{h.date ?? "—"}</td>
                      <td className="py-1.5 pr-4">{h.event ?? "—"}</td>
                      <td className="py-1.5 text-right font-medium">
                        {formatPrice(h.priceDisplay, h.priceNumeric)}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>

        {/* RIGHT RAIL */}
        <div className="flex flex-col gap-4 lg:sticky lg:top-[84px]">
          <div>
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
            <a
              href={property.listingUrl}
              target="_blank"
              rel="noreferrer"
              className="mt-1 block truncate text-xs text-mute hover:text-forest"
            >
              {property.listingUrl}
            </a>
          </div>

          <div className="flex gap-2.5">
            {stats.map(([k, v]) => (
              <div key={k} className="flex-1 rounded-xl border border-line bg-white p-3 text-center">
                <div className="font-serif text-2xl leading-tight">{v}</div>
                <div className="text-[11px] text-mute">{k}</div>
              </div>
            ))}
          </div>

          <PropertyRail property={property} ratings={ratings} />

          <div className="card p-4">
            <div className="label-cap mb-2.5">My notes</div>
            <NotesEditor propertyId={property.id} initial={property.domainNotes} />
          </div>

          {floorplan && (
            <div className="card p-4">
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

          {property.aiComment && (
            <div className="rounded-[14px] border border-sand-line bg-sand p-4">
              <div className="mb-2 text-[12.5px] font-semibold uppercase text-amber">
                Claude&apos;s take
              </div>
              <p className="text-[13px] italic leading-relaxed text-[#5a5344]">
                {property.aiComment}
              </p>
            </div>
          )}

          <div className="card p-4">
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
