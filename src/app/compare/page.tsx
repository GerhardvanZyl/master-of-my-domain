import Link from "next/link";
import {
  getPropertiesByIds,
  getPropertyImages,
  type ImageWithTag,
} from "@/db/queries/properties";
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
      <div className="space-y-3">
        <h1 className="text-lg font-semibold">Compare properties</h1>
        <p className="text-sm text-neutral-500">
          Select 2–4 properties on the{" "}
          <Link href="/" className="text-blue-600 hover:underline">
            home page
          </Link>{" "}
          (tick the “compare” box) to see them side by side.
        </p>
      </div>
    );
  }

  const imgsByProp = new Map(props.map((p) => [p.id, getPropertyImages(p.id)]));
  const heroOf = (id: string) => imgsByProp.get(id)?.[0] ?? null;
  const roomCols: CompareCol[] = props.map((p) => ({
    propertyId: p.id,
    address: p.address,
    rooms: roomsFromImages(imgsByProp.get(p.id) ?? []),
  }));

  return (
    <div className="space-y-6">
      <div className="sticky top-0 z-30 -mx-6 flex gap-4 overflow-x-auto border-b border-neutral-200 bg-white/90 px-6 py-2 backdrop-blur dark:border-neutral-800 dark:bg-neutral-950/90">
        {props.map((p) => {
          const hero = heroOf(p.id);
          return (
            <div key={p.id} className="flex min-w-0 flex-1 items-center gap-2">
              {hero && (
                // eslint-disable-next-line @next/next/no-img-element
                <img
                  src={imageUrl(hero)}
                  alt=""
                  className="h-9 w-12 shrink-0 rounded object-cover"
                />
              )}
              <span className="truncate text-sm font-medium">
                {p.address ?? p.listingUrl}
              </span>
            </div>
          );
        })}
      </div>
      <h1 className="text-lg font-semibold">Comparing {props.length} properties</h1>
      <div className="overflow-x-auto">
        <table className="w-full min-w-[640px] border-collapse text-sm">
          <thead>
            <tr>
              <th className="w-32 border-b border-neutral-200 p-2 text-left dark:border-neutral-800" />
              {props.map((p) => {
                const hero = heroOf(p.id);
                return (
                  <th
                    key={p.id}
                    className="border-b border-neutral-200 p-2 text-left align-bottom dark:border-neutral-800"
                  >
                    <Link href={`/property/${p.id}`} className="block">
                      {hero ? (
                        // eslint-disable-next-line @next/next/no-img-element
                        <img
                          src={imageUrl(hero)}
                          alt={p.address ?? "property"}
                          loading="lazy"
                          className="mb-2 aspect-[4/3] w-full rounded-md object-cover"
                        />
                      ) : (
                        <div className="mb-2 flex aspect-[4/3] w-full items-center justify-center rounded-md bg-neutral-100 text-xs text-neutral-400 dark:bg-neutral-800">
                          no image
                        </div>
                      )}
                      <span className="font-medium hover:underline">
                        {p.address ?? p.listingUrl}
                      </span>
                    </Link>
                    <div className="text-xs uppercase text-neutral-400">
                      {p.sourceSite}
                    </div>
                  </th>
                );
              })}
            </tr>
          </thead>
          <tbody>
            {ROWS.map((row) => {
              const best = bestIndex(
                props.map((p) => row.num(p)),
                row.better,
              );
              return (
                <tr key={row.label}>
                  <td className="border-b border-neutral-100 p-2 font-medium text-neutral-400 dark:border-neutral-800/50">
                    {row.label}
                  </td>
                  {props.map((p, i) => (
                    <td
                      key={p.id}
                      className={`border-b border-neutral-100 p-2 dark:border-neutral-800/50 ${
                        best.has(i)
                          ? "font-semibold text-green-600 dark:text-green-400"
                          : ""
                      }`}
                    >
                      {row.value(p)}
                    </td>
                  ))}
                </tr>
              );
            })}
            <tr>
              <td className="p-2 align-top font-medium text-neutral-400">Map</td>
              {props.map((p) => (
                <td key={p.id} className="p-2 align-top">
                  <PropertyMap
                    lat={p.latitude}
                    lng={p.longitude}
                    address={p.address}
                    className="h-64"
                  />
                </td>
              ))}
            </tr>
            <tr>
              <td className="border-b border-neutral-100 p-2 align-top font-medium text-neutral-400 dark:border-neutral-800/50">
                My notes
              </td>
              {props.map((p) => (
                <td
                  key={p.id}
                  className="border-b border-neutral-100 p-2 align-top text-neutral-600 dark:border-neutral-800/50 dark:text-neutral-300"
                >
                  <span className="whitespace-pre-line">{p.domainNotes ?? "—"}</span>
                </td>
              ))}
            </tr>
            <tr>
              <td className="border-b border-neutral-100 p-2 align-top font-medium text-neutral-400 dark:border-neutral-800/50">
                Claude&apos;s take
              </td>
              {props.map((p) => (
                <td
                  key={p.id}
                  className="border-b border-neutral-100 p-2 align-top text-neutral-600 dark:border-neutral-800/50 dark:text-neutral-300"
                >
                  {p.aiComment ?? "—"}
                </td>
              ))}
            </tr>
          </tbody>
        </table>
      </div>

      <div className="space-y-3">
        <h2 className="text-sm font-semibold">
          Photos by room{" "}
          <span className="font-normal text-neutral-400">
            — click a room label for side-by-side carousels, or any photo to zoom
          </span>
        </h2>
        <CompareRooms columns={roomCols} />
      </div>

      <div className="space-y-3">
        <h2 className="text-sm font-semibold">
          Area photos{" "}
          <span className="font-normal text-neutral-400">
            — 10 street-view snapshots around each property
          </span>
        </h2>
        <div className="overflow-x-auto">
          <div className="flex gap-4">
            {props.map((p) => (
              <div key={p.id} className="w-[28rem] shrink-0">
                <div className="mb-2 truncate text-sm font-medium" title={p.address ?? ""}>
                  {p.address ?? p.id}
                </div>
                <AreaPhotos lat={p.latitude} lng={p.longitude} seed={p.id} />
              </div>
            ))}
          </div>
        </div>
      </div>
    </div>
  );
}
