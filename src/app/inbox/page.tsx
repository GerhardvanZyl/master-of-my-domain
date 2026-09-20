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
          // No mark-read here any more — a share is "unread" until its
          // property is actually opened (see markOpened below), not merely
          // listed. Marking on load made the unread dot vanish (and the bell
          // clear) before the user had looked at anything.
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

  // Mark one share read the moment its property is opened (PropertyRow's
  // `onOpen`, fired on navigation, not on mere render) — so the highlight
  // means "not yet opened", not "not yet listed". Only ever called with an id
  // out of the `items` this page already fetched and rendered (the callback
  // closes over `p.share.id` from the map below), preserving the same
  // "only ids actually shown may be marked read" property the old load-time
  // call had — a share arriving after this GET is simply not in `items` yet,
  // so it can't be touched here either.
  function markOpened(shareId: string) {
    if (!profile) return;
    setItems((prev) =>
      prev
        ? prev.map((it) =>
            it.share.id === shareId && it.share.readAt == null
              ? { ...it, share: { ...it.share, readAt: new Date().toISOString() } }
              : it,
          )
        : prev,
    );
    fetch("/api/shares/read", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ profile, ids: [shareId] }),
    })
      .then(() => window.dispatchEvent(new Event("sharesread")))
      .catch(() => {
        /* best-effort; the optimistic local update above already reflects it */
      });
  }

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
          {items.map((p) => {
            const unopened = p.share.readAt == null;
            return (
              <div
                key={p.share.id}
                className={`overflow-hidden rounded-2xl border bg-white ${
                  unopened ? "border-forest" : "border-line"
                }`}
              >
                <div
                  className={`flex flex-wrap items-center gap-2 border-b border-hairline bg-sand px-4 py-2
                    text-[12.5px] text-[#5a5344]`}
                >
                  {unopened && (
                    <span
                      className={`shrink-0 rounded bg-forest px-1.5 py-0.5 text-[10px] font-bold
                        uppercase tracking-wide text-white`}
                    >
                      Not yet opened
                    </span>
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
                  dense
                  onOpen={unopened ? () => markOpened(p.share.id) : undefined}
                />
              </div>
            );
          })}
        </div>
      )}
    </section>
  );
}
