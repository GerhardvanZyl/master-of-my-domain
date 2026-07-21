"use client";

import { useEffect, useMemo, useState } from "react";
import type { Property } from "@/db/schema";
import type { PropertyListItem } from "@/db/queries/properties";
import { PROFILES, SHORTLIST_TAGS, useProfile } from "@/lib/profile";
import { DEFAULT_VIBE_CONFIG, loadVibeConfig, vibeBreakdown, type VibeConfig } from "@/lib/vibes";

type Ratings = PropertyListItem["ratings"];

const REACTIONS = [
  { id: "like", emoji: "😍", label: "Like", colour: "#2E7D5B" },
  { id: "meh", emoji: "😐", label: "Meh", colour: "#B9762A" },
  { id: "dislike", emoji: "👎", label: "Dislike", colour: "#B84A3A" },
  { id: "hate", emoji: "😤", label: "Hate", colour: "#8E2F22" },
] as const;

const QUALITY = [
  { field: "look", value: "good", label: "Looks good", pts: "+10" },
  { field: "look", value: "ugly", label: "Looks ugly", pts: "−10" },
  { field: "kitchen", value: "small", label: "Small kitchen", pts: "−10" },
  { field: "kitchen", value: "tiny", label: "Tiny kitchen", pts: "−50" },
] as const;

const FEATURES = [
  { field: "hasEaves", label: "All-around eaves" },
  { field: "pergolaCovered", label: "Covered pergola / veranda" },
  { field: "hasLawn", label: "Has a lawn" },
] as const;

function Card({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div className="card p-4">
      <div className="label-cap mb-2.5">{title}</div>
      {children}
    </div>
  );
}

