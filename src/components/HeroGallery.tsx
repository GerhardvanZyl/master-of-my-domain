"use client";

import { useState } from "react";
import { imageUrl } from "@/lib/images";
import type { PhotoLite } from "@/lib/photo";
import Lightbox from "./Lightbox";

/**
 * Detail-page hero (Domain's cover) plus a strip of showcase thumbnails.
 * Clicking the hero OR any thumbnail opens the full-set lightbox (carousel +
 * filmstrip + swipe) at that photo.
 */
export default function HeroGallery({
  images,
  heroIndex,
  showcaseIndices,
  alt,
}: {
  images: PhotoLite[];
  heroIndex: number;
  showcaseIndices: number[];
  alt: string;
}) {
  const [open, setOpen] = useState<number | null>(null);
  const hero = images[heroIndex];

  return (
    <div className="space-y-2">
      <button
        type="button"
        onClick={() => hero && setOpen(heroIndex)}
        aria-label="Open photo gallery"
        className="group relative block h-[400px] w-full overflow-hidden rounded-[18px] bg-fill"
      >
        {hero ? (
          <>
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img
              src={imageUrl(hero)}
              alt={alt}
              className="h-full w-full object-cover"
            />
            {images.length > 1 && (
              <span className="absolute bottom-3 right-3 rounded-full bg-black/60 px-3 py-1 text-xs font-medium text-white transition group-hover:bg-black/80">
                ⤢ {images.length} photos
              </span>
            )}
          </>
        ) : (
          <div className="flex h-full items-center justify-center text-mute">
            no image
          </div>
        )}
      </button>

      {showcaseIndices.length > 0 && (
        <div className="grid grid-cols-3 gap-2">
          {showcaseIndices.map((idx) => (
            <button
              key={images[idx].id}
              type="button"
              onClick={() => setOpen(idx)}
              aria-label="Open photo"
              className="relative block h-24 overflow-hidden rounded-[12px] bg-fill transition hover:opacity-90 sm:h-28"
            >
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img
                src={imageUrl(images[idx])}
                alt=""
                loading="lazy"
                className="h-full w-full object-cover"
              />
            </button>
          ))}
        </div>
      )}

      <Lightbox
        images={images}
        index={open}
        onIndexChange={setOpen}
        onClose={() => setOpen(null)}
        editable={false}
      />
    </div>
  );
}
