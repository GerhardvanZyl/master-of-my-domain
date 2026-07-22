"use client";

import { PROFILES, setProfile, useProfile } from "@/lib/profile";

const HouseMark = ({ size = 30, stroke = "#F4F1EA" }) => (
  <svg
    width={size}
    height={size}
    viewBox="0 0 24 24"
    fill="none"
    stroke={stroke}
    strokeWidth="2"
    strokeLinecap="round"
    strokeLinejoin="round"
  >
    <path d="M3 10.5 12 3l9 7.5" />
    <path d="M5 9.5V21h14V9.5" />
    <path d="M9.5 21v-6h5v6" />
  </svg>
);

/**
 * Full-screen "who's browsing?" gate that BLOCKS the app until a profile is
 * chosen. It must live at <body> root (not inside the header) — the header sets
 * `backdrop-blur`, which makes it a containing block for `position: fixed`, so a
 * fixed overlay placed inside it collapses to the header's height instead of the
 * viewport. Rendered here, `fixed inset-0` is opaque and covers everything.
 */
export default function ProfileGate() {
  const { profile, ready } = useProfile();
  if (!ready || profile) return null;
  return (
    <div
      data-testid="profile-gate"
      className="fixed inset-0 z-[100] flex items-center justify-center bg-[linear-gradient(160deg,#1F4A3A,#14342a)] p-6"
    >
      <div className="rise w-full max-w-[520px] text-center">
        <div className="mx-auto mb-5 flex h-14 w-14 items-center justify-center rounded-[15px] bg-white/10">
          <HouseMark />
        </div>
        <div className="mb-2.5 text-xs font-semibold uppercase tracking-[3px] text-amber">
          Property Compare
        </div>
        <h1 className="mb-8 font-serif text-[44px] leading-none text-linen">
          Who&apos;s browsing?
        </h1>
        <div className="flex justify-center gap-4">
          {PROFILES.map((p) => (
            <button
              key={p.id}
              onClick={() => setProfile(p.id)}
              className="max-w-[210px] flex-1 rounded-[18px] border border-linen/15 bg-linen/5 px-4 py-6 text-linen transition hover:-translate-y-0.5 hover:bg-linen/15"
            >
              <span
                className="mx-auto mb-3.5 flex h-[62px] w-[62px] items-center justify-center rounded-full font-serif text-3xl text-white"
                style={{ background: p.colour }}
              >
                {p.initial}
              </span>
              <span className="text-[17px] font-semibold">{p.name}</span>
            </button>
          ))}
        </div>
      </div>
    </div>
  );
}