export default function PropertyRail({
  property,
  ratings: initialRatings,
}: {
  property: Property;
  ratings: Ratings;
}) {
  const { profile } = useProfile();
  const [ratings, setRatings] = useState<Ratings>(initialRatings);
  const [prop, setProp] = useState(property);
  const [cfg, setCfg] = useState<VibeConfig>(DEFAULT_VIBE_CONFIG);
  const [proDraft, setProDraft] = useState("");
  const [conDraft, setConDraft] = useState("");
  const [err, setErr] = useState<string | null>(null);

  useEffect(() => setCfg(loadVibeConfig()), []);
  // ponytail: no router.refresh() / prop-sync effect after a write. Nothing but
  // this rail edits these fields, so the optimistic state IS the truth until
  // the next navigation — syncing from props just let a slow in-flight refresh
  // clobber a newer local edit.

  const mine = ratings.find((r) => r.profile === profile);
  const pros = (prop.pros ?? "").split("\n").filter(Boolean);
  const cons = (prop.cons ?? "").split("\n").filter(Boolean);

  const breakdown = useMemo(
    () => vibeBreakdown(prop, ratings, cfg),
    [prop, ratings, cfg],
  );
  const total = Math.round(breakdown.reduce((a, r) => a + r.pts, 0) * 10) / 10;

  async function send(url: string, body: unknown) {
    setErr(null);
    const res = await fetch(url, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
    if (!res.ok) {
      setErr(`Save failed (${res.status})`);
      return false;
    }
    return true;
  }

  /** Optimistic per-profile rating update. Clicking the active value clears it. */
  async function rate(patch: Record<string, unknown>) {
    if (!profile) return;
    setRatings((prev) => {
      const next = prev.filter((r) => r.profile !== profile);
      next.push({
        profile,
        vibe: null,
        look: null,
        kitchen: null,
        score: null,
        ...mine,
        ...patch,
      } as Ratings[number]);
      return next;
    });
    await send(`/api/properties/${prop.id}/rating`, { profile, ...patch });
  }

  async function patchProperty(patch: Partial<Property>) {
    setProp((p) => ({ ...p, ...patch }));
    await send(`/api/properties/${prop.id}`, patch);
  }

  return (
    <>
      {err && (
        <div className="rounded-xl border border-[#e0b4ac] bg-[#fbeeeb] p-2.5 text-xs text-[#B84A3A]">
          {err}
        </div>
      )}

      <Card title="Shortlist status">
        <div className="flex gap-2">
          {SHORTLIST_TAGS.map((t) => {
            const on = prop.shortlistTag === t.id;
            return (
              <button
                key={t.id}
                onClick={() => patchProperty({ shortlistTag: on ? null : t.id })}
                data-tag={t.id}
                data-active={on ? "true" : "false"}
                className={`flex flex-1 items-center justify-center gap-1.5 rounded-[10px] border px-1.5 py-2.5 text-[12.5px] font-semibold ${
                  on ? "text-white" : "border-line bg-white text-body"
                }`}
                style={on ? { background: t.colour, borderColor: t.colour } : undefined}
              >
                <span
                  className="h-2 w-2 rounded-full"
                  style={{ background: on ? "#fff" : t.colour }}
                />
                {t.label}
              </button>
            );
          })}
        </div>
      </Card>

      {!profile ? (
        <div className="card p-4 text-[13px] text-mute">
          Pick a profile in the header to rate this place.
        </div>
      ) : (
        <>
          <Card title="Your reaction">
            <div className="flex gap-2">
              {REACTIONS.map((r) => {
                const on = mine?.vibe === r.id;
                return (
                  <button
                    key={r.id}
                    onClick={() => rate({ vibe: on ? null : r.id })}
                    className={`flex flex-1 flex-col items-center gap-1 rounded-xl border px-1 py-2.5 ${
                      on ? "bg-white" : "border-line bg-white"
                    }`}
                    style={on ? { borderColor: r.colour, background: `${r.colour}14` } : undefined}
                  >
                    <span className="text-[22px] leading-none">{r.emoji}</span>
                    <span
                      className="text-[10px] font-semibold"
                      style={{ color: on ? r.colour : "#8C8A80" }}
                    >
                      {r.label}
                    </span>
                  </button>
                );
              })}
            </div>
          </Card>

          <div className="card p-4">
            <div className="label-cap mb-2.5">Quality impressions</div>
            <div className="mb-4 flex flex-wrap gap-2">
              {QUALITY.map((q) => {
                const on = mine?.[q.field] === q.value;
                return (
                  <button
                    key={`${q.field}-${q.value}`}
                    onClick={() => rate({ [q.field]: on ? null : q.value })}
                    className={`chip ${on ? "chip-on" : "hover:border-forest"}`}
                  >
                    {q.label} <span className="text-[11px] opacity-70">{q.pts}</span>
                  </button>
                );
              })}
            </div>
            <div className="label-cap mb-2.5">
              Features{" "}
              <span className="font-normal normal-case text-soft">
                · deduced from photos, tap to correct
              </span>
            </div>
            <div className="flex flex-col gap-2">
              {FEATURES.map((f) => {
                const v = prop[f.field] as number | null;
                // Cycles yes → no → unknown, so a wrong deduction is one tap to fix.
                const next = v === 1 ? 0 : v === 0 ? null : 1;
                return (
                  <button
                    key={f.field}
                    onClick={() => patchProperty({ [f.field]: next } as Partial<Property>)}
                    data-feature={f.field}
                    data-value={v === 1 ? "yes" : v === 0 ? "no" : "unknown"}
                    className={`flex items-center justify-between rounded-[10px] border px-3 py-2.5 text-[13px] font-medium ${
                      v === 1
                        ? "border-forest bg-[#F2F6F2] text-forest"
                        : v === 0
                          ? "border-[#e0b4ac] bg-[#fbeeeb] text-[#B84A3A]"
                          : "border-line bg-white text-mute"
                    }`}
                  >
                    {f.label}
                    <span className="font-bold">{v === 1 ? "✓" : v === 0 ? "✗" : "?"}</span>
                  </button>
                );
              })}
            </div>
          </div>

          <Card title="Your score">
            <div className="mb-2 flex items-center justify-between">
              <span
                data-score={mine?.score ?? ""}
                className="font-serif text-[26px] text-forest"
              >
                {mine?.score ?? "—"}
                <span className="text-sm text-mute">/10</span>
              </span>
              {mine?.score != null && (
                <button
                  onClick={() => rate({ score: null })}
                  className="text-xs text-mute hover:text-forest"
                >
                  clear
                </button>
              )}
            </div>
            <input
              type="range"
              min={0}
              max={10}
              step={0.5}
              value={mine?.score ?? 0}
              onChange={(e) => rate({ score: Number(e.target.value) })}
              className="w-full accent-[#1F4A3A]"
            />
            <div className="mt-1 flex justify-between text-[11px] text-soft">
              <span>Pass</span>
              <span>Dream home</span>
            </div>
          </Card>
        </>
      )}

      <div className="card p-4">
        <div className="grid grid-cols-2 gap-4">
          {([
            ["pros", "＋ Pros", "#2E7D5B", "✓", pros, proDraft, setProDraft],
            ["cons", "－ Cons", "#B84A3A", "✗", cons, conDraft, setConDraft],
          ] as const).map(([field, title, colour, mark, items, draft, setDraft]) => (
            <div key={field}>
              <div className="mb-2.5 text-[12.5px] font-semibold" style={{ color: colour }}>
                {title}
              </div>
              <div className="mb-2 flex flex-col gap-1.5">
                {items.map((text, i) => (
                  <div key={`${text}-${i}`} className="flex items-start gap-1.5 text-[12.5px]">
                    <span style={{ color: colour }}>{mark}</span>
                    <span className="flex-1 leading-tight">{text}</span>
                    <button
                      onClick={() =>
                        patchProperty({
                          [field]: items.filter((_, j) => j !== i).join("\n"),
                        } as Partial<Property>)
                      }
                      className="text-sm leading-none text-soft hover:text-[#B84A3A]"
                      aria-label="Remove"
                    >
                      ×
                    </button>
                  </div>
                ))}
              </div>
              <input
                value={draft}
                onChange={(e) => setDraft(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key !== "Enter" || !draft.trim()) return;
                  patchProperty({
                    [field]: [...items, draft.trim()].join("\n"),
                  } as Partial<Property>);
                  setDraft("");
                }}
                placeholder={`Add ${field === "pros" ? "pro" : "con"} + Enter`}
                className="field w-full text-xs font-normal placeholder:text-soft"
              />
            </div>
          ))}
        </div>
      </div>

      <div className="rounded-2xl bg-forest p-4 text-linen">
        <div className="mb-3 flex items-center justify-between">
          <span className="text-[12.5px] font-semibold tracking-wide opacity-70">
            ✨ VIBES SCORE
          </span>
          <span className="font-serif text-3xl leading-none">{total}</span>
        </div>
        <div className="flex flex-col gap-1.5">
          {breakdown.map((b, i) => (
            <div key={`${b.label}-${i}`} className="flex items-center justify-between gap-2.5 text-xs">
              <span className="leading-tight opacity-80">{b.label}</span>
              <span
                className="shrink-0 font-bold"
                style={{ color: b.pts < 0 ? "#E8A08F" : "#A9D8B8" }}
              >
                {b.pts > 0 && b.label !== "Base score" ? "+" : ""}
                {b.pts}
              </span>
            </div>
          ))}
        </div>
        <div className="mt-3 border-t border-linen/15 pt-2.5 text-[11px] opacity-60">
          Tune these weights on the <b>Vibes config</b> page.
        </div>
      </div>

      {ratings.length > 0 && (
        <div className="card p-4">
          <div className="label-cap mb-2.5">Both of you</div>
          <div className="flex flex-col gap-2 text-[13px]">
            {PROFILES.map((pf) => {
              const r = ratings.find((x) => x.profile === pf.id);
              if (!r) return null;
              const bits = [
                REACTIONS.find((x) => x.id === r.vibe)?.label,
                r.look && `looks ${r.look}`,
                r.kitchen && `${r.kitchen} kitchen`,
                r.score != null && `${r.score}/10`,
              ].filter(Boolean);
              return (
                <div key={pf.id} className="flex items-center gap-2">
                  <span
                    className="flex h-[18px] w-[18px] items-center justify-center rounded-full text-[9px] font-bold text-white"
                    style={{ background: pf.colour }}
                  >
                    {pf.initial}
                  </span>
                  <span className="text-mute">{bits.join(" · ") || "no reaction yet"}</span>
                </div>
              );
            })}
          </div>
        </div>
      )}
    </>
  );
}
