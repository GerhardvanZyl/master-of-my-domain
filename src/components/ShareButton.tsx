"use client";

import { useEffect, useRef, useState } from "react";
import { PROFILES, useProfile } from "@/lib/profile";

/**
 * Popover: pick a profile (from the app's known profiles, minus yourself),
 * optionally add a note, share. POSTs to /api/shares, which upserts on
 * (property, recipient) so re-sharing just re-surfaces it as unread.
 *
 * `stopPropagation` on the wrapper matters here: PropertyGrid's cards navigate
 * on any body click that isn't on an interactive element (see useCardNav /
 * INTERACTIVE_SEL in PropertyGrid.tsx) — a click landing on the popover's
 * padding rather than directly on a button would otherwise bubble up and
 * trigger a card navigation out from under the open popover.
 *
 * `profile` is an optional prop: PropertyGrid already holds the active
 * profile at the top level and passes it down (~290 rows) so those rows never
 * mount `useProfile()` themselves (2 window listeners + a setState per row,
 * per profile change — see the "avoid ~290× work" comments in PropertyGrid).
 * The `useProfile()` fallback below only ever mounts for callers that don't
 * have a profile in scope, i.e. the single instance on the detail page — kept
 * as a separate component (not a conditional hook call inside one component)
 * so the grid's instances genuinely skip the hook rather than just ignoring
 * its result.
 */
export default function ShareButton({
  propertyId,
  iconOnly = false,
  profile,
}: {
  propertyId: string;
  iconOnly?: boolean;
  /** Pass this when the caller already knows the active profile (e.g. PropertyGrid).
   *  Omit it to fall back to the `useProfile()` hook (e.g. the detail page). */
  profile?: string | null;
}) {
  if (profile !== undefined) {
    return <ShareButtonInner propertyId={propertyId} iconOnly={iconOnly} profile={profile} />;
  }
  return <ShareButtonWithHook propertyId={propertyId} iconOnly={iconOnly} />;
}

function ShareButtonWithHook({ propertyId, iconOnly }: { propertyId: string; iconOnly?: boolean }) {
  const { profile } = useProfile();
  return <ShareButtonInner propertyId={propertyId} iconOnly={iconOnly} profile={profile} />;
}

function ShareButtonInner({
  propertyId,
  iconOnly = false,
  profile,
}: {
  propertyId: string;
  iconOnly?: boolean;
  profile: string | null;
}) {
  const [open, setOpen] = useState(false);
  const [note, setNote] = useState("");
  const [sending, setSending] = useState(false);
  const [justShared, setJustShared] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    function onDoc(e: MouseEvent) {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    }
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") setOpen(false);
    }
    document.addEventListener("mousedown", onDoc);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDoc);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);

  useEffect(() => {
    if (!justShared) return;
    const t = setTimeout(() => setJustShared(false), 2500);
    return () => clearTimeout(t);
  }, [justShared]);

  // PROFILES (lib/profile.ts) is the source of truth for identity here —
  // deliberately NOT derived from property_ratings in the DB, which would
  // only ever list whoever has rated something and leave this rendering
  // nothing for the other person. Keep this as-is.
  const others = PROFILES.filter((p) => p.id !== profile);
  if (!profile || others.length === 0) return null;

  const send = async (toProfile: string) => {
    if (sending) return;
    setSending(true);
    try {
      const res = await fetch("/api/shares", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          propertyId,
          fromProfile: profile,
          toProfile,
          note: note.trim() || null,
        }),
      });
      if (res.ok) {
        setOpen(false);
        setNote("");
        setJustShared(true);
      }
    } catch (e) {
      console.warn("share failed", e);
    } finally {
      setSending(false);
    }
  };

  return (
    <div ref={ref} className="relative inline-block" onClick={(e) => e.stopPropagation()}>
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        title="Share this property"
        aria-haspopup="true"
        aria-expanded={open}
        className={
          iconOnly
            ? `shrink-0 rounded-[9px] border px-2.5 py-1.5 text-xs font-bold transition ${
                justShared ? "border-forest bg-forest/15 text-forest" : "border-line bg-white text-body hover:border-forest"
              }`
            : `shrink-0 rounded-[9px] border px-3 py-1.5 text-xs font-bold transition ${
                justShared ? "border-forest bg-forest/15 text-forest" : "border-line bg-white text-body hover:border-forest"
              }`
        }
      >
        {justShared ? "Shared ✓" : iconOnly ? "↗" : "Share"}
      </button>
      {open && (
        <div className="absolute right-0 top-full z-30 mt-1 w-60 rounded-xl border border-line bg-white p-2.5 shadow-lg">
          <div className="label-cap mb-2">Share with</div>
          <div className="mb-2 flex flex-col gap-1">
            {others.map((p) => (
              <button
                key={p.id}
                type="button"
                onClick={() => send(p.id)}
                disabled={sending}
                className="flex items-center gap-2 rounded-lg border border-line px-2.5 py-1.5 text-left text-sm hover:border-forest disabled:opacity-50"
              >
                <span
                  className="flex h-[18px] w-[18px] shrink-0 items-center justify-center rounded-full text-[10px] font-bold text-white"
                  style={{ background: p.colour }}
                >
                  {p.initial}
                </span>
                {p.name}
              </button>
            ))}
          </div>
          <input
            value={note}
            onChange={(e) => setNote(e.target.value)}
            placeholder="Add a note (optional)"
            className="field w-full text-sm"
          />
        </div>
      )}
    </div>
  );
}
