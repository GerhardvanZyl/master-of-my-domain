import Link from "next/link";
import { notFound } from "next/navigation";
import { getProperty, getPropertyImages } from "@/db/queries/properties";
import { imageUrl } from "@/lib/images";
import { formatPrice, bedBathCar, fmtNum } from "@/lib/format";

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

  const facts: [string, string][] = [
    ["Price", formatPrice(property.priceDisplay, property.priceNumeric)],
    ["Beds / Baths / Car", bedBathCar(property.beds, property.baths, property.parking)],
    ["Property type", property.propertyType ?? "—"],
    ["Land size", fmtNum(property.landSizeSqm, " m²")],
    ["Suburb", [property.suburb, property.state, property.postcode].filter(Boolean).join(" ") || "—"],
    ["Agent", [property.agentName, property.agencyName].filter(Boolean).join(", ") || "—"],
    ["Source", property.sourceSite],
    ["Status", property.scrapeStatus],
  ];

  return (
    <div className="space-y-6">
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

      {property.scrapeStatus === "error" && (
        <div className="rounded-md border border-red-300 bg-red-50 p-3 text-sm text-red-700 dark:bg-red-950/40">
          Scrape error: {property.scrapeError ?? "unknown"}
        </div>
      )}

      <dl className="grid grid-cols-2 gap-x-6 gap-y-2 rounded-lg border border-neutral-200 p-4 text-sm dark:border-neutral-800 sm:grid-cols-4">
        {facts.map(([k, v]) => (
          <div key={k}>
            <dt className="text-neutral-400">{k}</dt>
            <dd className="font-medium">{v}</dd>
          </div>
        ))}
      </dl>

      {property.description && (
        <p className="whitespace-pre-line text-sm text-neutral-600 dark:text-neutral-300">
          {property.description}
        </p>
      )}

      <div>
        <h2 className="mb-3 text-sm font-semibold">Photos ({images.length})</h2>
        <div className="grid grid-cols-2 gap-2 sm:grid-cols-3 md:grid-cols-4">
          {images.map((img) => (
            <div
              key={img.id}
              className="relative overflow-hidden rounded-md bg-neutral-100 dark:bg-neutral-800"
            >
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img
                src={imageUrl(img)}
                alt={img.roomType ?? "photo"}
                loading="lazy"
                className="aspect-[4/3] w-full object-cover"
              />
              {img.roomType && (
                <span className="absolute left-1 top-1 rounded bg-black/70 px-1.5 py-0.5 text-[10px] font-medium uppercase tracking-wide text-white">
                  {img.roomType}
                </span>
              )}
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
