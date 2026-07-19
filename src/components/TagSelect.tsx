"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { ROOM_TYPES } from "@/lib/photo";

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
      <span className="text-neutral-400">Room</span>
      <select
        value={value}
        onChange={(e) => save(e.target.value)}
        className="rounded border border-neutral-400 bg-white px-2 py-1 text-black"
      >
        <option value="">— untagged —</option>
        {ROOM_TYPES.map((r) => (
          <option key={r} value={r}>
            {r}
          </option>
        ))}
      </select>
      {state === "saving" && <span className="text-neutral-400">saving…</span>}
      {state === "saved" && <span className="text-green-500">saved ✓</span>}
      {state === "error" && <span className="text-red-500">failed</span>}
    </span>
  );
}
