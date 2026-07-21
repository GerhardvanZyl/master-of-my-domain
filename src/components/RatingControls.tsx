"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { PROFILES, useProfile, type ProfileId } from "./Profile";

type Rating = { profile: string; vibe: string | null; look: string | null; kitchen: string | null };

// label + emoji + point delta, for tooltips. Deltas mirror DEFAULT_VIBE_CONFIG.
const VIBE = [
  { v: "like", emoji: "😍", label: "Like", pts: "+25" },
  { v: "meh", emoji: "😐", label: "Meh", pts: "−10" },
  { v: "dislike", emoji: "🙁", label: "Dislike", pts: "−25" },
  { v: "hate", emoji: "🤮", label: "Hate", pts: "−50" },
];
const LOOK = [
  { v: "good", emoji: "👍", label: "Looks good", pts: "+10" },
  { v: "ugly", emoji: "👎", label: "Looks ugly", pts: "−10" },
];
const KITCHEN = [
  { v: "small", emoji: "🍽️", label: "Small-ish kitchen", pts: "−10" },
  { v: "tiny", emoji: "🔬", label: "Tiny kitchen", pts: "−50" },
];

export default function RatingControls({
  propertyId,
  ratings,
}: {
  propertyId: string;
  ratings: Rating[];
}) {
  const { profile } = useProfile();
  const router = useRouter();
  const [busy, setBusy] = useState(false);

  const mine = ratings.find((r) => r.profile === profile);

  async function set(field: "vibe" | "look" | "kitchen", value: string) {
    if (!profile || busy) return;
    const current = mine?.[field] ?? null;
    // Clicking the active choice again clears it.
    const next = current === value ? "" : value;
    setBusy(true);
    try {
      await fetch(`/api/properties/${propertyId}/rating`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ profile, [field]: next }),
      });
      router.refresh();
    } finally {
      setBusy(false);
    }
  }

  if (!profile) {
    return (
      <p className="text-sm text-neutral-500">
        Pick a profile (top right) to rate this property.
      </p>
    );
  }

  const chip = (active: boolean) =>
    `rounded-full border px-2.5 py-1 text-lg leading-none transition ${
      active
        ? "border-blue-500 bg-blue-50 dark:bg-blue-950"
        : "border-neutral-300 hover:bg-neutral-100 dark:border-neutral-700 dark:hover:bg-neutral-800"
    } ${busy ? "opacity-50" : ""}`;

  const Row = ({
    title,
    opts,
    field,
  }: {
    title: string;
    opts: { v: string; emoji: string; label: string; pts: string }[];
    field: "vibe" | "look" | "kitchen";
  }) => (
    <div className="flex flex-wrap items-center gap-2">
      <span className="w-16 shrink-0 text-xs uppercase tracking-wide text-neutral-400">{title}</span>
      {opts.map((o) => (
        <button
          key={o.v}
          type="button"
          disabled={busy}
          onClick={() => set(field, o.v)}
          title={`${o.label} (${o.pts})`}
          aria-label={`${o.label} (${o.pts})`}
          className={chip(mine?.[field] === o.v)}
        >
          {o.emoji}
        </button>
      ))}
      {/* Native select — the mobile-friendly "checkbox dropdown" equivalent. */}
      <select
        value={mine?.[field] ?? ""}
        disabled={busy}
        onChange={(e) => set(field, e.target.value)}
        className="ml-auto rounded border border-neutral-300 bg-transparent px-1 py-0.5 text-xs sm:hidden dark:border-neutral-700"
        aria-label={`${title} rating`}
      >
        <option value="">—</option>
        {opts.map((o) => (
          <option key={o.v} value={o.v}>
            {o.label} ({o.pts})
          </option>
        ))}
      </select>
    </div>
  );

  return (
    <div className="space-y-2">
      <Row title="Vibe" opts={VIBE} field="vibe" />
      <Row title="Look" opts={LOOK} field="look" />
      <Row title="Kitchen" opts={KITCHEN} field="kitchen" />
      <OtherProfiles ratings={ratings} me={profile} />
    </div>
  );
}

/** Read-only summary of the OTHER profile's picks, so you see the combined effect. */
function OtherProfiles({ ratings, me }: { ratings: Rating[]; me: ProfileId }) {
  const rows = PROFILES.filter((p) => p.id !== me)
    .map((p) => ({ p, r: ratings.find((x) => x.profile === p.id) }))
    .filter((x) => x.r && (x.r.vibe || x.r.look || x.r.kitchen));
  if (rows.length === 0) return null;
  const emoji = (list: { v: string; emoji: string; label: string }[], v: string | null) =>
    v ? list.find((o) => o.v === v)?.emoji : null;
  return (
    <div className="pt-1 text-xs text-neutral-500">
      {rows.map(({ p, r }) => (
        <span key={p.id} className="mr-3">
          {p.emoji} {p.name}: {emoji(VIBE, r!.vibe)} {emoji(LOOK, r!.look)} {emoji(KITCHEN, r!.kitchen)}
        </span>
      ))}
    </div>
  );
}
