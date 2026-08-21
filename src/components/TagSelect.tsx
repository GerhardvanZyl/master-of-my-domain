"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { ROOM_TYPES } from "@/lib/photo";

/**
 * A *closed* native <select> steps and commits its own value on arrow keys,
 * End/Home and Page Up/Down — browser default behaviour, nothing to do with
 * onChange. This lives here (used e.g. inside Lightbox, whose own
 * ArrowLeft/ArrowRight browse photos on `window`) so a stray key press while
 * focus sits in this dropdown can't silently retag the photo underneath the
 * user. preventDefault only stops the closed-select stepping; once opened
 * (click, or Enter/Space/F4) the native popup owns these keys itself, so
 * choosing an option is unaffected. Alt+ArrowDown is excluded on purpose —
 * it's the standard gesture to OPEN the popup rather than step the closed
 * value, so it's left alone to keep the control keyboard-operable. Type-ahead
 * (a letter jumping to a matching option, e.g. "k" -> kitchen) is also left
 * alone: that's the intended way to pick an option by keyboard, not a
 * navigation gesture.
 */
function blockClosedSelectArrowKeys(e: React.KeyboardEvent<HTMLSelectElement>) {
  if (e.altKey) return;
  if (
    e.key === "ArrowUp" ||
    e.key === "ArrowDown" ||
    e.key === "ArrowLeft" ||
    e.key === "ArrowRight" ||
    e.key === "Home" ||
    e.key === "End" ||
    e.key === "PageUp" ||
    e.key === "PageDown"
  ) {
    e.preventDefault();
  }
}

/** Inline room-tag corrector. PATCHes /api/images/<id>/tag then refreshes. */
export default function TagSelect({
  imageId,
  roomType,
}: {
  imageId: string;
  roomType: string | null;
}) {
  const router = useRouter();
  const [value, setValue] = useState(roomType ?? "");
  const [state, setState] = useState<"idle" | "saving" | "saved" | "error">(
    "idle",
  );

  async function save(next: string) {
    setValue(next);
    if (!next) return;
    setState("saving");
    try {
      const res = await fetch(`/api/images/${encodeURIComponent(imageId)}/tag`, {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ roomType: next }),
      });
      if (!res.ok) throw new Error(String(res.status));
      setState("saved");
      router.refresh();
    } catch {
      setState("error");
    }
  }

  return (
    <span className="inline-flex items-center gap-2 text-sm">
      <span className="text-white/60">Room</span>
      <select
        value={value}
        onChange={(e) => save(e.target.value)}
        onKeyDown={blockClosedSelectArrowKeys}
        className="rounded-lg border border-line bg-white px-2.5 py-1.5 font-medium text-ink"
      >
        <option value="">— untagged —</option>
        {ROOM_TYPES.map((r) => (
          <option key={r} value={r}>
            {r}
          </option>
        ))}
      </select>
      {state === "saving" && <span className="text-white/60">saving…</span>}
      {state === "saved" && <span className="text-green-500">saved ✓</span>}
      {state === "error" && <span className="text-red-500">failed</span>}
    </span>
  );
}
