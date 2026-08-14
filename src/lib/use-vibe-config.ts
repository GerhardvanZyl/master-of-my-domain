"use client";

import { useCallback, useEffect, useState } from "react";
import {
  DEFAULT_VIBE_CONFIG,
  loadVibeConfig,
  loadVibeConfigLocal,
  parseVibeConfig,
  saveVibeConfig,
  saveVibeConfigLocal,
  type VibeConfig,
} from "@/lib/vibes";

/**
 * Shared source of truth for the vibes-score weights: DB-backed via
 * /api/config, cached in localStorage for offline reads, with a per-browser
 * opt-out (`local`) that keeps this device's numbers private.
 *
 * - `local` off (default): hydrate from the local cache first (so there's
 *   never a flash of defaults), then fetch the server value and let it win.
 *   `save()` writes the cache AND PUTs to the server.
 * - `local` on: never apply the fetched server value and never PUT — this
 *   browser's config is purely local and can't clobber the other profile's.
 *
 * ponytail: one shared row plus a single local opt-out flag — no per-profile
 * server configs, no merge UI. A failed PUT (offline) is silently dropped,
 * not queued; upgrade path if that ever matters is src/lib/outbox.ts.
 */
export function useVibeConfig(): {
  cfg: VibeConfig;
  save: (next: VibeConfig) => void;
  local: boolean;
  setLocal: (next: boolean) => void;
} {
  // Server and first client render must match, so start at the same default
  // every consumer already hydrates away from in an effect.
  const [cfg, setCfg] = useState<VibeConfig>(DEFAULT_VIBE_CONFIG);
  const [local, setLocalState] = useState(false);

  const syncFromServer = useCallback(() => {
    fetch("/api/config")
      .then((r) => (r.ok ? r.json() : Promise.reject(new Error("failed to load config"))))
      .then((d: { vibeConfig: unknown }) => {
        const parsed = parseVibeConfig(d.vibeConfig);
        saveVibeConfig(parsed); // refresh the offline cache
        setCfg(parsed);
      })
      .catch(() => {
        // Offline / server unreachable — keep whatever the local cache gave us.
      });
  }, []);

  useEffect(() => {
    setCfg(loadVibeConfig());
    const isLocal = loadVibeConfigLocal();
    setLocalState(isLocal);
    if (!isLocal) syncFromServer();
  }, [syncFromServer]);

  const save = useCallback(
    (next: VibeConfig) => {
      setCfg(next);
      saveVibeConfig(next);
      if (local) return; // local override: never let this device write the shared row
      fetch("/api/config", {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(next),
      }).catch(() => {
        // ponytail: a failed PUT while offline is silently ignored, not
        // retried — upgrade path is queuing it in src/lib/outbox.ts.
      });
    },
    [local],
  );

  const setLocal = useCallback(
    (next: boolean) => {
      setLocalState(next);
      saveVibeConfigLocal(next);
      // ON -> OFF: converge back to the shared value immediately, no reload.
      // OFF -> ON: just stop syncing; keep whatever's currently showing.
      if (!next) syncFromServer();
    },
    [syncFromServer],
  );

  return { cfg, save, local, setLocal };
}
