"use client";

import { useEffect } from "react";

/**
 * Rendered only by /history?watch=1. Clears the watchlist bell's unread
 * watermark on mount, then fires "watchread" so NotificationBadge's poll
 * doesn't wait out a full interval to reflect it on this tab — same pattern
 * /inbox uses with "sharesread".
 */
export default function ClearWatchWatermark() {
  useEffect(() => {
    fetch("/api/changes/unread", { method: "POST" })
      .then(() => window.dispatchEvent(new Event("watchread")))
      .catch(() => {
        /* best-effort; the list already rendered successfully */
      });
  }, []);
  return null;
}
