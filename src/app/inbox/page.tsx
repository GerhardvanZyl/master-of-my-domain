"use client";

import { useEffect, useState } from "react";
import { useProfile } from "@/lib/profile";
import { PropertyRow } from "@/components/PropertyGrid";
import { vibeScore } from "@/lib/vibes";
import { useVibeConfig } from "@/lib/use-vibe-config";
import { fmtRelative } from "@/lib/format";
import type { SharedListItem } from "@/db/queries/shares";

/**
 * Properties shared with the active profile. No server component here — who
 * you are lives only in localStorage (see the identity-model note in
 * lib/profile.ts), so the list has to be fetched client-side once the profile
 * is known. Reuses PropertyGrid's list row for the property itself; this page
 * only adds the share-specific strip (who/when/note) above each one.
 */
export default function InboxPage() {
  const { profile, ready } = useProfile();
  const [items, setItems] = useState<SharedListItem[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  // Same score every property gets on the home grid — shared, DB-backed config
  // (see use-vibe-config.ts), not the hardcoded default, or anyone who's
  // touched /config sees two different numbers for the same property.
  const { cfg: vibeCfg } = useVibeConfig();

  useEffect(() => {
    if (!ready || !profile) return;
    let cancelled = false;

    function load() {
      fetch(`/api/shares?profile=${encodeURIComponent(profile as string)}`)
        .then((r) => (r.ok ? r.json() : Promise.reject(new Error("failed to load"))))
        .then((d: { shares: SharedListItem[] }) => {
          if (cancelled) return;
          setItems(d.shares);
          setError(null);
          // Mark read only what was just shown as unread — NOT "every unread
          // share for this profile" (a share landing between this GET and the
          // POST below would otherwise get silently marked read without ever
          // being displayed). Scoped to its own .catch so a failed mark-read
          // doesn't blank out a list that loaded fine.
          const unreadIds = d.shares.filter((s) => s.share.readAt == null).map((s) => s.share.id);
          fetch("/api/shares/read", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ profile, ids: unreadIds }),
          })
            .then(() => {
              if (!cancelled) window.dispatchEvent(new Event("sharesread"));
            })
            .catch(() => {
              /* best-effort; the list already rendered successfully */
            });
        })
        .catch(() => {
          if (!cancelled) setError("Couldn't load your inbox.");
        });
    }

    load();
    // Leave the tab open, receive a share elsewhere, come back: refetch so the
    // badge and the list agree (same trigger NotificationBadge's poll uses).
    window.addEventListener("focus", load);
    return () => {
      cancelled = true;
      window.removeEventListener("focus", load);
    };
  }, [ready, profile]);

  if (!ready) return null;

  if (!profile) {
    return (
      <p className="rounded-2xl border border-dashed border-line bg-paper p-16 text-center text-mute">
        Pick a profile above to see what&apos;s been shared with you.
      </p>
    );
  }

  return (
    <section className="rise">
      <h1 className="mb-6 font-serif text-[40px] leading-none">Shared with you</h1>

      {items == null && !error && <p className="text-mute">Loading…</p>}
      {error && <p className="text-[#B84A3A]">{error}</p>}
      {items && items.length === 0 && (
        <p className="rounded-2xl border border-dashed border-line bg-paper p-16 text-center text-mute">
          Nobody&apos;s shared a property with you yet.
        </p>
      )}

      {items && items.length > 0 && (
        <div className="flex flex-col gap-3">
          {items.map((p) => (
            <div key={p.share.id} className="overflow-hidden rounded-2xl border border-line bg-white">
              <div className="flex flex-wrap items-center gap-2 border-b border-hairline bg-sand px-4 py-2 text-[12.5px] text-[#5a5344]">
                {p.share.readAt == null && (
                  <span aria-label="unread" className="h-[7px] w-[7px] shrink-0 rounded-full bg-forest" />
                )}
                <span className="font-semibold text-forest">Shared by {p.share.fromProfile}</span>
                <span className="text-mute">· {fmtRelative(p.share.createdAt)}</span>
                {p.share.note && <span className="italic">&ldquo;{p.share.note}&rdquo;</span>}
              </div>
              <PropertyRow
                p={p}
                score={Math.round(vibeScore(p, p.ratings, vibeCfg))}
                isSel={false}
                selectFull={false}
                onToggle={() => {}}
                profile={profile}
                showCompare={false}
              />
            </div>
          ))}
        </div>
      )}
    </section>
  );
}
