import Link from "next/link";
import {
  getPropertiesByIds,
  getPropertyImages,
  getRatingsByProperty,
  type ImageWithTag,
} from "@/db/queries/properties";
import { vibeScore } from "@/lib/vibes";
import { formatPrice, fmtNum, fmtDistance, fmtMinutes } from "@/lib/format";
import CompareRooms, { type CompareCol } from "@/components/CompareRooms";
import PropertyMap, { AreaPhotos } from "@/components/PropertyMap";
import { imageUrl } from "@/lib/images";
import type { PhotoLite } from "@/lib/photo";
import type { Property } from "@/db/schema";

export const dynamic = "force-dynamic";

type Better = "min" | "max" | null;

interface Row {
  label: string;
  better: Better;
  value: (p: Property) => string;
  num: (p: Property) => number | null;
}

const ROWS: Row[] = [
  {
    label: "Price",
    better: "min",
    value: (p) => formatPrice(p.priceDisplay, p.priceNumeric),
    num: (p) => p.priceNumeric,
  },
  { label: "Beds", better: "max", value: (p) => fmtNum(p.beds), num: (p) => p.beds },
  { label: "Baths", better: "max", value: (p) => fmtNum(p.baths), num: (p) => p.baths },
  { label: "Parking", better: "max", value: (p) => fmtNum(p.parking), num: (p) => p.parking },
  {
    label: "Land size",
    better: "max",
    value: (p) => fmtNum(p.landSizeSqm, " m²"),
    num: (p) => p.landSizeSqm,
  },
  {
    label: "Type",
    better: null,
    value: (p) => p.propertyType ?? "—",
    num: () => null,
  },
  {
    label: "Nearest station",
    better: "min",
    value: (p) =>
      p.nearestStation
        ? `${p.nearestStation} · ${fmtDistance(p.stationDistanceM)}`
        : "—",
    num: (p) => p.stationDistanceM,
  },
  {
    label: "Next-closest station",
    better: "min",
    value: (p) =>
      p.secondStation
        ? `${p.secondStation} · ${fmtDistance(p.secondStationDistanceM)}`
        : "—",
    num: (p) => p.secondStationDistanceM,
  },
  {
    label: "Transit to Flinders St",
    better: "min",
    value: (p) =>
      p.ptMinutesToFlinders != null ? fmtMinutes(p.ptMinutesToFlinders) : "—",
    num: (p) => p.ptMinutesToFlinders,
  },
  {
    label: "Journey (fastest, ~7:30am)",
    better: null,
    value: (p) => p.ptSteps ?? "—",
    num: () => null,
  },
  {
    label: "Green Cross vet (Werribee)",
    better: "min",
    value: (p) => fmtDistance(p.greenCrossDistanceM),
    num: (p) => p.greenCrossDistanceM,
  },
  {
    label: "Nearest Coles",
    better: "min",
    value: (p) =>
      p.colesDistanceM != null
        ? `${p.colesName ?? "Coles"} · ${fmtDistance(p.colesDistanceM)}`
        : "—",
    num: (p) => p.colesDistanceM,
  },
  {
    label: "Playgrounds ≤500m",
    better: "max",
    value: (p) => fmtNum(p.playgrounds500m),
    num: (p) => p.playgrounds500m,
  },
  // Deduced-from-photos metadata (tasks 5 & 10). "—" until harvested.
  {
    label: "All-around eaves",
    better: "max",
    value: (p) => (p.hasEaves == null ? "—" : p.hasEaves ? "Yes" : "No"),
    num: (p) => p.hasEaves,
  },
  {
    label: "Master bedroom",
    better: "max",
    value: (p) => fmtNum(p.masterBedSqm, " m²"),
    num: (p) => p.masterBedSqm,
  },
  {
    label: "Other bedrooms (avg)",
    better: "max",
    value: (p) => fmtNum(p.avgOtherBedSqm, " m²"),
    num: (p) => p.avgOtherBedSqm,
  },
  {
    label: "Common areas",
    better: "max",
    value: (p) => fmtNum(p.commonAreasCount),
    num: (p) => p.commonAreasCount,
  },
  {
    label: "Back garden",
    better: "max",
    value: (p) => fmtNum(p.backGardenSqm, " m²"),
    num: (p) => p.backGardenSqm,
  },
  {
    label: "Covered pergola/deck",
    better: "max",
    value: (p) => (p.pergolaCovered == null ? "—" : p.pergolaCovered ? "Yes" : "No"),
    num: (p) => p.pergolaCovered,
  },
  {
    label: "Lawn",
    better: null,
    value: (p) =>
      p.hasLawn == null
        ? "—"
        : p.hasLawn
          ? p.lawnType
            ? `Yes · ${p.lawnType}`
            : "Yes"
          : "No",
    num: () => null,
  },
  {
    label: "Suburb",
    better: null,
    value: (p) =>
      [p.suburb, p.state, p.postcode].filter(Boolean).join(" ") || "—",
    num: () => null,
  },
  {
    label: "Agent",
    better: null,
    value: (p) => [p.agentName, p.agencyName].filter(Boolean).join(", ") || "—",
    num: () => null,
  },
];

