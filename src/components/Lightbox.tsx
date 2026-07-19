"use client";

import { useCallback, useEffect } from "react";
import { imageUrl } from "@/lib/images";
import type { PhotoLite } from "@/lib/photo";
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

  return (
    <div
      className="fixed inset-0 z-50 flex flex-col bg-black/90 p-4"
      onClick={onClose}
    >
      <div className="flex items-center justify-between text-white">
        <span className="text-sm text-neutral-300">
          {index + 1} / {images.length}
          {img.roomType ? ` · ${img.roomType}` : ""}
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
      >
        {images.length > 1 && (
          <button
            onClick={() => step(-1)}
            className="absolute left-0 rounded-full bg-white/10 px-4 py-3 text-2xl text-white hover:bg-white/20"
            aria-label="Previous"
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
            className="absolute right-0 rounded-full bg-white/10 px-4 py-3 text-2xl text-white hover:bg-white/20"
            aria-label="Next"
          >
            ›
          </button>
        )}
      </div>

      {editable && (
        <div
          className="flex justify-center pt-3 text-white"
          onClick={(e) => e.stopPropagation()}
        >
          <TagSelect imageId={img.id} roomType={img.roomType} />
        </div>
      )}
    </div>
  );
}
