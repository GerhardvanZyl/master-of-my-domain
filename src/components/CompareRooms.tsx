"use client";

import { useState } from "react";
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

  if (rows.length === 0) {
    return (
      <p className="text-sm text-neutral-500">
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
                <td className="w-32 border-b border-neutral-100 p-2 dark:border-neutral-800/50">
                  <button
                    onClick={() => openCarousel(row.key)}
                    className="font-medium text-blue-600 hover:underline"
                    title="Open side-by-side carousels"
                  >
                    {row.label}
                  </button>
                </td>
                {columns.map((col) => {
                  const imgs = col.rooms[row.key] ?? [];
                  return (
                    <td
                      key={col.propertyId}
                      className="border-b border-neutral-100 p-2 dark:border-neutral-800/50"
                    >
                      <div className="grid grid-cols-2 gap-1">
                        {imgs.map((img, i) => (
                          <button
                            key={img.id}
                            onClick={() => setLb({ images: imgs, index: i })}
                            className="overflow-hidden rounded bg-neutral-100 dark:bg-neutral-800"
                          >
                            {/* eslint-disable-next-line @next/next/no-img-element */}
                            <img
                              src={imageUrl(img)}
                              alt={img.roomType ?? "photo"}
                              loading="lazy"
                              className="aspect-[4/3] w-full object-cover"
                            />
                          </button>
                        ))}
                        {imgs.length === 0 && (
                          <span className="text-neutral-300 dark:text-neutral-600">
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

      {/* Task 3: full-browser modal, one independent carousel per property */}
      {carousel && (
        <div
          className="fixed inset-0 z-50 flex flex-col bg-black/90 p-4"
          onClick={() => setCarousel(null)}
        >
          <div className="flex items-center justify-between text-white">
            <span className="text-sm font-medium">
              {ROOM_ROW_ORDER.find((r) => r.key === carousel)?.label}
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
                            className="absolute left-1 rounded-full bg-white/10 px-3 py-2 text-xl hover:bg-white/20"
                            aria-label="Previous"
                          >
                            ‹
                          </button>
                        )}
                        {/* eslint-disable-next-line @next/next/no-img-element */}
                        <img
                          src={imageUrl(img)}
                          alt={img.roomType ?? "photo"}
                          className="max-h-[70vh] max-w-full object-contain"
                        />
                        {imgs.length > 1 && (
                          <button
                            onClick={() => bump(ci, 1, imgs.length)}
                            className="absolute right-1 rounded-full bg-white/10 px-3 py-2 text-xl hover:bg-white/20"
                            aria-label="Next"
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
                            i === at ? "border-white" : "border-transparent opacity-60 hover:opacity-100"
                          }`}
                          aria-label={`Photo ${i + 1}`}
                        >
                          {/* eslint-disable-next-line @next/next/no-img-element */}
                          <img
                            src={imageUrl(thumb)}
                            alt=""
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
        </div>
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
