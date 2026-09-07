"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";

/**
 * Star toggle for the property detail page's watchlist flag — PATCHes the
 * same `{ watchlisted }` field the grid's tile toggle does. Refreshes via
 * router.refresh() like this page's other mutations (NotesEditor,
 * MetadataEditor) rather than PropertyGrid's optimistic-edit-map pattern:
 * there's one of these per page, not ~290, so the refresh cost doesn't apply.
 */
export default function WatchToggle({
  propertyId,
  initial,
}: {
  propertyId: string;
  initial: boolean;
}) {
  const router = useRouter();
  const [watched, setWatched] = useState(initial);
  const [saving, setSaving] = useState(false);

  async function toggle() {
    const next = !watched;
    setSaving(true);
    setWatched(next);
    try {
      await fetch(`/api/properties/${propertyId}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ watchlisted: next ? 1 : 0 }),
      });
      router.refresh();
    } catch (e) {
      setWatched(!next); // roll back the optimistic flip -- the write never landed
      console.warn("watch toggle failed", e);
    } finally {
      setSaving(false);
    }
  }

  const onCls = "border-amber bg-amber/10 text-amber";
  const offCls = "border-line bg-white text-mute hover:border-amber hover:text-amber";

  return (
    <button
      type="button"
      onClick={toggle}
      disabled={saving}
      aria-pressed={watched}
      title={watched ? "Remove from watchlist" : "Add to watchlist"}
      className={`flex h-9 w-9 items-center justify-center rounded-full border text-lg
        leading-none transition disabled:opacity-60 ${watched ? onCls : offCls}`}
    >
      {watched ? "★" : "☆"}
    </button>
  );
}
