"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";

const LINKS = [
  ["/", "Properties"],
  ["/compare", "Compare"],
  ["/rooms", "Rooms"],
] as const;

export default function NavLinks() {
  const pathname = usePathname();
  return (
    <>
      {LINKS.map(([href, label]) => {
        const active =
          href === "/"
            ? pathname === "/" || pathname.startsWith("/property")
            : pathname.startsWith(href);
        return (
          <Link
            key={href}
            href={href}
            className={
              active
                ? "font-medium underline underline-offset-4"
                : "text-neutral-500 hover:underline dark:text-neutral-400"
            }
          >
            {label}
          </Link>
        );
      })}
    </>
  );
}
