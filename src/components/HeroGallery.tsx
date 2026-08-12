"use client";

import { useState } from "react";
import Image from "next/image";
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

  // Size the box to the photo rather than the photo to the box. It used to be a
  // flat h-[400px] with object-cover, which cropped the top and bottom off every
  // 3:2 listing shot — the sky and the front garden, usually. Domain's are 3:2,
  // so that's the fallback when a row has no stored dimensions; a 16:9 aerial or
  // a portrait shot gets its own ratio and stays whole either way.
  const ratio = hero?.width && hero?.height ? hero.width / hero.height : 3 / 2;
  // Cap the HEIGHT by capping the width the ratio is applied to, not with a
  // max-height. A max-height overrides the aspect-ratio, so the box goes wider
  // than the photo and object-contain mattes it with grey down both sides —
  // measured at 1440px: a 1376×648 box painting a 972×648 photo. Deriving the
  // width means the box always IS the photo's shape: no crop, no matting, and
  // on a phone it just fills the column.
  const MAX_HEIGHT = 620;

  return (
    // The cap lives on the whole block so the showcase strip stays exactly as
    // wide as the hero above it — on a wide screen the hero is narrower than the
    // column, and a full-width strip under a centred hero reads as misaligned.
    <div className="mx-auto space-y-2" style={{ maxWidth: `${Math.round(MAX_HEIGHT * ratio)}px` }}>
      <button
        type="button"
        onClick={() => hero && setOpen(heroIndex)}
        aria-label="Open photo gallery"
        style={{ aspectRatio: ratio }}
        className="group relative block w-full overflow-hidden rounded-[18px] bg-fill"
      >
        {hero ? (
          <>
            {/* priority: this is the detail page's largest contentful paint. */}
            <Image
              src={imageUrl(hero)}
              alt={alt}
              fill
              priority
              sizes="(max-width: 1024px) 100vw, 60vw"
              className="object-contain"
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
              <Image
                src={imageUrl(images[idx])}
                alt=""
                fill
                sizes="(max-width: 1024px) 33vw, 220px"
                className="object-cover"
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
      />
    </div>
  );
}
