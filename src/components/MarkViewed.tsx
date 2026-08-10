"use client";

import { useEffect } from "react";
import { useProfile } from "@/lib/profile";
import { markViewed } from "@/lib/viewed";

/**
 * Records `propertyId` as viewed for the active profile. No markup — the
 * detail page is a server component, so this is the ~10-line client sliver
 * that touches localStorage on its behalf (mount-only effect, hydration-safe).
 */
export default function MarkViewed({ propertyId }: { propertyId: string }) {
  const { profile, ready } = useProfile();
  useEffect(() => {
    if (!ready) return;
    markViewed(profile, propertyId);
  }, [ready, profile, propertyId]);
  return null;
}
