"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import { useProfile } from "@/lib/profile";

// ponytail: plain interval polling, not SSE/websockets — this is a two-person
// LAN app, 30s staleness is a non-issue. Revisit only if that ever changes.
const POLL_MS = 30_000;

/**
 * Shared unread-count poller behind both bells below: fetches `url` (skipped
 * entirely when null — e.g. no profile picked yet), refreshes every POLL_MS
 * and on window focus, and refreshes immediately when `clearEvent` fires —
 * dispatched by the page that just cleared the count so the badge doesn't
 * wait out a full poll interval on the same tab.
 */
function useUnreadCount(url: string | null, clearEvent: string): number {
  const [count, setCount] = useState(0);

  useEffect(() => {
    if (!url) {
      setCount(0);
      return;
    }
    let cancelled = false;
    const load = () => {
      fetch(url)
        .then((r) => (r.ok ? r.json() : null))
        .then((d: { count?: number } | null) => {
          if (!cancelled && d) setCount(d.count ?? 0);
        })
        .catch(() => {
          /* offline / transient — next poll retries */
        });
    };
    load();
    const id = setInterval(load, POLL_MS);
    window.addEventListener("focus", load);
    window.addEventListener(clearEvent, load);
    return () => {
      cancelled = true;
      clearInterval(id);
      window.removeEventListener("focus", load);
      window.removeEventListener(clearEvent, load);
    };
  }, [url, clearEvent]);

  return count;
}

function Bell({
  href,
  icon,
  title,
  count,
}: {
  href: string;
  icon: string;
  title: string;
  count: number;
}) {
  return (
    <Link
      href={href}
      title={title}
      aria-label={count > 0 ? `${title}, ${count} unread` : title}
      className="relative flex h-9 w-9 shrink-0 items-center justify-center rounded-full border
        border-line bg-white text-base hover:border-forest"
    >
      {icon}
      {count > 0 && (
        <span
          className="absolute -right-1 -top-1 flex h-[18px] min-w-[18px] items-center justify-center
            rounded-full bg-[#B84A3A] px-1 text-[10px] font-bold leading-none text-white"
        >
          {count > 9 ? "9+" : count}
        </span>
      )}
    </Link>
  );
}

/** Header bells: shares (per profile) linking to /inbox, and watchlist changes
 *  (shared, not per profile) linking to /history?watch=1. */
export default function NotificationBadge() {
  const { profile } = useProfile();
  const shareUrl = profile ? `/api/shares/unread?profile=${encodeURIComponent(profile)}` : null;
  const shareCount = useUnreadCount(shareUrl, "sharesread");
  // Shared watermark, not per profile — see /api/changes/unread — so this one
  // is never gated on `profile` the way the share bell is.
  const watchCount = useUnreadCount("/api/changes/unread", "watchread");

  return (
    <div className="flex items-center gap-1.5">
      <Bell href="/inbox" icon="🔔" title="Shared with you" count={shareCount} />
      <Bell href="/history?watch=1" icon="⭐" title="Watchlist changes" count={watchCount} />
    </div>
  );
}
