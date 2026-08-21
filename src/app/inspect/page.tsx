import Image from "next/image";
import Link from "next/link";
import { listProperties } from "@/db/queries/properties";
import { formatInspection, groupByInspectionDay } from "@/lib/inspection";
import { priceLine, bedBathCar } from "@/lib/format";
import { imageUrl } from "@/lib/images";

export const dynamic = "force-dynamic";

/**
 * Saturday-route planning list: properties marked "to view" (i.e. not yet
 * viewed — the two are one enum now, so no extra check is needed),
 * grouped by their next open-for-inspection day. Server component, no vibes/
 * profile scoring — reuses listProperties() rather than PropertyGrid's
 * PropertyRow, which needs a profile score this page has no use for.
 */
export default function InspectPage() {
  const wanted = listProperties().filter(
    (p) => p.viewed === "to-view" && !p.delisted,
  );
  const groups = groupByInspectionDay(wanted);

  return (
    <section className="rise">
      <h1 className="mb-6 font-serif text-[40px] leading-none">Want to inspect</h1>

      {groups.length === 0 && (
        <p className="rounded-2xl border border-dashed border-line bg-paper p-16 text-center text-mute">
          Nothing marked “to view” yet.
        </p>
      )}

      {groups.length > 0 && (
        <div className="flex flex-col gap-8">
          {groups.map((g) => (
            <div key={g.day || "no-time"}>
              <h2 className="mb-3 font-serif text-[22px] text-ink">
                {g.day || "No time yet"}
              </h2>
              <div className="flex flex-col gap-3">
                {g.items.map((p) => {
                  const inspect = formatInspection(p.nextInspection);
                  const price = priceLine(p);
                  return (
                    <Link
                      key={p.id}
                      href={`/property/${p.id}`}
                      className="flex items-center gap-4 rounded-2xl border border-line bg-white p-3 hover:shadow-[0_6px_20px_rgba(0,0,0,.08)]"
                    >
                      {p.thumbPath && (
                        <div className="relative h-16 w-24 shrink-0 overflow-hidden rounded-lg bg-fill">
                          <Image
                            src={imageUrl({ localPath: p.thumbPath })}
                            alt={p.address ?? "property"}
                            fill
                            sizes="96px"
                            className="object-cover"
                          />
                        </div>
                      )}
                      <div className="w-20 shrink-0 text-[13.5px] font-semibold text-forest">
                        {inspect ? inspect.label.split(", ")[1] : "—"}
                      </div>
                      <div className="min-w-0 flex-1">
                        <div className="truncate font-medium text-ink">
                          {p.address ?? "—"}
                          {p.suburb ? `, ${p.suburb}` : ""}
                        </div>
                        <div className="text-[13px] text-mute">
                          {bedBathCar(p.beds, p.baths, p.parking)}
                        </div>
                      </div>
                      <div className="shrink-0 text-right text-[13.5px] font-semibold text-body">
                        {price.text}
                      </div>
                    </Link>
                  );
                })}
              </div>
            </div>
          ))}
        </div>
      )}
    </section>
  );
}
