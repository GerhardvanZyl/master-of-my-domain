"use client";

import { useEffect, useState } from "react";
import { createPortal } from "react-dom";
import Image from "next/image";
import { imageUrl } from "@/lib/images";
import { ROOM_ROW_ORDER, type PhotoLite } from "@/lib/photo";
import Lightbox from "./Lightbox";

export interface CompareCol {
  propertyId: string;
  address: string | null;
  // room key ("kitchen", "master", …) -> that property's photos of that room
  rooms: Record<string, PhotoLite[]>;
}

export default function CompareRooms({ columns }: { columns: CompareCol[] }) {
  // Which room's side-by-side carousel modal is open (by row key), and the
  // per-column carousel positions inside it.
  const [carousel, setCarousel] = useState<string | null>(null);
  const [pos, setPos] = useState<number[]>([]);
  // Single-photo lightbox: the set it belongs to + index within it.
  const [lb, setLb] = useState<{ images: PhotoLite[]; index: number } | null>(
    null,
  );

  const rows = ROOM_ROW_ORDER.filter((r) =>
    columns.some((c) => (c.rooms[r.key]?.length ?? 0) > 0),
  );

  function openCarousel(key: string) {
    setCarousel(key);
    setPos(columns.map(() => 0));
  }
  function bump(colIdx: number, d: number, len: number) {
    setPos((prev) => {
      const next = [...prev];
      next[colIdx] = (((next[colIdx] ?? 0) + d) % len + len) % len;
      return next;
    });
  }
  function jump(colIdx: number, to: number) {
    setPos((prev) => {
      const next = [...prev];
      next[colIdx] = to;
      return next;
    });
  }

  // ← / → drive every column at once; Esc closes. The modal's own buttons still
  // move one column independently.
  useEffect(() => {
    if (!carousel) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") return setCarousel(null);
      const d = e.key === "ArrowRight" ? 1 : e.key === "ArrowLeft" ? -1 : 0;
      if (!d) return;
      setPos((prev) =>
        columns.map((c, i) => {
          const len = c.rooms[carousel]?.length ?? 0;
          return len ? (((prev[i] ?? 0) + d) % len + len) % len : 0;
        }),
      );
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [carousel, columns]);

  if (rows.length === 0) {
    return (
      <p className="text-sm text-mute">
        No tagged room photos for these properties yet.
      </p>
    );
  }

  return (
    <>
      <div className="overflow-x-auto">
        <table className="w-full min-w-[640px] border-collapse text-sm">
          <tbody>
            {rows.map((row) => (
              <tr key={row.key} className="align-top">
                <td className="w-32 border-b border-hairline p-2">
                  <button
                    onClick={() => openCarousel(row.key)}
                    className="flex items-center gap-1 text-left text-[14px] font-semibold text-forest underline decoration-forest/30 underline-offset-2 hover:text-forest-hi hover:decoration-forest"
                    title="Open side-by-side carousels"
                  >
                    {row.label} <span className="text-[11px]">⤢</span>
                  </button>
                </td>
                {columns.map((col) => {
                  const imgs = col.rooms[row.key] ?? [];
                  return (
                    <td
                      key={col.propertyId}
                      className="border-b border-hairline p-2"
                    >
                      <div className="grid grid-cols-2 gap-1">
                        {imgs.map((img, i) => (
                          <button
                            key={img.id}
                            onClick={() => setLb({ images: imgs, index: i })}
                            className="relative aspect-[4/3] overflow-hidden rounded-xl border border-line bg-fill"
                          >
                            <Image
                              src={imageUrl(img)}
                              alt={img.roomType ?? "photo"}
                              fill
                              sizes="200px"
                              loading="lazy"
                              className="object-cover"
                            />
                          </button>
                        ))}
                        {imgs.length === 0 && (
                          <span className="text-soft">
                            —
                          </span>
                        )}
                      </div>
                    </td>
                  );
                })}
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {/* Task 3: full-browser modal, one independent carousel per property.
          Portaled to <body> for the same reason as Lightbox: `.rise` animates a
          transform, so it becomes the containing block for `position: fixed`
          and the overlay would size itself to the tall section, not the window. */}
      {carousel && typeof document !== "undefined" && createPortal(
        <div
          className="fixed inset-0 z-50 flex flex-col bg-black/90 p-4"
          onClick={() => setCarousel(null)}
        >
          <div className="flex items-center justify-between text-white">
            <span className="text-sm font-medium">
              {ROOM_ROW_ORDER.find((r) => r.key === carousel)?.label}
              <span className="ml-2 text-xs font-normal text-neutral-400">
                ← → all columns · Esc to close
              </span>
            </span>
            <button
              onClick={() => setCarousel(null)}
              className="rounded px-3 py-1 text-2xl leading-none hover:bg-white/10"
              aria-label="Close"
            >
              ✕
            </button>
          </div>
          <div
            className="flex min-h-0 flex-1 gap-4 overflow-x-auto pt-3"
            onClick={(e) => e.stopPropagation()}
          >
            {columns.map((col, ci) => {
              const imgs = col.rooms[carousel] ?? [];
              const at = pos[ci] ?? 0;
              const img = imgs[at];
              return (
                <div
                  key={col.propertyId}
                  className="flex min-w-[280px] flex-1 flex-col text-white"
                >
                  <div className="mb-2 truncate text-xs text-neutral-300" title={col.address ?? ""}>
                    {col.address ?? col.propertyId}
                  </div>
                  <div className="relative flex min-h-0 flex-1 items-center justify-center rounded bg-black/40">
                    {img ? (
                      <>
                        {imgs.length > 1 && (
                          <button
                            onClick={() => bump(ci, -1, imgs.length)}
                            className="nav-btn absolute left-1 z-10"
                            aria-label="Previous photo"
                            title="Previous (← moves all columns)"
                          >
                            ‹
                          </button>
                        )}
                        <Image
                          src={imageUrl(img)}
                          alt={img.roomType ?? "photo"}
                          fill
                          sizes="(max-width: 640px) 100vw, 45vw"
                          className="object-contain"
                        />
                        {imgs.length > 1 && (
                          <button
                            onClick={() => bump(ci, 1, imgs.length)}
                            className="nav-btn absolute right-1 z-10"
                            aria-label="Next photo"
                            title="Next (→ moves all columns)"
                          >
                            ›
                          </button>
                        )}
                      </>
                    ) : (
                      <span className="text-neutral-500">no photo</span>
                    )}
                  </div>
                  {/* Task 12: filmstrip of every photo of this room type —
                      click to jump straight to one instead of cycling. */}
                  {imgs.length > 1 && (
                    <div className="flex gap-1 overflow-x-auto pt-2">
                      {imgs.map((thumb, i) => (
                        <button
                          key={thumb.id}
                          onClick={() => jump(ci, i)}
                          className={`shrink-0 overflow-hidden rounded border-2 ${
                            i === at
                              ? "border-[#5FBF92] shadow-[0_0_10px_2px_rgba(95,191,146,.5)]"
                              : "border-transparent opacity-60 hover:opacity-100"
                          }`}
                          aria-label={`Photo ${i + 1}`}
                        >
                          <Image
                            src={imageUrl(thumb)}
                            alt=""
                            width={160}
                            height={112}
                            loading="lazy"
                            className="h-14 w-20 object-cover"
                          />
                        </button>
                      ))}
                    </div>
                  )}
                  <div className="pt-1 text-center text-xs text-neutral-400">
                    {imgs.length ? `${at + 1} / ${imgs.length}` : "—"}
                  </div>
                </div>
              );
            })}
          </div>
        </div>,
        document.body,
      )}

      {/* Task 4: single photo in a lightbox (with tag correction) */}
      <Lightbox
        images={lb?.images ?? []}
        index={lb ? lb.index : null}
        onIndexChange={(i) => setLb((s) => (s ? { ...s, index: i } : s))}
        onClose={() => setLb(null)}
      />
    </>
  );
}
