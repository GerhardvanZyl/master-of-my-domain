/**
 * "Viewed" property ids, tracked purely in localStorage — there is no DB
 * column for it. Same per-profile-bucket pattern as PropertyGrid's
 * `filters:<...>` / `compare:<region>` keys.
 */
const KEY = (profile: string | null) => `viewed:${profile ?? "default"}`;

export function loadViewed(profile: string | null): Set<string> {
  try {
    const raw = localStorage.getItem(KEY(profile));
    const parsed = JSON.parse(raw || "[]");
    return new Set(Array.isArray(parsed) ? parsed.filter((x): x is string => typeof x === "string") : []);
  } catch {
    return new Set(); // malformed JSON / quota-blocked read — treat as empty
  }
}

export function markViewed(profile: string | null, propertyId: string): void {
  try {
    const set = loadViewed(profile);
    if (set.has(propertyId)) return; // already recorded, skip the write
    set.add(propertyId);
    localStorage.setItem(KEY(profile), JSON.stringify([...set]));
  } catch {
    /* quota/private mode — ignore, same as the grid's other localStorage writers */
  }
}
