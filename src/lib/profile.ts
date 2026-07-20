"use client";

import { useEffect, useState } from "react";

/** The two people using this app. Profiles live only in localStorage — the DB
 *  just stores the profile string on each rating row. */
export const PROFILES = [
  { id: "gerhard", name: "Gerhard", initial: "G", colour: "#B9762A" },
  { id: "johanita", name: "Johanita", initial: "J", colour: "#1F4A3A" },
] as const;

export type ProfileId = (typeof PROFILES)[number]["id"];

const KEY = "profile";
const EVT = "profilechange";

export function getProfile(): ProfileId | null {
  if (typeof localStorage === "undefined") return null;
  const v = localStorage.getItem(KEY);
  return PROFILES.some((p) => p.id === v) ? (v as ProfileId) : null;
}

export function setProfile(id: ProfileId): void {
  localStorage.setItem(KEY, id);
  window.dispatchEvent(new Event(EVT));
}

/**
 * `null` until mounted AND chosen. `ready` distinguishes "not hydrated yet"
 * from "no profile picked" so the gate doesn't flash on every load.
 */
export function useProfile(): { profile: ProfileId | null; ready: boolean } {
  const [profile, setP] = useState<ProfileId | null>(null);
  const [ready, setReady] = useState(false);
  useEffect(() => {
    const sync = () => setP(getProfile());
    sync();
    setReady(true);
    window.addEventListener(EVT, sync);
    window.addEventListener("storage", sync);
    return () => {
      window.removeEventListener(EVT, sync);
      window.removeEventListener("storage", sync);
    };
  }, []);
  return { profile, ready };
}

/** Shortlist triage vocabulary, shared by the grid chips and the detail rail. */
export const SHORTLIST_TAGS = [
  { id: "must-see", label: "Must see", colour: "#1F4A3A" },
  { id: "maybe", label: "Maybe", colour: "#B9762A" },
  { id: "rejected", label: "Rejected", colour: "#B84A3A" },
] as const;
