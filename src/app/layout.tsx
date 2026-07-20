import type { Metadata } from "next";
import Link from "next/link";
import NavLinks from "@/components/NavLinks";
import ProfileBar from "@/components/ProfileBar";
import "./globals.css";

export const metadata: Metadata = {
  title: "Property Compare",
  description: "Scrape, store and compare property listings side by side.",
};

// ponytail: plain <link> for the webfonts rather than next/font — the app is
// local-only and this keeps `next build` from needing network.
export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <html lang="en">
      <head>
        <link rel="preconnect" href="https://fonts.googleapis.com" />
        <link rel="preconnect" href="https://fonts.gstatic.com" crossOrigin="" />
        <link
          href="https://fonts.googleapis.com/css2?family=Instrument+Serif:ital@0;1&family=Geist:wght@300;400;500;600;700&display=swap"
          rel="stylesheet"
        />
      </head>
      <body>
        <header className="sticky top-0 z-40 border-b border-headline bg-[rgba(244,241,234,0.86)] backdrop-blur-md">
          <nav className="mx-auto flex h-16 w-full max-w-[1560px] items-center gap-9 px-8">
            <Link href="/" className="flex items-center gap-2.5">
              <span className="flex h-[30px] w-[30px] items-center justify-center rounded-lg bg-forest">
                <svg
                  width="17"
                  height="17"
                  viewBox="0 0 24 24"
                  fill="none"
                  stroke="#F4F1EA"
                  strokeWidth="2"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                >
                  <path d="M3 10.5 12 3l9 7.5" />
                  <path d="M5 9.5V21h14V9.5" />
                  <path d="M9.5 21v-6h5v6" />
                </svg>
              </span>
              <span className="font-serif text-[22px] tracking-[0.2px]">
                Property Compare
              </span>
            </Link>
            <NavLinks />
            <ProfileBar />
          </nav>
        </header>
        <main className="mx-auto w-full max-w-[1560px] px-8 pb-20 pt-7">
          {children}
        </main>
      </body>
    </html>
  );
}
