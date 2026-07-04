import Link from "next/link";
import { getPropertiesByIds, getPropertyImages } from "@/db/queries/properties";
import { imageUrl } from "@/lib/images";
import { formatPrice, bedBathCar, fmtNum } from "@/lib/format";
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

  const galleries = props.map((p) => getPropertyImages(p.id).slice(0, 6));

  return (
    <div className="space-y-6">
      <h1 className="text-lg font-semibold">Comparing {props.length} properties</h1>
      <div className="overflow-x-auto">
        <table className="w-full min-w-[640px] border-collapse text-sm">
          <thead>
            <tr>
              <th className="w-32 border-b border-neutral-200 p-2 text-left dark:border-neutral-800" />
              {props.map((p) => (
                <th
                  key={p.id}
                  className="border-b border-neutral-200 p-2 text-left align-bottom dark:border-neutral-800"
                >
                  <Link
                    href={`/property/${p.id}`}
                    className="font-medium hover:underline"
                  >
                    {p.address ?? p.listingUrl}
                  </Link>
                  <div className="text-xs uppercase text-neutral-400">
                    {p.sourceSite}
                  </div>
                </th>
              ))}
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
              <td className="p-2 align-top font-medium text-neutral-400">
                Photos
              </td>
              {props.map((p, i) => (
                <td key={p.id} className="p-2 align-top">
                  <div className="grid grid-cols-2 gap-1">
                    {galleries[i].map((img) => (
                      // eslint-disable-next-line @next/next/no-img-element
                      <img
                        key={img.id}
                        src={imageUrl(img)}
                        alt={img.roomType ?? "photo"}
                        loading="lazy"
                        className="aspect-[4/3] w-full rounded object-cover"
                      />
                    ))}
                  </div>
                </td>
              ))}
            </tr>
          </tbody>
        </table>
      </div>
    </div>
  );
}
