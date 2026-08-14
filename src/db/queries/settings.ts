import { eq } from "drizzle-orm";
import { db } from "../client";
import { settings } from "../schema";

/**
 * Small shared key/value store — currently just the vibes-score weights, so
 * both profiles rank properties the same way (see src/lib/vibes.ts).
 * JSON.parse failures return null rather than throwing: a hand-corrupted row
 * must not 500 every page that reads settings.
 */
export function getSetting(key: string): unknown | null {
  const row = db.select().from(settings).where(eq(settings.key, key)).get();
  if (!row) return null;
  try {
    return JSON.parse(row.json);
  } catch {
    return null;
  }
}

export function putSetting(key: string, value: unknown): void {
  const now = new Date().toISOString();
  const json = JSON.stringify(value);
  db.insert(settings)
    .values({ key, json, updatedAt: now })
    .onConflictDoUpdate({ target: settings.key, set: { json, updatedAt: now } })
    .run();
}
