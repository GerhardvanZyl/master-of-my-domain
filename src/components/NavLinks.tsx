"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";

const LINKS = [
  ["/", "Properties"],
  ["/inspect", "Inspect"],
  ["/compare", "Compare"],
  ["/rooms", "Rooms"],
  ["/map", "Map"],
  ["/inbox", "Inbox"],
  ["/config", "Vibes config"],
] as const;

export default function NavLinks() {
  const pathname = usePathname();
  return (
    <div className="flex min-w-0 items-center gap-1 overflow-x-auto [scrollbar-width:none] [&::-webkit-scrollbar]:hidden">
      {LINKS.map(([href, label]) => {
        const active =
          href === "/"
            ? pathname === "/" || pathname.startsWith("/property")
            : pathname.startsWith(href);
        return (
          <Link
            key={href}
            href={href}
            className={`relative shrink-0 whitespace-nowrap px-2 py-2 text-[14.5px] font-medium sm:px-3 ${
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
