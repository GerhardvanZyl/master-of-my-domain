import type { Metadata } from "next";
import Link from "next/link";
import "./globals.css";

export const metadata: Metadata = {
  title: "Property Compare",
  description: "Scrape, store and compare property listings side by side.",
};

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <html lang="en">
      <body>
        <header className="border-b border-neutral-200 dark:border-neutral-800">
          <nav className="mx-auto flex max-w-6xl items-center gap-6 px-4 py-3 text-sm">
            <Link href="/" className="font-semibold">
              🏠 Property Compare
            </Link>
            <Link href="/" className="hover:underline">
              Properties
            </Link>
            <Link href="/compare" className="hover:underline">
              Compare
            </Link>
            <Link href="/rooms" className="hover:underline">
              Rooms
            </Link>
          </nav>
        </header>
        <main className="mx-auto max-w-6xl px-4 py-6">{children}</main>
      </body>
    </html>
  );
}
