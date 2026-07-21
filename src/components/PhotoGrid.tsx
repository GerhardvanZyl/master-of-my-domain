"use client";

import { useState } from "react";
import { imageUrl } from "@/lib/images";
import type { PhotoLite } from "@/lib/photo";
import Lightbox from "./Lightbox";

/** Thumbnail grid where each photo opens in a full-screen editable lightbox. */
export default function PhotoGrid({ images }: { images: PhotoLite[] }) {
  const [open, setOpen] = useState<number | null>(null);
  return (
    <>
      <div className="grid grid-cols-2 gap-2 sm:grid-cols-3 md:grid-cols-4">
        {images.map((img, i) => (
          <button
            key={img.id}
            onClick={() => setOpen(i)}
            title="Open"
            className="relative block overflow-hidden rounded-[9px] border border-hairline bg-fill"
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
          </button>
        ))}
      </div>
      <Lightbox
        images={images}
        index={open}
        onIndexChange={setOpen}
        onClose={() => setOpen(null)}
      />
    </>
  );
}
