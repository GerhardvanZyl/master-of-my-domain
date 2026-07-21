import type { Metadata } from "next";
import Link from "next/link";
import NavLinks from "@/components/NavLinks";
import { ProfileGate, ProfileProvider, ProfileSwitcher } from "@/components/Profile";
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
        <ProfileProvider>
          <ProfileGate>
          <header className="border-b border-neutral-200 dark:border-neutral-800">
            <nav className="mx-auto flex w-full items-center gap-6 px-6 py-3 text-sm">
              <Link href="/" className="font-semibold">
                🏠 Property Compare
              </Link>
              <NavLinks />
              <div className="ml-auto">
                <ProfileSwitcher />
              </div>
            </nav>
          </header>
          <main className="mx-auto w-full px-6 py-6">{children}</main>
          </ProfileGate>
        </ProfileProvider>
      </body>
    </html>
  );
}
