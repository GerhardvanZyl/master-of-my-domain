"use client";

import { createContext, useContext, useEffect, useState } from "react";

export const PROFILES = [
  { id: "gerhard", name: "Gerhard", emoji: "🧔" },
  { id: "johanita", name: "Johanita", emoji: "👩" },
] as const;
export type ProfileId = (typeof PROFILES)[number]["id"];

const KEY = "profile";
type Ctx = { profile: ProfileId | null; setProfile: (id: ProfileId) => void; ready: boolean };
const ProfileCtx = createContext<Ctx>({ profile: null, setProfile: () => {}, ready: false });

export function useProfile() {
  return useContext(ProfileCtx);
}

export function ProfileProvider({ children }: { children: React.ReactNode }) {
  const [profile, setProfileState] = useState<ProfileId | null>(null);
  const [ready, setReady] = useState(false);
  // localStorage is client-only; hydrate after mount.
  useEffect(() => {
    const saved = localStorage.getItem(KEY) as ProfileId | null;
    if (saved && PROFILES.some((p) => p.id === saved)) setProfileState(saved);
    setReady(true);
  }, []);
  function setProfile(id: ProfileId) {
    localStorage.setItem(KEY, id);
    setProfileState(id);
  }
  return (
    <ProfileCtx.Provider value={{ profile, setProfile, ready }}>{children}</ProfileCtx.Provider>
  );
}

/** Blocks the whole app until a profile is chosen (task 18). */
export function ProfileGate({ children }: { children: React.ReactNode }) {
  const { profile, setProfile, ready } = useProfile();
  // Avoid flashing the gate before we've read localStorage.
  if (!ready) return null;
  if (profile) return <>{children}</>;
  return (
    <div className="flex min-h-screen items-center justify-center p-6">
      <div className="w-full max-w-sm rounded-2xl border border-neutral-200 bg-white p-8 text-center shadow-sm dark:border-neutral-800 dark:bg-neutral-900">
        <div className="mb-1 text-2xl">🏠</div>
        <h1 className="text-lg font-semibold">Property Compare</h1>
        <p className="mb-6 mt-1 text-sm text-neutral-500">Who&apos;s using the app?</p>
        <div className="flex flex-col gap-3">
          {PROFILES.map((p) => (
            <button
              key={p.id}
              onClick={() => setProfile(p.id)}
              className="rounded-xl border border-neutral-300 px-4 py-3 text-left text-base hover:border-blue-500 hover:bg-blue-50 dark:border-neutral-700 dark:hover:bg-blue-950/40"
            >
              <span className="mr-2 text-xl">{p.emoji}</span>
              {p.name}
            </button>
          ))}
        </div>
        <p className="mt-6 text-xs text-neutral-400">
          You can switch profiles anytime from the top bar.
        </p>
      </div>
    </div>
  );
}

/** Header control: pick a profile if none chosen, else show + allow switching. */
export function ProfileSwitcher() {
  const { profile, setProfile } = useProfile();
  const [open, setOpen] = useState(false);
  if (!profile) {
    return (
      <div className="flex items-center gap-2 text-sm">
        <span className="text-neutral-500">Who&apos;s browsing?</span>
        {PROFILES.map((p) => (
          <button
            key={p.id}
            onClick={() => setProfile(p.id)}
            className="rounded-full border border-neutral-300 px-3 py-1 hover:bg-neutral-100 dark:border-neutral-700 dark:hover:bg-neutral-800"
          >
            {p.emoji} {p.name}
          </button>
        ))}
      </div>
    );
  }
  const me = PROFILES.find((p) => p.id === profile)!;
  return (
    <div className="relative text-sm">
      <button
        onClick={() => setOpen((o) => !o)}
        className="rounded-full border border-neutral-300 px-3 py-1 hover:bg-neutral-100 dark:border-neutral-700 dark:hover:bg-neutral-800"
      >
        {me.emoji} {me.name} ▾
      </button>
      {open && (
        <div className="absolute right-0 z-20 mt-1 rounded-lg border border-neutral-200 bg-white p-1 shadow-lg dark:border-neutral-800 dark:bg-neutral-900">
          {PROFILES.map((p) => (
            <button
              key={p.id}
              onClick={() => {
                setProfile(p.id);
                setOpen(false);
              }}
              className={`block w-full whitespace-nowrap rounded px-3 py-1 text-left hover:bg-neutral-100 dark:hover:bg-neutral-800 ${
                p.id === profile ? "font-semibold" : ""
              }`}
            >
              {p.emoji} {p.name}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
