"use client";

import { useCallback, useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { allJobs, flush, OUTBOX_EVENT } from "@/lib/outbox";

/**
 * Header pill for offline capture: shows when the server is unreachable and how
 * many notes/photos are still waiting to sync. Tapping it retries now.
 *
 * This is also the thing that drives the outbox — it flushes on mount and
 * whenever the browser reports it's back online. Rendered on every page, so
 * anything queued at an inspection goes up as soon as you open the app on wifi.
 */
export default function SyncStatus() {
  const router = useRouter();
  const [pending, setPending] = useState(0);
  const [online, setOnline] = useState(true);
  const [syncing, setSyncing] = useState(false);
  // navigator.onLine has no server equivalent, so nothing renders until mount.
  const [ready, setReady] = useState(false);

  const refresh = useCallback(async () => setPending((await allJobs()).length), []);

  const sync = useCallback(async () => {
    setSyncing(true);
    try {
      const { sent, dropped } = await flush();
      if (sent || dropped) router.refresh();
    } finally {
      setSyncing(false);
      refresh();
    }
  }, [refresh, router]);

  useEffect(() => {
    setReady(true);
    setOnline(navigator.onLine);
    refresh();
    sync();
    const up = () => {
      setOnline(true);
      sync();
    };
    const down = () => setOnline(false);
    window.addEventListener("online", up);
    window.addEventListener("offline", down);
    window.addEventListener(OUTBOX_EVENT, refresh);
    return () => {
      window.removeEventListener("online", up);
      window.removeEventListener("offline", down);
      window.removeEventListener(OUTBOX_EVENT, refresh);
    };
  }, [refresh, sync]);

  if (!ready || (online && pending === 0)) return null;

  const label = syncing
    ? "Syncing…"
    : pending > 0
      ? `${pending} to sync`
      : "Offline";

  return (
    <button
      type="button"
      onClick={sync}
      disabled={syncing}
      title={
        online
          ? "Notes and photos saved on this device — tap to sync now"
          : "No connection. Notes and photos are saved on this device and sync automatically."
      }
      className={`chip shrink-0 whitespace-nowrap ${
        pending > 0 ? "border-amber bg-amber text-linen" : "border-line bg-white text-mute"
      }`}
    >
      <span aria-hidden>{online ? "⟳" : "⛅"}</span>
      <span className="hidden sm:inline">{label}</span>
      <span className="sm:hidden">{pending > 0 ? pending : "!"}</span>
    </button>
  );
}
