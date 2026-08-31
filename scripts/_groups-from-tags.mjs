// Build the six room comparison groups' top-up straight from the tag payloads
// this round produced.
//
// _group-topup.ts does the same job by querying the local data/app.db, which is
// never written here — the photos and tags live only on the live app. But every
// property that needs adding is a property we just tagged, and _tag-remote.ts
// records propertyId + ordinal alongside each tag, so the representative image
// is pickable without touching a database or re-scraping the live pages.
//
// Rule (unchanged): ONE image per property per group — the app renders one
// column per property — and it is that property's lowest-ordinal photo of the
// room type. Idempotent: /api/batch reuses a group by label and dedupes members
// on (group_id, image_id) — but NOT on property, so a *different* image for a
// property already in the group would add a second row instead of replacing
// the first. This file is the only guard against that: it reads each room
// group's current membership over HTTP before deciding what's new.
//
// Usage: node scripts/_groups-from-tags.mjs out.json data/harvest/_tags-1.json [...]
//
// No sibling modules: scripts/_group-guard.mjs was retired
// (20260823-1800-fix-tagging-round-defects round 2, arch-004) — it existed
// only to make filterNewCandidates importable around this file's unconditional
// main(), the same reason scripts/_tag-rules.ts was retired from
// scripts/_tag-remote.ts. Both pure decision functions are exported directly
// from the script they belong to instead, behind the isMain guard below.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { fetchFlightFlat, extractArray } from "./_live-http.mjs";

const BASE = process.env.LIVE_BASE ?? "http://192.168.68.125:3225";
const ROOMS = ["kitchen", "bathroom", "bedroom", "living", "dining", "exterior"];

/**
 * GET /api/batch already publishes the label -> {id, members} map that
 * scraping /rooms's rendered chip HTML used to reconstruct: tagStatus()
 * (src/db/queries/tags.ts) selects it straight from similarity_groups /
 * similarity_group_members, and the route spreads it into the response as
 * `groups`. Read it structured instead of scraping markup.
 *
 * Keyed lowercase: ensureGroup (tags.ts) matches labels COLLATE NOCASE, so a
 * group labelled with any uppercase character must still be found here.
 */
async function groupInfoByLabel(base) {
  const res = await fetch(`${base}/api/batch`);
  if (!res.ok) throw new Error(`${base}/api/batch -> HTTP ${res.status}`);
  const { groups } = await res.json();
  const info = new Map();
  for (const g of groups ?? []) info.set(g.label.toLowerCase(), { id: g.id, members: g.members });
  return info;
}

/**
 * Current propertyIds already in a group, via the same flight-stream
 * "columns" prop /rooms?group=<id> passes into RoomColumns (see
 * _live-http.mjs's header for why the flight stream over the badge HTML).
 * No endpoint publishes per-property membership, so this stays an HTTP page
 * read rather than moving onto groupInfoByLabel's /api/batch source above.
 *
 * Anchor-absent (extractArray's throwOnMissing) is the parse-failure signal
 * now, not a comparison against /api/batch's unfiltered membership-row count
 * (arch-003, round 2): that count and this one are different quantities —
 * groupMembers() (src/db/queries/rooms.ts) drops `exclude`-tagged members and
 * collapses many images per property into one column, so "0 members here but
 * >0 there" is not the only shape a parse failure can take, and a property
 * whose only member had since been retagged `exclude` would wrongly trip (or,
 * worse, wrongly NOT trip) that comparison. Confirmed live: `/rooms?group=`
 * serialises the `columns` anchor with an empty array even for a genuinely
 * empty group, so anchor-absent is an exact, self-contained parse-failure
 * signal that doesn't depend on what any other query returns.
 */
async function currentMemberProperties(base, groupId) {
  const flat = await fetchFlightFlat(`${base}/rooms?group=${groupId}`);
  const columns = extractArray(flat, "columns", { throwOnMissing: true });
  return new Set(columns.map((c) => c.propertyId));
}

