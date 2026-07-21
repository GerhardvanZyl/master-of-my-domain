"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";

const LINKS = [
  ["/", "Properties"],
  ["/compare", "Compare"],
  ["/rooms", "Rooms"],
  ["/map", "Map"],
  ["/config", "Vibes config"],
] as const;

export default function NavLinks() {
  const pathname = usePathname();
  return (
    <div className="flex items-center gap-1">
      {LINKS.map(([href, label]) => {
        const active =
          href === "/"
            ? pathname === "/" || pathname.startsWith("/property")
            : pathname.startsWith(href);
        return (
          <Link
            key={href}
            href={href}
            className={`relative px-3 py-2 text-[14.5px] font-medium ${
              active ? "text-ink" : "text-mute hover:text-body"
            }`}
          >
            {label}
            {active && (
              <span className="absolute inset-x-3 bottom-0.5 h-0.5 rounded-sm bg-forest" />
            )}
          </Link>
        );
      })}
    </div>
  );
}
