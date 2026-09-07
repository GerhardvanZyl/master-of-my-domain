import Link from "next/link";
import Image from "next/image";
import { listPropertyChanges } from "@/db/queries/properties";
import { imageUrl } from "@/lib/images";
import { fmtRelative } from "@/lib/format";
import ClearWatchWatermark from "@/components/ClearWatchWatermark";

export const dynamic = "force-dynamic";

// Page size for the plain older/newer links — no infinite scroll, no
// client-side pagination state (ponytail: two-person LAN app). Paging moves
// `offset`, NOT `limit`: asking for a bigger limit dead-ends at the 2000 cap
// below, which re-caps every further request to the same 2000 newest rows.
const PAGE_SIZE = 200;

// Human label for a tracked field — local to this page, the rest of the app
// has no reason to know these names. Unmapped fields fall back to the raw
// snake_case name with underscores replaced, so a field added to
// db/queries/changes.ts later doesn't crash this page, just looks plainer.
const FIELD_LABELS: Record<string, string> = {
  price_display: "Price",
  price_numeric: "Price (exact)",
  next_inspection: "Inspection",
  beds: "Beds",
  baths: "Baths",
  parking: "Parking",
  land_size_sqm: "Land size",
  property_type: "Property type",
  address: "Address",
  agent_name: "Agent",
  agency_name: "Agency",
  sale_status: "Status",
  photos: "Photos",
  listing: "Listed",
};

function labelFor(field: string): string {
  return FIELD_LABELS[field] ?? field.replace(/_/g, " ");
}

/** null renders as "—", never the word "null". */
const fmt = (v: string | null): string => v ?? "—";

export default async function HistoryPage({
  searchParams,
}: {
  searchParams: Promise<{ watch?: string; limit?: string; offset?: string }>;
}) {
  const { watch: watchParam, limit: limitParam, offset: offsetParam } = await searchParams;
  const watch = watchParam === "1";
  const requested = Number(limitParam);
  // Must be a real integer (not "1.5") and capped (not "1e21") -- either one
  // used to bind straight into the SQLite LIMIT and throw "datatype mismatch".
  const limit = Number.isInteger(requested) && requested > 0 ? Math.min(requested, 2000) : PAGE_SIZE;
  // Same guard, and the cap is what Number.isSafeInteger does here: "1e21" is
  // an integer to Number.isInteger but cannot be bound as one.
  const skip = Number(offsetParam);
  const offset = Number.isSafeInteger(skip) && skip > 0 ? skip : 0;

  const changes = listPropertyChanges({ limit, offset, watchedOnly: watch });
  const hasMore = changes.length === limit;
  const pageHref = (at: number) => `/history?limit=${limit}&offset=${at}${watch ? "&watch=1" : ""}`;

  return (
    <section className="rise">
      {watch && <ClearWatchWatermark />}
      <h1 className="mb-6 font-serif text-[40px] leading-none">Property history</h1>

      {changes.length === 0 ? (
        <p className="rounded-2xl border border-dashed border-line bg-paper p-16 text-center text-mute">
          {watch
            ? "No changes for watchlisted properties yet — logging started now, so this fills in from the next sync."
            : "Nothing recorded yet — the log starts now and isn't backfilled, so this fills in from the next sync."}
        </p>
      ) : (
        <div className="flex flex-col gap-3">
          {changes.map((c) => (
            <Link
              key={c.id}
              href={`/property/${c.propertyId}`}
              className="flex items-center gap-4 rounded-2xl border border-line bg-white p-3 hover:border-forest"
            >
              <div className="relative h-[70px] w-24 shrink-0 overflow-hidden rounded-[10px] bg-fill">
                {c.thumbPath && (
                  <Image
                    src={imageUrl({ localPath: c.thumbPath })}
                    alt={c.address ?? "property"}
                    fill
                    sizes="96px"
                    className="object-cover"
                  />
                )}
              </div>
              <div className="min-w-0 flex-[1.2]">
                <div className="truncate font-serif text-lg leading-tight">
                  {c.address ?? "Unknown address"}
                </div>
                <div className="text-xs text-mute">
                  {c.priceDisplay ?? "—"} · {fmtRelative(c.createdAt)}
                </div>
              </div>
              <div className="flex-1 text-sm">
                <span className="font-semibold text-body">{labelFor(c.field)}</span>{" "}
                <span className="text-mute">
                  {fmt(c.before)} → {fmt(c.after)}
                </span>
              </div>
            </Link>
          ))}
        </div>
      )}

      {(offset > 0 || hasMore) && (
        <div className="mt-6 flex justify-center gap-3">
          {offset > 0 && (
            <Link
              href={pageHref(Math.max(offset - limit, 0))}
              className="rounded-full border border-line px-4 py-2 text-sm font-semibold text-body hover:border-forest"
            >
              Newer
            </Link>
          )}
          {hasMore && (
            <Link
              href={pageHref(offset + limit)}
              className="rounded-full border border-line px-4 py-2 text-sm font-semibold text-body hover:border-forest"
            >
              Older
            </Link>
          )}
        </div>
      )}
    </section>
  );
}
