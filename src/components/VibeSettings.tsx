"use client";

import { useState } from "react";
import {
  DEFAULT_VIBE_CONFIG,
  loadVibeConfig,
  saveVibeConfig,
  type VibeConfig,
} from "@/lib/vibes";

// Editable fields grouped for the panel. idealPrice is driven by the slider, so
// it's omitted here.
const FIELDS: { key: keyof VibeConfig; label: string; sign: "−" | "+" }[] = [
  { key: "perStation250m", label: "per 250m from station", sign: "−" },
  { key: "perAbove5000", label: "per $5k above ideal", sign: "−" },
  { key: "perBelow10000", label: "per $10k below ideal", sign: "−" },
  { key: "perGreenCrossKm", label: "per 1km from Green Cross", sign: "−" },
  { key: "noPlaygrounds", label: "no playground ≤500m", sign: "−" },
  { key: "perFlinders5min", label: "per 5min to Flinders", sign: "−" },
  { key: "noEaves", label: "no all-around eaves", sign: "−" },
  { key: "noPergola", label: "no covered pergola/deck", sign: "−" },
  { key: "noLawn", label: "no lawn", sign: "−" },
  { key: "like", label: "rating: like", sign: "+" },
  { key: "meh", label: "rating: meh", sign: "−" },
  { key: "dislike", label: "rating: dislike", sign: "−" },
  { key: "hate", label: "rating: hate", sign: "−" },
  { key: "looksGood", label: "looks good", sign: "+" },
  { key: "looksUgly", label: "looks ugly", sign: "−" },
  { key: "smallKitchen", label: "small-ish kitchen", sign: "−" },
  { key: "tinyKitchen", label: "tiny kitchen", sign: "−" },
];

export default function VibeSettings() {
  const [open, setOpen] = useState(false);
  const [cfg, setCfg] = useState<VibeConfig>(DEFAULT_VIBE_CONFIG);

  function openPanel() {
    setCfg(loadVibeConfig());
    setOpen(true);
  }
  function save() {
    saveVibeConfig(cfg);
    // Scores are computed client-side from localStorage; reload to apply them.
    window.location.reload();
  }

  return (
    <>
      <button
        type="button"
        onClick={openPanel}
        title="Vibe scoring weights"
        aria-label="Vibe scoring weights"
        className="rounded px-1.5 py-0.5 text-neutral-400 hover:text-neutral-600"
      >
        ⚙️
      </button>
      {open && (
        <div
          className="fixed inset-0 z-40 flex items-center justify-center bg-black/40 p-4"
          onClick={() => setOpen(false)}
        >
          <div
            className="max-h-[85vh] w-full max-w-md overflow-y-auto rounded-2xl border border-neutral-200 bg-white p-5 shadow-xl dark:border-neutral-800 dark:bg-neutral-900"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="mb-3 flex items-center justify-between">
              <h2 className="text-base font-semibold">✨ Vibe scoring weights</h2>
              <button
                onClick={() => setCfg(DEFAULT_VIBE_CONFIG)}
                className="text-xs text-blue-600 hover:underline"
              >
                Reset to defaults
              </button>
            </div>
            <p className="mb-3 text-xs text-neutral-500">
              Every property starts at 100. Points are then added (+) or removed (−) by
              the amounts below.
            </p>
            <div className="space-y-1.5">
              {FIELDS.map((f) => (
                <label key={f.key} className="flex items-center gap-2 text-sm">
                  <span className="w-6 text-right text-neutral-400">{f.sign}</span>
                  <input
                    type="number"
                    min={0}
                    value={cfg[f.key]}
                    onChange={(e) =>
                      setCfg((c) => ({ ...c, [f.key]: Number(e.target.value) }))
                    }
                    className="w-16 rounded border border-neutral-300 bg-transparent px-2 py-1 dark:border-neutral-700"
                  />
                  <span className="flex-1 text-neutral-600 dark:text-neutral-300">
                    {f.label}
                  </span>
                </label>
              ))}
            </div>
            <div className="mt-4 flex justify-end gap-2">
              <button
                onClick={() => setOpen(false)}
                className="rounded-lg border border-neutral-300 px-3 py-1.5 text-sm hover:bg-neutral-100 dark:border-neutral-700 dark:hover:bg-neutral-800"
              >
                Cancel
              </button>
              <button
                onClick={save}
                className="rounded-lg bg-blue-600 px-3 py-1.5 text-sm font-medium text-white hover:bg-blue-700"
              >
                Save &amp; apply
              </button>
            </div>
          </div>
        </div>
      )}
    </>
  );
}
