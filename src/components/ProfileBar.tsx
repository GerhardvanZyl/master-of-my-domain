"use client";

import { PROFILES, setProfile, useProfile } from "@/lib/profile";

/**
 * Header profile switcher. The full-screen "who's browsing?" gate lives in its
 * own component (ProfileGate) rendered at <body> root — it can't be here because
 * the header's `backdrop-blur` traps `position: fixed` to the header box.
 */
export default function ProfileBar() {
  const { profile } = useProfile();

  return (
    <div className="ml-auto flex items-center gap-2.5">
      <span className="hidden text-[13px] text-mute sm:inline">Who&apos;s browsing?</span>
      {PROFILES.map((p) => {
        const on = profile === p.id;
        return (
          <button
            key={p.id}
            onClick={() => setProfile(p.id)}
            data-profile={p.id}
            data-active={on ? "true" : "false"}
            className={`flex items-center gap-1.5 rounded-full border py-1 pl-1.5 pr-2.5 text-[13px] font-semibold ${
              on ? "border-forest bg-forest text-linen" : "border-line bg-white text-body"
            }`}
          >
            <span
              className="flex h-[22px] w-[22px] items-center justify-center rounded-full text-[11px] font-bold text-white"
              style={{ background: p.colour }}
            >
              {p.initial}
            </span>
            <span className="hidden sm:inline">{p.name}</span>
          </button>
        );
      })}
    </div>
  );
}
