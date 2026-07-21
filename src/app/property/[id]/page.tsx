import Link from "next/link";
import { notFound } from "next/navigation";
import {
  getProperty,
  getPropertyImages,
  getPriceHistory,
  getPropertyRatings,
} from "@/db/queries/properties";
import PhotoGrid from "@/components/PhotoGrid";
import PropertyMap from "@/components/PropertyMap";
import NotesEditor from "@/components/NotesEditor";
import RatingControls from "@/components/RatingControls";
import MetadataEditor from "@/components/MetadataEditor";
import { imageUrl } from "@/lib/images";
import {
  formatPrice,
  bedBathCar,
  fmtNum,
  fmtDistance,
  fmtMinutes,
} from "@/lib/format";

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

  // 0/1/null → Yes/No/—  (null = not yet deduced from photos).
  const yesNo = (v: number | null) => (v == null ? "—" : v ? "Yes" : "No");

  const facts: [string, string][] = [
    ["Price", formatPrice(property.priceDisplay, property.priceNumeric)],
    ["Beds / Baths / Car", bedBathCar(property.beds, property.baths, property.parking)],
    ["Property type", property.propertyType ?? "—"],
    ["Land size", fmtNum(property.landSizeSqm, " m²")],
    ["Suburb", [property.suburb, property.state, property.postcode].filter(Boolean).join(" ") || "—"],
    [
      "Nearest station (straight-line)",
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
      "Transit to Flinders St (7:30am)",
      property.ptMinutesToFlinders != null
        ? fmtMinutes(property.ptMinutesToFlinders) +
          (property.ptRouteSummary ? ` · ${property.ptRouteSummary}` : "")
        : "—",
    ],
    ["Green Cross vet (Werribee)", fmtDistance(property.greenCrossDistanceM)],
    [
      "Nearest Coles",
      property.colesDistanceM != null
        ? `${property.colesName ?? "Coles"} · ${fmtDistance(property.colesDistanceM)}`
        : "—",
    ],
    ["Playgrounds within 500m", fmtNum(property.playgrounds500m)],
    ["Altitude", fmtNum(property.altitudeM, " m")],
    // Deduced-from-photos metadata (tasks 5 & 10). "—" until harvested/deduced.
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
    ["Flood overlay", yesNo(property.floodOverlay)],
    ["Bushfire overlay", yesNo(property.bushfireOverlay)],
    ["Agent", [property.agentName, property.agencyName].filter(Boolean).join(", ") || "—"],
    ["Source", property.sourceSite],
    ["Status", property.scrapeStatus],
  ];

  const hero = images[0] ?? null;

  return (
    <div className="space-y-6">
      <div className="sticky top-0 z-30 -mx-6 flex items-center gap-3 border-b border-neutral-200 bg-white/90 px-6 py-2 backdrop-blur dark:border-neutral-800 dark:bg-neutral-950/90">
        {hero && (
          // eslint-disable-next-line @next/next/no-img-element
          <img
            src={imageUrl(hero)}
            alt=""
            /* Task 11: doubled diagonal (h-10 w-14 → h-20 w-28). */
            className="h-20 w-28 shrink-0 rounded object-cover"
          />
        )}
        <span className="truncate font-medium">
          {property.address ?? property.listingUrl}
        </span>
      </div>
      <Link href="/" className="text-sm text-blue-600 hover:underline">
        ← Back
      </Link>
      <div>
        <h1 className="text-xl font-semibold">
          {property.address ?? property.listingUrl}
        </h1>
        <a
          href={property.listingUrl}
          target="_blank"
          rel="noreferrer"
          className="text-sm text-neutral-500 hover:underline"
        >
          {property.listingUrl}
        </a>
      </div>

      {property.advPricePrevious && property.advPriceCurrent && (
        <div className="flex flex-wrap gap-x-10 gap-y-2 rounded-lg border border-amber-300 bg-amber-50 p-4 dark:border-amber-800/60 dark:bg-amber-950/30">
          <div>
            <div className="text-xs text-neutral-500">
              {property.advPricePreviousLabel ?? "Previous price"}
            </div>
            <div className="text-lg font-semibold text-neutral-500 line-through decoration-1">
              {property.advPricePrevious}
            </div>
          </div>
          <div>
            <div className="text-xs text-neutral-500">Current price</div>
            <div className="text-lg font-bold">{property.advPriceCurrent}</div>
          </div>
        </div>
      )}

      {property.aiComment && (
        <div className="rounded-lg border border-blue-300 bg-blue-50 p-4 text-sm dark:border-blue-900/60 dark:bg-blue-950/30">
          <div className="mb-1 text-xs font-semibold uppercase tracking-wide text-blue-700 dark:text-blue-400">
            Claude&apos;s take
          </div>
          <p className="text-neutral-700 dark:text-neutral-200">{property.aiComment}</p>
        </div>
      )}

      {property.scrapeStatus === "error" && (
        <div className="rounded-md border border-red-300 bg-red-50 p-3 text-sm text-red-700 dark:bg-red-950/40">
          Scrape error: {property.scrapeError ?? "unknown"}
        </div>
      )}

      {/* Task 16.1: cap the property metadata at 1920px on ultra-wide screens. */}
      <dl className="grid max-w-[1920px] grid-cols-2 gap-x-6 gap-y-2 rounded-lg border border-neutral-200 p-4 text-sm dark:border-neutral-800 sm:grid-cols-4">
        {facts.map(([k, v]) => (
          <div key={k}>
            <dt className="text-neutral-400">{k}</dt>
            <dd className="font-medium">{v}</dd>
          </div>
        ))}
      </dl>

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

      <PropertyMap
        lat={property.latitude}
        lng={property.longitude}
        address={property.address}
      />

      <div className="grid gap-6 md:grid-cols-2">
        <div>
          <h2 className="mb-2 text-sm font-semibold">Vibe ratings</h2>
          <RatingControls propertyId={property.id} ratings={ratings} />
        </div>
        <div>
          <h2 className="mb-2 text-sm font-semibold">My notes</h2>
          <NotesEditor propertyId={property.id} initial={property.domainNotes} />
        </div>
      </div>

      {property.ptSteps && (
        <div className="rounded-lg border border-neutral-200 p-4 text-sm dark:border-neutral-800">
          <div className="mb-1 font-semibold">
            Commute to Flinders St — {fmtMinutes(property.ptMinutesToFlinders)}{" "}
            <span className="font-normal text-neutral-400">
              (leaving ~7:30am, weekday)
            </span>
          </div>
          <p className="text-neutral-600 dark:text-neutral-300">{property.ptSteps}</p>
        </div>
      )}

      {property.description && (
        <p className="whitespace-pre-line text-sm text-neutral-600 dark:text-neutral-300">
          {property.description}
        </p>
      )}

      {history.length > 0 && (
        <div>
          <h2 className="mb-2 text-sm font-semibold">Price history</h2>
          <table className="text-sm">
            <tbody>
              {history.map((h) => (
                <tr key={h.id} className="border-b border-neutral-100 dark:border-neutral-800/50">
                  <td className="py-1 pr-4 text-neutral-400">{h.date ?? "—"}</td>
                  <td className="py-1 pr-4">{h.event ?? "—"}</td>
                  <td className="py-1 font-medium">
                    {formatPrice(h.priceDisplay, h.priceNumeric)}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      <div>
        <h2 className="mb-3 text-sm font-semibold">
          Photos ({images.length}){" "}
          <span className="font-normal text-neutral-400">
            — click to zoom &amp; correct the room tag
          </span>
        </h2>
        <PhotoGrid images={images} />
      </div>
    </div>
  );
}
