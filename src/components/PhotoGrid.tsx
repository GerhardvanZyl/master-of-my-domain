"use client";

import { useState } from "react";
import Image from "next/image";
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
            className="relative block aspect-[4/3] overflow-hidden rounded-[9px] border border-hairline bg-fill"
          >
            <Image
              src={imageUrl(img)}
              alt={img.roomType ?? "photo"}
              fill
              sizes="(max-width: 640px) 50vw, 260px"
              className="object-cover"
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
