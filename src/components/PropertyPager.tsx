"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";

const NAV_ORDER_KEY = "nav:order";

/**
 * Prev/Next stepper between properties, driven by `localStorage["nav:order"]`
 * — a JSON array of property ids in the order the grid last displayed them.
 * The grid is responsible for WRITING that key; until it does, this key is
 * absent and the pager renders nothing (no error, no placeholder).
 */
export default function PropertyPager({ currentId }: { currentId: string }) {
  const router = useRouter();
  const [order, setOrder] = useState<string[] | null>(null);

  // ponytail: read localStorage only in an effect — never during render, to
  // keep server/client markup identical on first paint (hydration safety).
  useEffect(() => {
    try {
      const raw = localStorage.getItem(NAV_ORDER_KEY);
      if (!raw) return;
      const parsed = JSON.parse(raw);
      if (!Array.isArray(parsed) || !parsed.every((x) => typeof x === "string")) return;
      if (!parsed.includes(currentId)) return;
      setOrder(parsed);
    } catch {
      // malformed JSON — render nothing
    }
  }, [currentId]);

  const idx = order ? order.indexOf(currentId) : -1;
  const prevId = order && idx > 0 ? order[idx - 1] : null;
  const nextId = order && idx >= 0 && idx < order.length - 1 ? order[idx + 1] : null;

  useEffect(() => {
    if (idx < 0) return;
    function onKey(e: KeyboardEvent) {
      if (e.altKey || e.ctrlKey || e.metaKey || e.shiftKey) return;
      const t = e.target as HTMLElement | null;
      const tag = t?.tagName;
      if (tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT" || t?.isContentEditable) return;
      // The lightbox owns the arrows while it's open — it listens on window too,
      // so without this both fire and you page properties instead of photos.
      if (document.querySelector('[role="dialog"]')) return;
      if (e.key === "ArrowLeft" && prevId) router.push(`/property/${prevId}`);
      else if (e.key === "ArrowRight" && nextId) router.push(`/property/${nextId}`);
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [idx, prevId, nextId, router]);

  if (!order || idx < 0) return null;

  return (
    <div className="flex items-center gap-3 text-[13px] font-medium text-[#5B5A52]">
      {prevId ? (
        <Link href={`/property/${prevId}`} className="hover:text-forest">
          ← Prev
        </Link>
      ) : (
        <span className="opacity-40">← Prev</span>
      )}
      <span className="text-mute">
        {idx + 1} of {order.length}
      </span>
      {nextId ? (
        <Link href={`/property/${nextId}`} className="hover:text-forest">
          Next →
        </Link>
      ) : (
        <span className="opacity-40">Next →</span>
      )}
    </div>
  );
}
