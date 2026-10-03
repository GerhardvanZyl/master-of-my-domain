// Re-sync every live Domain listing's hero against the CURRENT feed cover.
//
// Why: _tag-remote.ts only ever sets a hero for a listing it tags in the
// SAME pass. When an agent changes the cover on Domain between rounds, the
// old hero is never revisited — and nothing ever clears an old hero once a
// new one is set, which is how 4 listings ended up with two (29 of 303 live
// Domain listings measured 2026-10-03 not matching the feed's current cover
// at all). This script is read-only against the live app and writes nothing
// itself; it emits a /api/batch `tags` payload for the caller to push.
//
// Usage: node scripts/_hero-sync-live.mjs [out-payload.json]
// Needs a fresh data/harvest/feed.json (see _domain-round-split.mjs).
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { getAllLiveProperties, getLiveImages, mapLimit } from "./_live-http.mjs";

const BASE = process.env.LIVE_BASE ?? "http://192.168.68.125:3225";
const H = "data/harvest";

const base = (u) => String(u ?? "").split("/").pop().split("?")[0];
// Same ground truth as _pass-apply-live.mjs / _tag-remote.ts's
// isFloorplanBasename — duplicated rather than shared, matching this
// codebase's existing convention of each HTTP-only round script carrying its
// own copy of this one-line regex (see _tag-remote.ts, _pass-apply-live.mjs).
export const isFloorplanBasename = (u) => /^\d+_\d+_3_/.test(base(u));

// Trailing Domain listing id off a URL — same idea as _pass-apply-live.mjs's
// extOf, duplicated rather than shared (see isFloorplanBasename above).
const extOf = (u) => (String(u).match(/-(\d+)(?:\/)?$/) || [])[1] || null;

/**
 * listingUrl -> cover basename, and (feed row's trailing listing id) ->
 * cover basename, from a Domain feed.json's `rows` (column 0 the listing
 * path, column 15 the og:image cover). Two maps because a RELIST changes the
 * listing id — the server merges the new capture onto the existing row by
 * address, so the held row's `externalId` follows the NEW id while
 * `listingUrl` keeps the OLD one (req-002) — so a URL-only lookup misses
 * exactly the listings most likely to have a new cover.
 */
export function buildCoverMaps(feedRows) {
  const coverByUrl = new Map();
  const coverByExt = new Map();
  for (const r of feedRows) {
    const url = "https://www.domain.com.au" + String(r[0]);
    const cover = String(r[15] ?? "");
    coverByUrl.set(url, cover);
    const ext = extOf(url);
    if (ext) coverByExt.set(ext, cover);
  }
  return { coverByUrl, coverByExt };
}

/**
 * The feed's current cover for one live property: by `listingUrl` first,
 * falling back to the feed's trailing listing id against the property's own
 * `externalId` (the relist fallback, req-002 — same `extOf` idea
 * _pass-apply-live.mjs already uses for the same relist shape). `""` when
 * neither matches — the caller treats that as "not in feed".
 */
export function coverForProperty(p, coverByUrl, coverByExt) {
  const byUrl = coverByUrl.get(p.listingUrl);
  if (byUrl) return byUrl;
  if (p.externalId == null) return "";
  return coverByExt.get(String(p.externalId)) ?? "";
}

/**
 * The stored image that should be this listing's hero: the full basename of
 * the feed's cover (feed.json column 15), falling back to the
 * `<listingId>_<photoIndex>_` prefix — a relist keeps its OLD photo ids but
 * gets a new cover reference, same fallback _tag-remote.ts uses for heroIdx.
 * `null` when the cover is not stored at all.
 */
export function findHeroTarget(imgs, coverBasename) {
  if (!coverBasename) return null;
  const exact = imgs.find((i) => base(i.sourceUrl) === coverBasename);
  if (exact) return exact;
  const pre = coverBasename.split("_").slice(0, 2).join("_") + "_";
  return imgs.find((i) => base(i.sourceUrl).startsWith(pre)) ?? null;
}