function bestIndex(nums: (number | null)[], better: Better): Set<number> {
  if (!better) return new Set();
  const vals = nums.filter((n): n is number => n != null);
  if (vals.length < 2) return new Set();
  const target = better === "min" ? Math.min(...vals) : Math.max(...vals);
  const out = new Set<number>();
  nums.forEach((n, i) => {
    if (n === target) out.add(i);
  });
  return out;
}

/** Group a property's photos by room key ("master" = bedroom tagged master). */
function roomsFromImages(imgs: ImageWithTag[]): Record<string, PhotoLite[]> {
  const rooms: Record<string, PhotoLite[]> = {};
  for (const img of imgs) {
    if (!img.roomType) continue;
    const lite: PhotoLite = {
      id: img.id,
      localPath: img.localPath,
      roomType: img.roomType,
      notes: img.notes,
    };
    (rooms[img.roomType] ??= []).push(lite);
    if (
      img.roomType === "bedroom" &&
      (img.notes ?? "").toLowerCase().includes("master")
    ) {
      (rooms.master ??= []).push(lite);
    }
  }
  return rooms;
}

export default async function ComparePage({
  searchParams,
}: {
  searchParams: Promise<{ ids?: string }>;
}) {
  const { ids: idsParam } = await searchParams;
  const ids = (idsParam ?? "").split(",").filter(Boolean).slice(0, 4);
  const props = getPropertiesByIds(ids);

  if (props.length < 2) {
    return (
      <section className="rise py-20 text-center">
        <h1 className="mb-2 font-serif text-3xl">Nothing to compare yet</h1>
        <p className="mb-6 text-sm text-mute">
          Pick 2–4 properties from the grid to line them up side by side.
        </p>
        <Link href="/" className="btn-primary inline-block">
          Browse properties
        </Link>
      </section>
    );
  }

  // Overall winner = best vibes score. ponytail: server-side, so it uses the
  // DEFAULT weights — the per-browser config tweaks only affect client views.
  const ratingsByProp = getRatingsByProperty(ids);
  const vibes = props.map((p) => vibeScore(p, ratingsByProp.get(p.id) ?? []));
  const winner = vibes.indexOf(Math.max(...vibes));

  const imgsByProp = new Map(props.map((p) => [p.id, getPropertyImages(p.id)]));
  const heroOf = (id: string) => imgsByProp.get(id)?.[0] ?? null;
  const roomCols: CompareCol[] = props.map((p) => ({
    propertyId: p.id,
    address: p.address,
    rooms: roomsFromImages(imgsByProp.get(p.id) ?? []),
  }));

  return (
    <section className="rise space-y-10">
      <div>
        <div className="eyebrow mb-1.5">Side by side</div>
        <div className="flex flex-wrap items-baseline gap-3.5">
          <h1 className="font-serif text-[38px] leading-none">
            Comparing {props.length} properties
          </h1>
          <span className="text-[13px] text-mute">
            Best value per row is highlighted ✓
          </span>
        </div>
      </div>

      <div className="overflow-x-auto">
        <table className="w-full min-w-[720px] border-collapse text-sm">
          <thead>
            <tr>
              <th className="w-40 p-0" />
              {props.map((p, i) => {
                const hero = heroOf(p.id);
                const isWinner = i === winner;
                return (
                  <th key={p.id} className="p-0 pr-3.5 text-left align-bottom">
                    <div
                      className={`overflow-hidden rounded-t-2xl border-2 border-b-0 bg-white ${
                        isWinner ? "border-forest" : "border-line"
                      }`}
                    >
                      <div className="relative h-[150px] bg-fill">
                        {isWinner && (
                          <span className="absolute left-2.5 top-2.5 z-10 rounded-lg bg-forest px-2.5 py-1 text-[11px] font-bold text-linen">
                            ✦ Best match · {vibes[i]}
                          </span>
                        )}
                        {hero ? (
                          // eslint-disable-next-line @next/next/no-img-element
                          <img
                            src={imageUrl(hero)}
                            alt={p.address ?? "property"}
                            loading="lazy"
                            className="h-full w-full object-cover"
                          />
                        ) : (
                          <div className="flex h-full items-center justify-center text-xs text-mute">
                            no image
                          </div>
                        )}
                      </div>
                      <Link href={`/property/${p.id}`} className="block px-3.5 py-3">
                        <div className="font-serif text-[18px] leading-tight">
                          {p.address ?? p.listingUrl}
                        </div>
                        <div className="mt-1 text-[11px] uppercase tracking-wide text-mute">
                          {p.sourceSite}
                          {p.suburb ? ` · ${p.suburb}` : ""}
                        </div>
                      </Link>
                    </div>
                  </th>
                );
              })}
            </tr>
          </thead>
          <tbody className="bg-white">
            {ROWS.map((row) => {
              const best = bestIndex(
                props.map((p) => row.num(p)),
                row.better,
              );
              return (
                <tr key={row.label} className="border-t border-hairline">
                  <td className="px-4 py-3 text-[12.5px] font-semibold text-mute">
                    {row.label}
                  </td>
                  {props.map((p, i) => (
                    <td
                      key={p.id}
                      className={`px-3.5 py-3 text-[13.5px] leading-snug ${
                        best.has(i) ? "bg-[#F2F6F2] font-semibold text-forest" : ""
                      }`}
                    >
                      {best.has(i) && <span className="mr-1.5">✓</span>}
                      {row.value(p)}
                    </td>
                  ))}
                </tr>
              );
            })}
            <tr className="border-t border-hairline">
              <td className="px-4 py-3 align-top text-[12.5px] font-semibold text-mute">
                My notes
              </td>
              {props.map((p) => (
                <td key={p.id} className="px-3.5 py-3 align-top text-[13px] text-[#5B5A52]">
                  <span className="whitespace-pre-line">{p.domainNotes ?? "—"}</span>
                </td>
              ))}
            </tr>
            <tr className="border-y border-hairline">
              <td className="px-4 py-3 align-top text-[12.5px] font-semibold text-mute">
                Claude&apos;s take
              </td>
              {props.map((p) => (
                <td key={p.id} className="px-3.5 py-3 align-top">
                  <div className="rounded-xl border border-sand-line bg-sand px-3.5 py-3 text-[12.5px] italic leading-relaxed text-[#5a5344]">
                    {p.aiComment ?? "—"}
                  </div>
                </td>
              ))}
            </tr>
            <tr>
              <td className="px-4 py-3 align-top text-[12.5px] font-semibold text-mute">
                Map
              </td>
              {props.map((p) => (
                <td key={p.id} className="px-3.5 py-3 align-top">
                  <PropertyMap
                    lat={p.latitude}
                    lng={p.longitude}
                    address={p.address}
                    className="h-56"
                  />
                </td>
              ))}
            </tr>
          </tbody>
        </table>
      </div>

      <div>
        <div className="mb-3.5 flex flex-wrap items-baseline gap-3.5">
          <h2 className="font-serif text-[28px]">Room by room</h2>
          <span className="text-[13px] text-mute">
            Click a room label for side-by-side carousels, or any photo to zoom ·{" "}
            <Link href="/rooms" className="text-forest hover:text-forest-hi">
              open full rooms view →
            </Link>
          </span>
        </div>
        <CompareRooms columns={roomCols} />
      </div>

      <div>
        <div className="mb-3.5 flex flex-wrap items-baseline gap-3.5">
          <h2 className="font-serif text-[28px]">Around the street</h2>
          <span className="text-[13px] text-mute">
            10 street-view snapshots around each property
          </span>
        </div>
        <div className="overflow-x-auto">
          <div className="flex gap-4">
            {props.map((p) => (
              <div key={p.id} className="w-[28rem] shrink-0">
                <div
                  className="mb-2 truncate font-serif text-base"
                  title={p.address ?? ""}
                >
                  {p.address ?? p.id}
                </div>
                <AreaPhotos lat={p.latitude} lng={p.longitude} seed={p.id} />
              </div>
            ))}
          </div>
        </div>
      </div>
    </section>
  );
}
