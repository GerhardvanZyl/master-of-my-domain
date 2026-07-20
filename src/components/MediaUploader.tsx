"use client";

import { useState } from "react";
import type { MediaItem } from "@/lib/media";

/** Your own photos & walk-through videos. Files live on disk under
 *  data/media/<propertyId>/ — ponytail: the directory listing IS the index,
 *  no table needed. */
export default function MediaUploader({
  propertyId,
  initial,
}: {
  propertyId: string;
  initial: MediaItem[];
}) {
  const [media, setMedia] = useState(initial);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  async function upload(files: FileList | null) {
    if (!files?.length) return;
    setBusy(true);
    setErr(null);
    try {
      const form = new FormData();
      for (const f of Array.from(files)) form.append("files", f);
      const res = await fetch(`/api/properties/${propertyId}/media`, {
        method: "POST",
        body: form,
      });
      const json = await res.json();
      if (!res.ok) throw new Error(json.error ?? res.status);
      setMedia(json.media);
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }

  async function remove(name: string) {
    const res = await fetch(
      `/api/properties/${propertyId}/media?name=${encodeURIComponent(name)}`,
      { method: "DELETE" },
    );
    if (res.ok) setMedia((await res.json()).media);
  }

  return (
    <div className="card p-[18px]">
      <div className="mb-3.5 flex items-center justify-between gap-4">
        <div>
          <h2 className="font-serif text-[22px]">My media</h2>
          <p className="mt-0.5 text-xs text-mute">
            Your own photos &amp; walk-through videos for this place
          </p>
        </div>
        <label className="btn-primary cursor-pointer">
          {busy ? "Uploading…" : "Upload"}
          <input
            type="file"
            accept="image/*,video/*"
            multiple
            onChange={(e) => upload(e.target.files)}
            className="hidden"
          />
        </label>
      </div>

      {err && <p className="mb-3 text-xs text-[#B84A3A]">{err}</p>}

      {media.length === 0 ? (
        <label
          onDragOver={(e) => e.preventDefault()}
          onDrop={(e) => {
            e.preventDefault();
            upload(e.dataTransfer.files);
          }}
          className="flex cursor-pointer flex-col items-center gap-2 rounded-xl border-2 border-dashed border-[#DDD6C6] p-9 text-center text-[13px] text-mute"
        >
          Drag photos &amp; videos here, or click to upload
          <input
            type="file"
            accept="image/*,video/*"
            multiple
            onChange={(e) => upload(e.target.files)}
            className="hidden"
          />
        </label>
      ) : (
        <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
          {media.map((m) => (
            <div
              key={m.name}
              className="group relative aspect-[4/3] overflow-hidden rounded-[9px] border border-hairline bg-fill"
            >
              {m.video ? (
                <video src={m.url} controls className="h-full w-full object-cover" />
              ) : (
                // eslint-disable-next-line @next/next/no-img-element
                <img src={m.url} alt={m.name} loading="lazy" className="h-full w-full object-cover" />
              )}
              <button
                onClick={() => remove(m.name)}
                className="absolute right-1 top-1 hidden h-6 w-6 rounded-full bg-black/60 text-white group-hover:block"
                aria-label="Delete"
              >
                ×
              </button>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
