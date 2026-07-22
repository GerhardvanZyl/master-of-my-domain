"use client";

import { useEffect, useState } from "react";
import { createPortal } from "react-dom";

/**
 * Button that opens a large street-view + satellite modal (keyless Google Maps
 * embeds). Portaled to <body> so the detail page's `.rise` transform doesn't
 * trap the fixed overlay.
 */
export default function MapModal({
  lat,
  lng,
  address,
}: {
  lat: number | null;
  lng: number | null;
  address?: string | null;
}) {
  const [open, setOpen] = useState(false);
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && setOpen(false);
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open]);

  if (lat == null || lng == null) return null;
  const q = `${lat},${lng}`;

  return (
    <>
      <button
        onClick={() => setOpen(true)}
        className="rounded-[10px] border border-line bg-white px-3 py-2 text-[13px] font-semibold text-forest hover:border-forest"
      >
        🛰 Street &amp; satellite view
      </button>

      {open &&
        typeof document !== "undefined" &&
        createPortal(
          <div
            className="fixed inset-0 z-[90] flex flex-col gap-3 bg-black/90 p-4"
            onClick={() => setOpen(false)}
          >
            <div className="flex items-center justify-between text-white">
              <span className="text-sm text-neutral-300">{address ?? q}</span>
              <button
                onClick={() => setOpen(false)}
                aria-label="Close"
                className="rounded px-3 py-1 text-2xl leading-none hover:bg-white/10"
              >
                ✕
              </button>
            </div>
            <div
              className="grid min-h-0 flex-1 grid-cols-1 gap-3 md:grid-cols-2"
              onClick={(e) => e.stopPropagation()}
            >
              <div className="flex min-h-0 flex-col">
                <div className="label-cap mb-1.5 text-[11px] text-white/70">
                  Satellite
                </div>
                <iframe
                  title={`Satellite view of ${address ?? q}`}
                  src={`https://maps.google.com/maps?q=${q}&t=k&z=18&output=embed`}
                  referrerPolicy="no-referrer-when-downgrade"
                  className="min-h-0 flex-1 rounded-xl border-0 bg-fill"
                />
              </div>
              <div className="flex min-h-0 flex-col">
                <div className="label-cap mb-1.5 text-[11px] text-white/70">
                  Street view
                </div>
                <iframe
                  title={`Street view of ${address ?? q}`}
                  src={`https://maps.google.com/maps?q=&layer=c&cbll=${q}&cbp=11,0,0,0,0&output=svembed`}
                  referrerPolicy="no-referrer-when-downgrade"
                  className="min-h-0 flex-1 rounded-xl border-0 bg-fill"
                />
              </div>
            </div>
          </div>,
          document.body,
        )}
    </>
  );
}
