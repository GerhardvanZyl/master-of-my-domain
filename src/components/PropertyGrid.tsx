"use client";

import { useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import type { PropertyListItem } from "@/db/queries/properties";
import { imageUrl } from "@/lib/images";
import { formatPrice, bedBathCar } from "@/lib/format";

export default function PropertyGrid({
  properties,
}: {
  properties: PropertyListItem[];
}) {
  const router = useRouter();
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [busy, setBusy] = useState<string | null>(null);

  function toggle(id: string) {
    setSelected((prev) => {
      const next = new Set(prev);
      next.has(id) ? next.delete(id) : next.add(id);
      return next;
    });
  }

  async function remove(id: string) {
    if (!confirm("Remove this property and its images?")) return;
    setBusy(id);
    await fetch(`/api/properties?id=${id}`, { method: "DELETE" });
    setSelected((prev) => {
      const next = new Set(prev);
      next.delete(id);
      return next;
    });
    setBusy(null);
    router.refresh();
  }

  if (properties.length === 0) {
    return (
      <p className="rounded-lg border border-dashed border-neutral-300 p-8 text-center text-neutral-500 dark:border-neutral-700">
        No properties yet. Browse a Domain or realestate.com.au listing with the capture extension installed to add one.
      </p>
    );
  }

  const compareIds = [...selected].slice(0, 4);

  return (
    <>
      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3">
        {properties.map((p) => (
          <div
            key={p.id}
            className={`overflow-hidden rounded-lg border bg-white dark:bg-neutral-900 ${
              selected.has(p.id)
                ? "border-blue-500 ring-2 ring-blue-500/40"
                : "border-neutral-200 dark:border-neutral-800"
            }`}
          >
            <Link href={`/property/${p.id}`} className="block">
              <div className="aspect-[4/3] bg-neutral-100 dark:bg-neutral-800">
                {p.thumbPath ? (
                  // eslint-disable-next-line @next/next/no-img-element
                  <img
                    src={imageUrl({ localPath: p.thumbPath })}
                    alt={p.address ?? "property"}
                    loading="lazy"
                    className="h-full w-full object-cover"
                  />
                ) : (
                  <div className="flex h-full items-center justify-center text-sm text-neutral-400">
                    {p.scrapeStatus === "error" ? "scrape error" : "no image"}
                  </div>
                )}
              </div>
            </Link>
            <div className="space-y-1 p-3">
              <div className="flex items-start justify-between gap-2">
                <span className="text-xs uppercase tracking-wide text-neutral-400">
                  {p.sourceSite}
                </span>
                <label className="flex items-center gap-1 text-xs">
                  <input
                    type="checkbox"
                    checked={selected.has(p.id)}
                    onChange={() => toggle(p.id)}
                  />
                  compare
                </label>
              </div>
              <Link href={`/property/${p.id}`} className="block font-medium hover:underline">
                {p.address ?? p.listingUrl}
              </Link>
              <div className="font-semibold">
                {formatPrice(p.priceDisplay, p.priceNumeric)}
              </div>
              <div className="text-sm text-neutral-500">
                {bedBathCar(p.beds, p.baths, p.parking)} · {p.imageCount} photos
              </div>
              <div className="flex gap-3 pt-1 text-xs text-neutral-500">
                <button
                  onClick={() => remove(p.id)}
                  disabled={busy === p.id}
                  className="text-red-600 hover:underline"
                >
                  remove
                </button>
              </div>
            </div>
          </div>
        ))}
      </div>

      {compareIds.length >= 2 && (
        <div className="sticky bottom-4 mt-4 flex justify-center">
          <Link
            href={`/compare?ids=${compareIds.join(",")}`}
            className="rounded-full bg-blue-600 px-6 py-3 text-sm font-medium text-white shadow-lg"
          >
            Compare {compareIds.length} properties →
          </Link>
        </div>
      )}
    </>
  );
}
