"use client";

import { useState } from "react";
import Link from "next/link";
import Image from "next/image";
import type { PropertyColumn } from "@/db/queries/rooms";
import { imageUrl } from "@/lib/images";
import { isMachineTagged, type PhotoLite } from "@/lib/photo";
import Lightbox from "./Lightbox";

export default function RoomColumns({ columns }: { columns: PropertyColumn[] }) {
  // One flat list drives the lightbox; each thumbnail knows its index into it.
  const all: PhotoLite[] = columns.flatMap((c) => c.images);
  const [open, setOpen] = useState<number | null>(null);
  const indexOf = (id: string) => all.findIndex((p) => p.id === id);

  if (columns.length === 0) {
    return (
      <p className="text-sm text-mute">
        No photos here yet. Tag some photos first (see CLAUDE.md / the
        tag-photos skill).
      </p>
    );
  }
  return (
    <>
      <div className="overflow-x-auto">
        <div className="flex gap-4">
          {columns.map((col) => (
            <div key={col.propertyId} className="w-56 shrink-0">
              <Link
                href={`/property/${col.propertyId}`}
                className="mb-2 block truncate font-serif text-base hover:text-forest"
                title={col.address ?? col.propertyId}
              >
                {col.address ?? col.propertyId}
              </Link>
              <div className="space-y-2">
                {col.images.map((img) => (
                  <button
                    key={img.id}
                    onClick={() => setOpen(indexOf(img.id))}
                    title="Open"
                    className="relative block aspect-[4/3] w-full overflow-hidden rounded-xl border border-line bg-fill"
                  >
                    <Image
                      src={imageUrl(img)}
                      alt={img.roomType ?? "photo"}
                      fill
                      sizes="224px"
                      className="object-cover"
                    />
                    {img.roomType && (
                      <span className="absolute left-1 top-1 flex items-center gap-1 rounded bg-black/70 px-1.5 py-0.5 text-[10px] font-medium uppercase text-white">
                        {img.roomType}
                        {isMachineTagged(img.taggedBy) && (
                          <span
                            className="h-1.5 w-1.5 rounded-full bg-white/50"
                            title="Machine-tagged — not yet reviewed"
                          />
                        )}
                      </span>
                    )}
                  </button>
                ))}
              </div>
            </div>
          ))}
        </div>
      </div>
      <Lightbox
        images={all}
        index={open}
        onIndexChange={setOpen}
        onClose={() => setOpen(null)}
      />
    </>
  );
}