/**
 * The /api/batch `tags` rows needed to converge one listing's heroes onto
 * `target`: set `notes='hero'` on it (keeping its existing room_type /
 * tagged_by), and clear `notes` on every OTHER current hero — demoting it to
 * `notes='floorplan'` instead when its own basename is a `_3_` image, so a
 * stray hero that is genuinely the floorplan doesn't lose that marker.
 *
 * Returns `{ skip: "no-target" }` when `target` is null, `{ skip: "user-hero" }`
 * when any CURRENT hero is hand-tagged — never repoint a cover a person
 * picked — or `{ skip: "user-target" }` when the TARGET itself is hand-tagged
 * (`taggedBy === "user"`) and already carries a real `notes` value (e.g. a
 * hand-marked 'floorplan'): the brief's skip rule only named a current hero,
 * but the hard constraint that a user tag is never overwritten by any new
 * path is wider and wins (req-004, lead's remedy — see notes.md). A
 * user-tagged target whose `notes` is already `null` carries no hand data to
 * lose, so it may still take the hero mark. Otherwise `{ tags }`, empty when
 * the hero is already correct and there is no stray hero to clear: that
 * emptiness is what makes a re-run idempotent, per the brief.
 */
export function heroSyncTags(imgs, target) {
  const heroes = imgs.filter((i) => i.notes === "hero");
  if (heroes.some((i) => i.taggedBy === "user")) return { skip: "user-hero" };
  if (!target) return { skip: "no-target" };
  if (target.taggedBy === "user" && target.notes != null) return { skip: "user-target" };

  const tags = [];
  if (target.notes !== "hero") {
    tags.push({
      imageId: target.id,
      roomType: target.roomType ?? "other",
      confidence: target.confidence ?? null,
      notes: "hero",
      taggedBy: target.taggedBy ?? "domain-cover",
    });
  }
  for (const h of heroes) {
    if (h.id === target.id) continue;
    tags.push({
      imageId: h.id,
      roomType: h.roomType ?? "other",
      confidence: h.confidence ?? null,
      notes: isFloorplanBasename(h.sourceUrl) ? "floorplan" : null,
      taggedBy: h.taggedBy ?? "claude-code",
    });
  }
  return { tags };
}

async function main() {
  const feed = JSON.parse(fs.readFileSync(`${H}/feed.json`, "utf8"));
  // listingUrl -> cover, and (feed's trailing listing id) -> cover — the
  // second map is the relist fallback (req-002), see buildCoverMaps/
  // coverForProperty above.
  const { coverByUrl, coverByExt } = buildCoverMaps(feed.rows);

  // id/listingUrl/sourceSite/externalId straight off the live DB row (via
  // the flight stream) — no address/slug matching needed, unlike
  // _tag-remote.ts, because PropertyListItem already carries all of them.
  const live = await getAllLiveProperties(BASE);
  const domainLive = live.filter((p) => p.sourceSite === "domain");
  console.log(`live Domain listings: ${domainLive.length}, in current feed: ${coverByUrl.size}`);

  const tags = [];
  const report = {
    notInFeed: [],
    noTarget: [],
    userHero: [],
    userTarget: [],
    alreadyCorrect: 0,
    resynced: 0,
    errors: [],
  };

  await mapLimit(domainLive, 4, async (p) => {
    const cover = coverForProperty(p, coverByUrl, coverByExt);
    if (!cover) {
      report.notInFeed.push(p.address ?? p.listingUrl);
      return;
    }
    let imgs;
    try {
      imgs = await getLiveImages(BASE, p.id);
    } catch (e) {
      report.errors.push(`${p.address ?? p.id}: ${e.message}`);
      return;
    }
    const target = findHeroTarget(imgs, cover);
    const { skip, tags: rowTags } = heroSyncTags(imgs, target);
    if (skip === "no-target") {
      report.noTarget.push(`${p.address ?? p.listingUrl} (cover ${cover})`);
      return;
    }
    if (skip === "user-hero") {
      report.userHero.push(p.address ?? p.listingUrl);
      return;
    }
    if (skip === "user-target") {
      report.userTarget.push(p.address ?? p.listingUrl);
      return;
    }
    if (!rowTags.length) {
      report.alreadyCorrect++;
      return;
    }
    report.resynced++;
    tags.push(...rowTags);
  });

  const out = process.argv[2] ?? `${H}/_batch-tags-hero-sync.json`;
  fs.writeFileSync(out, JSON.stringify({ tags }, null, 1));
  console.log(JSON.stringify({ ...report, tagsEmitted: tags.length, out }, null, 1));
}

// Only run when this file is the entrypoint — same isMain guard _tag-remote.ts
// uses, so a test can import findHeroTarget/heroSyncTags without launching a
// live HTTP sweep (conventions.md: "a script with an unconditional main() at
// module scope is unsafe to import from").
const isMain =
  process.argv[1] !== undefined && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  main().catch((e) => {
    console.error(e);
    process.exit(1);
  });
}
