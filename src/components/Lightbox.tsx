"use client";

import { useCallback, useEffect, useRef } from "react";
import { createPortal } from "react-dom";
import Image from "next/image";
import { imageUrl } from "@/lib/images";
import { formatTaggedBy, type PhotoLite } from "@/lib/photo";
import TagSelect from "./TagSelect";

/**
 * Full-screen single-photo modal with prev/next within a set and inline tag
 * correction. Open when `index` is a number; closed when null.
 */
export default function Lightbox({
  images,
  index,
  onIndexChange,
  onClose,
  editable = true,
}: {
  images: PhotoLite[];
  index: number | null;
  onIndexChange: (i: number) => void;
  onClose: () => void;
  editable?: boolean;
}) {
  const open = index != null;
  const step = useCallback(
    (d: number) => {
      if (index == null || images.length === 0) return;
      onIndexChange((index + d + images.length) % images.length);
    },
    [index, images.length, onIndexChange],
  );

  // Horizontal swipe → prev/next on touch devices.
  const touchX = useRef<number | null>(null);
  const onTouchStart = (e: React.TouchEvent) => {
    touchX.current = e.touches[0]?.clientX ?? null;
  };
  const onTouchEnd = (e: React.TouchEvent) => {
    if (touchX.current == null) return;
    const dx = (e.changedTouches[0]?.clientX ?? touchX.current) - touchX.current;
    touchX.current = null;
    if (Math.abs(dx) > 40) step(dx < 0 ? 1 : -1);
  };

  // Fetch AND decode the neighbours while you're looking at the current photo,
  // so prev/next paints on the same frame as the click instead of waiting on a
  // ~300KB fetch + a 1620px decode. decode() is the part that matters — a warm
  // HTTP cache alone still leaves a visible hitch on the swipe.
  useEffect(() => {
    if (index == null || images.length < 2) return;
    for (const d of [1, -1]) {
      const n = images[(index + d + images.length) % images.length];
      if (!n) continue;
      const im = new window.Image();
      im.src = imageUrl(n);
      im.decode?.().catch(() => {});
    }
  }, [index, images]);

  useEffect(() => {
    if (!open) return;
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") onClose();
      else if (e.key === "ArrowRight") step(1);
      else if (e.key === "ArrowLeft") step(-1);
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, step, onClose]);

  if (index == null) return null;
  const img = images[index];
  if (!img) return null;
  if (typeof document === "undefined") return null;

  // Portal to <body>: the detail page's `.rise` (and other) ancestors animate a
  // transform, which turns them into the containing block for `position: fixed`
  // — trapping the overlay inside a tall section so it fell off the viewport.
  return createPortal(
    <div
      role="dialog"
      aria-modal="true"
      className="fixed inset-0 z-[90] flex flex-col bg-black/90 p-4"
      onClick={onClose}
    >
      <div className="flex items-center justify-between text-white">
        <span className="text-sm text-neutral-300">
          {index + 1} / {images.length}
          {img.roomType ? ` · ${img.roomType}` : ""}
          {formatTaggedBy(img.taggedBy) ? ` · tagged by ${formatTaggedBy(img.taggedBy)}` : ""}
          {img.confidence != null ? ` (${Math.round(img.confidence * 100)}% confidence)` : ""}
        </span>
        <button
          onClick={onClose}
          className="rounded px-3 py-1 text-2xl leading-none hover:bg-white/10"
          aria-label="Close"
        >
          ✕
        </button>
      </div>

      <div
        className="relative flex min-h-0 flex-1 items-center justify-center"
        onClick={(e) => e.stopPropagation()}
        onTouchStart={onTouchStart}
        onTouchEnd={onTouchEnd}
      >
        {images.length > 1 && (
          <button
            onClick={() => step(-1)}
            className="nav-btn absolute left-1 z-10 sm:left-3"
            aria-label="Previous photo"
            title="Previous (←)"
          >
            ‹
          </button>
        )}
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img
          src={imageUrl(img)}
          alt={img.roomType ?? "photo"}
          className="max-h-full max-w-full object-contain"
        />
        {images.length > 1 && (
          <button
            onClick={() => step(1)}
            className="nav-btn absolute right-1 z-10 sm:right-3"
            aria-label="Next photo"
            title="Next (→)"
          >
            ›
          </button>
        )}
      </div>

      {/* Filmstrip of every photo — click to jump. */}
      {images.length > 1 && (
        <div
          className="mt-3 flex shrink-0 gap-2 overflow-x-auto pb-1"
          onClick={(e) => e.stopPropagation()}
        >
          {images.map((im, i) => (
            <button
              key={im.id}
              onClick={() => onIndexChange(i)}
              aria-label={`Photo ${i + 1}`}
              className={`h-14 w-20 shrink-0 overflow-hidden rounded border-2 transition ${
                i === index
                  ? "border-[#5FBF92] shadow-[0_0_10px_2px_rgba(95,191,146,.5)]"
                  : "border-transparent opacity-55 hover:opacity-100"
              }`}
            >
              {/* Optimised: a 40-photo listing was pulling 40 × ~300KB full-size
                  originals just to fill 80×56 boxes. */}
              <Image
                src={imageUrl(im)}
                alt=""
                width={160}
                height={112}
                loading="lazy"
                className="h-full w-full object-cover"
              />
            </button>
          ))}
        </div>
      )}

      {editable && (
        <div
          className="flex justify-center pt-3 text-white"
          onClick={(e) => e.stopPropagation()}
        >
          <TagSelect key={img.id} imageId={img.id} roomType={img.roomType} />
        </div>
      )}
    </div>,
    document.body,
  );
}
