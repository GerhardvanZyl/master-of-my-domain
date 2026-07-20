"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";

/** Editable "My notes" box for a property. Persists to /api/properties/<id>/notes. */
export default function NotesEditor({
  propertyId,
  initial,
}: {
  propertyId: string;
  initial: string | null;
}) {
  const router = useRouter();
  const [value, setValue] = useState(initial ?? "");
  const [state, setState] = useState<"idle" | "saving" | "saved" | "error">("idle");
  const dirty = value !== (initial ?? "");

  async function save() {
    setState("saving");
    try {
      const res = await fetch(`/api/properties/${encodeURIComponent(propertyId)}/notes`, {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ domainNotes: value }),
      });
      if (!res.ok) throw new Error(String(res.status));
      setState("saved");
      router.refresh();
    } catch {
      setState("error");
    }
  }

  return (
    <div className="space-y-1">
      <textarea
        value={value}
        onChange={(e) => {
          setValue(e.target.value);
          setState("idle");
        }}
        rows={4}
        placeholder="Add your notes about this property…"
        className="w-full resize-y rounded-xl border border-line bg-paper px-3 py-2.5 text-[13px] leading-relaxed outline-none focus:border-forest focus:bg-white"
      />
      <div className="flex items-center gap-3 text-xs">
        <button
          onClick={save}
          disabled={!dirty || state === "saving"}
          className="rounded-lg bg-forest px-3.5 py-1.5 font-semibold text-linen disabled:opacity-40"
        >
          Save
        </button>
        {state === "saving" && <span className="text-mute">saving…</span>}
        {state === "saved" && !dirty && <span className="text-forest">saved ✓</span>}
        {state === "error" && <span className="text-[#B84A3A]">save failed</span>}
      </div>
    </div>
  );
}
