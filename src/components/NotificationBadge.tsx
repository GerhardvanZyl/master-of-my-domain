"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import { useProfile } from "@/lib/profile";

// ponytail: plain interval polling, not SSE/websockets — this is a two-person
// LAN app, 30s staleness is a non-issue. Revisit only if that ever changes.
const POLL_MS = 30_000;

/** Header bell linking to /inbox, showing the active profile's unread share count. */
export default function NotificationBadge() {
  const { profile } = useProfile();
  const [count, setCount] = useState(0);

  useEffect(() => {
    if (!profile) {
      setCount(0);
      return;
    }
    let cancelled = false;
    const load = () => {
      fetch(`/api/shares/unread?profile=${encodeURIComponent(profile)}`)
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
    // Dispatched by /inbox right after it marks shares read, so the badge
    // doesn't wait out a full poll interval to clear on the same tab.
    window.addEventListener("sharesread", load);
    return () => {
      cancelled = true;
      clearInterval(id);
      window.removeEventListener("focus", load);
      window.removeEventListener("sharesread", load);
    };
  }, [profile]);

  return (
    <Link
      href="/inbox"
      title="Shared with you"
      aria-label={count > 0 ? `Inbox, ${count} unread` : "Inbox"}
      className="relative flex h-9 w-9 shrink-0 items-center justify-center rounded-full border border-line bg-white text-base hover:border-forest"
    >
      🔔
      {count > 0 && (
        <span className="absolute -right-1 -top-1 flex h-[18px] min-w-[18px] items-center justify-center rounded-full bg-[#B84A3A] px-1 text-[10px] font-bold leading-none text-white">
          {count > 9 ? "9+" : count}
        </span>
      )}
    </Link>
  );
}