/**
 * Candidates whose property isn't already a member of the group — the entire
 * growth-prevention rule this file exists to add.
 *
 * @param {{ pid: string }[]} candidates
 * @param {Set<string>} alreadyMemberPids
 */
export function filterNewCandidates(candidates, alreadyMemberPids) {
  return candidates.filter((x) => !alreadyMemberPids.has(x.pid));
}

function readBestByProperty(files) {
  // propertyId -> room -> {ordinal, imageId}
  const best = new Map();
  let seen = 0;
  for (const f of files) {
    for (const t of JSON.parse(fs.readFileSync(f, "utf8")).tags ?? []) {
      seen++;
      if (!t.propertyId || !ROOMS.includes(t.roomType)) continue;
      const byRoom = best.get(t.propertyId) ?? new Map();
      const cur = byRoom.get(t.roomType);
      if (!cur || t.ordinal < cur.ordinal) byRoom.set(t.roomType, { ordinal: t.ordinal, imageId: t.imageId });
      best.set(t.propertyId, byRoom);
    }
  }
  return { best, seen };
}

/**
 * This round's new-member payload for one room. Pure and directly testable
 * (arch-004): `already` is the current membership set the caller has already
 * fetched (and verified — see currentMemberProperties) for this room's group,
 * or an empty Set when the group doesn't exist yet (legitimately empty, not a
 * parse failure). Network I/O and the fail-closed decision both live in
 * main(), so this function makes no assumption about how `already` was
 * produced.
 */
export function buildRoomGroup(room, best, already) {
  const candidates = [...best.entries()]
    .map(([pid, byRoom]) => ({ pid, cand: byRoom.get(room) }))
    .filter((x) => x.cand);
  if (!candidates.length) return null;

  const imageIds = filterNewCandidates(candidates, already).map((x) => x.cand.imageId);
  return imageIds.length ? { label: room, roomType: room, imageIds } : null;
}

export async function main(out, files) {
  const { best, seen } = readBestByProperty(files);

  let groupInfo;
  try {
    groupInfo = await groupInfoByLabel(BASE);
  } catch (e) {
    // Can't verify current membership for ANY room -- writing a payload here
    // would be exactly the unguarded push this file exists to prevent.
    console.error(
      `Cannot read live group info from ${BASE} (${e.message}). ` +
        `Refusing to write an unguarded groups payload -- retry once the live app is reachable.`,
    );
    process.exit(1);
    return;
  }

  const groups = [];
  for (const room of ROOMS) {
    const info = groupInfo.get(room);
    let already = new Set();
    if (info) {
      try {
        already = await currentMemberProperties(BASE, info.id);
      } catch (e) {
        console.error(`"${room}": ${e.message}. Refusing to write an unguarded groups payload.`);
        process.exit(1);
        return;
      }
    } // else: group doesn't exist yet -- membership is genuinely empty.

    const group = buildRoomGroup(room, best, already);
    if (group) groups.push(group);
  }

  fs.writeFileSync(out, JSON.stringify({ groups }, null, 1));
  console.log(
    JSON.stringify({
      tagsRead: seen,
      properties: best.size,
      groups: groups.map((g) => ({ label: g.label, members: g.imageIds.length })),
      out,
    }),
  );
}

// Only run when this file is the entrypoint -- lets tests import
// filterNewCandidates / buildRoomGroup without triggering a live run (mirrors
// scripts/_tag-remote.ts's isMain guard).
const isMain =
  process.argv[1] !== undefined && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  const out = process.argv[2];
  const files = process.argv.slice(3);
  if (!out || !files.length) {
    console.error("usage: node scripts/_groups-from-tags.mjs <out.json> <tags.json...>");
    process.exit(1);
  } else {
    main(out, files).catch((e) => {
      console.error(e);
      process.exit(1);
    });
  }
}
