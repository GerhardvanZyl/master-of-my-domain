"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import type { PropertyListItem } from "@/db/queries/properties";
import {
  DEFAULT_VIBE_CONFIG,
  loadVibeConfig,
  saveVibeConfig,
  vibeScore,
  type VibeConfig,
} from "@/lib/vibes";

type Field = { key: keyof VibeConfig; label: string; hint?: string; step?: number };

const GROUPS: { title: string; fields: Field[] }[] = [
  {
    title: "Price",
    fields: [
      { key: "idealPrice", label: "Ideal price", step: 5000, hint: "The target the score is measured against" },
      { key: "perAbove5000", label: "− per $5k above ideal" },
      { key: "perBelow10000", label: "− per $10k below ideal", hint: "Suspiciously cheap is also a signal" },
    ],
  },
  {
    title: "Commute",
    fields: [
      { key: "perStation250m", label: "− per 250 m from the station" },
      { key: "perFlinders5min", label: "− per 5 min to Flinders St" },
    ],
  },
  {
    title: "Neighbourhood",
    fields: [
      { key: "perGreenCrossKm", label: "− per km from Green Cross vet" },
      { key: "noPlaygrounds", label: "− no playground ≤500 m" },
    ],
  },
  {
    title: "House features",
    fields: [
      { key: "noEaves", label: "− no all-around eaves" },
      { key: "noPergola", label: "− no covered pergola" },
      { key: "noLawn", label: "− no lawn" },
    ],
  },
  {
    title: "Reactions",
    fields: [
      { key: "like", label: "+ like" },
      { key: "meh", label: "− meh" },
      { key: "dislike", label: "− dislike" },
      { key: "hate", label: "− hate" },
    ],
  },
  {
    title: "Looks",
    fields: [
      { key: "looksGood", label: "+ looks good" },
      { key: "looksUgly", label: "− looks ugly" },
    ],
  },
  {
    title: "Kitchen",
    fields: [
      { key: "smallKitchen", label: "− small kitchen" },
      { key: "tinyKitchen", label: "− tiny kitchen" },
    ],
  },
];

export default function VibesConfig({
  properties,
}: {
  properties: PropertyListItem[];
}) {
  // Start from defaults so server and first client render match, then hydrate.
  const [cfg, setCfg] = useState<VibeConfig>(DEFAULT_VIBE_CONFIG);
  useEffect(() => setCfg(loadVibeConfig()), []);

  function set(key: keyof VibeConfig, value: number) {
    const next = { ...cfg, [key]: value };
    setCfg(next);
    saveVibeConfig(next);
  }

  const ranked = [...properties]
    .map((p) => ({ p, score: vibeScore(p, p.ratings, cfg) }))
    .sort((a, b) => b.score - a.score);

  return (
    <section className="rise space-y-6">
      <div>
        <div className="eyebrow mb-1.5">Scoring engine</div>
        <h1 className="font-serif text-[38px] leading-none">
          Configure the ✨ vibes score
        </h1>
        <p className="mt-2 max-w-[680px] text-sm text-mute">
          Every property starts at 100, then gains or loses points from the rules
          below. Values are magnitudes — the sign is shown in the label. Changes
          save to this browser and apply instantly across the grid, compare and
          detail views.
        </p>
      </div>

      <div className="grid items-start gap-6 lg:grid-cols-[1.6fr_1fr]">
        <div className="grid gap-4 sm:grid-cols-2">
          {GROUPS.map((g) => (
            <div key={g.title} className="card p-4">
              <div className="mb-3 text-[12.5px] font-bold text-forest">{g.title}</div>
              <div className="flex flex-col gap-3">
                {g.fields.map((f) => (
                  <div key={f.key}>
                    <div className="flex items-center justify-between gap-2.5">
                      <label className="text-[13px] leading-tight text-body">{f.label}</label>
                      <input
                        type="number"
                        step={f.step ?? 1}
                        value={cfg[f.key]}
                        onChange={(e) => set(f.key, Number(e.target.value))}
                        className="field w-24 shrink-0 bg-paper text-right font-semibold"
                      />
                    </div>
                    {f.hint && <div className="mt-1 text-[11px] text-soft">{f.hint}</div>}
                  </div>
                ))}
              </div>
            </div>
          ))}
          <button
            onClick={() => {
              setCfg(DEFAULT_VIBE_CONFIG);
              saveVibeConfig(DEFAULT_VIBE_CONFIG);
            }}
            className="justify-self-start text-xs text-mute hover:text-forest"
          >
            reset to defaults
          </button>
        </div>

        <div className="rounded-2xl bg-forest p-5 text-linen lg:sticky lg:top-[84px]">
          <div className="text-[12.5px] font-semibold tracking-wide opacity-70">
            LIVE RANKING
          </div>
          <p className="mb-4 mt-1 text-xs opacity-60">
            All {properties.length} properties, re-scored as you tweak.
          </p>
          <div className="flex max-h-[640px] flex-col overflow-auto">
            {ranked.map(({ p, score }, i) => (
              <Link
                key={p.id}
                href={`/property/${p.id}`}
                className="flex items-center gap-3 border-b border-linen/10 px-1.5 py-2.5 hover:bg-linen/5"
              >
                <span className="w-6 font-serif text-[15px] opacity-50">{i + 1}</span>
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-[13px] font-medium">
                    {p.address ?? p.listingUrl}
                  </span>
                  <span className="block text-[10.5px] opacity-50">{p.suburb ?? "—"}</span>
                </span>
                <span className="shrink-0 font-serif text-xl text-[#EBB77A]">{score}</span>
              </Link>
            ))}
          </div>
        </div>
      </div>
    </section>
  );
}
