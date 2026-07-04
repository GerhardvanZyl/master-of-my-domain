import Link from "next/link";
import type { PropertyColumn } from "@/db/queries/rooms";
import { imageUrl } from "@/lib/images";

export default function RoomColumns({ columns }: { columns: PropertyColumn[] }) {
  if (columns.length === 0) {
    return (
      <p className="text-sm text-neutral-500">
        No photos here yet. Tag some photos first (see CLAUDE.md / the
        tag-photos skill).
      </p>
    );
  }
  return (
    <div className="overflow-x-auto">
      <div className="flex gap-4">
        {columns.map((col) => (
          <div key={col.propertyId} className="w-56 shrink-0">
            <Link
              href={`/property/${col.propertyId}`}
              className="mb-2 block truncate text-sm font-medium hover:underline"
              title={col.address ?? col.propertyId}
            >
              {col.address ?? col.propertyId}
            </Link>
            <div className="space-y-2">
              {col.images.map((img) => (
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
                    <span className="absolute left-1 top-1 rounded bg-black/70 px-1.5 py-0.5 text-[10px] font-medium uppercase text-white">
                      {img.roomType}
                    </span>
                  )}
                </div>
              ))}
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}
