/**
 * Offline outbox replay rules. The IndexedDB half only runs in a browser, so
 * what's checked here is the part that decides what request a queued job turns
 * into and whether a failure is worth retrying — get that wrong and the queue
 * either loses captures or jams forever.
 */
import assert from "node:assert";
import { isSuperseded, jobRequest, replay, type Job } from "../src/lib/outbox";

const notes: Job = { kind: "notes", propertyId: "abc 123", text: "  loved the kitchen  " };
const photo: Job = {
  kind: "media",
  propertyId: "abc 123",
  name: "front.jpg",
  type: "image/jpeg",
  blob: new Blob([new Uint8Array([1, 2, 3])], { type: "image/jpeg" }),
};
const rating: Job = {
  kind: "rating",
  propertyId: "abc 123",
  body: { profile: "gerhard", kitchen: "tiny" },
};
const propertyEdit: Job = {
  kind: "property",
  propertyId: "abc 123",
  body: { hasEaves: 1 },
};

// --- jobRequest ---
const n = jobRequest(notes);
assert.equal(n.url, "/api/properties/abc%20123/notes", "property id is URL-encoded");
assert.equal(n.init.method, "PATCH");
assert.deepEqual(JSON.parse(n.init.body as string), { domainNotes: "  loved the kitchen  " });

const p = jobRequest(photo);
assert.equal(p.url, "/api/properties/abc%20123/media");
assert.equal(p.init.method, "POST");
const form = p.init.body as FormData;
const file = form.get("files") as File;
assert.equal(file.name, "front.jpg", "server reads the field named 'files'");
assert.equal(file.type, "image/jpeg", "mime survives the round trip — the API filters on extension");

const r = jobRequest(rating);
assert.equal(r.url, "/api/properties/abc%20123/rating", "property id is URL-encoded");
assert.equal(r.init.method, "PATCH");
assert.deepEqual(JSON.parse(r.init.body as string), { profile: "gerhard", kitchen: "tiny" });

const pr = jobRequest(propertyEdit);
assert.equal(pr.url, "/api/properties/abc%20123", "property id is URL-encoded");
assert.equal(pr.init.method, "PATCH");
assert.deepEqual(JSON.parse(pr.init.body as string), { hasEaves: 1 });

// --- replay outcomes ---
const res = (status: number) => async () => new Response(null, { status });
const boom = async () => {
  throw new TypeError("Failed to fetch");
};

assert.equal(await replay(notes, res(200) as unknown as typeof fetch), "done");
assert.equal(
  await replay(notes, boom as unknown as typeof fetch),
  "retry",
  "still offline — keep it queued",
);
assert.equal(
  await replay(notes, res(503) as unknown as typeof fetch),
  "retry",
  "server hiccup — keep it queued",
);
assert.equal(
  await replay(notes, res(404) as unknown as typeof fetch),
  "drop",
  "property is gone; retrying forever would jam every later job",
);
assert.equal(await replay(photo, res(400) as unknown as typeof fetch), "drop");

// A new job kind must obey the same outcome rules as everything else — no
// special-casing "rating"/"property" in replay().
assert.equal(
  await replay(rating, boom as unknown as typeof fetch),
  "retry",
  "network throw on a rating job — keep it queued",
);
assert.equal(
  await replay(rating, res(500) as unknown as typeof fetch),
  "retry",
  "5xx on a rating job — keep it queued",
);
assert.equal(
  await replay(rating, res(400) as unknown as typeof fetch),
  "drop",
  "4xx on a rating job — drop it, retrying forever would jam the queue",
);
assert.equal(await replay(rating, res(200) as unknown as typeof fetch), "done");

// --- isSuperseded: the supersede() matching rule -----------------------
// Regression for the Critical: a queued job must only be dropped by a
// successful write that actually makes it stale, never just by sharing a
// kind/propertyId.

// Different property or kind — never superseded, whatever the bodies share.
assert.equal(
  isSuperseded(
    { kind: "rating", propertyId: "other-id", body: { profile: "gerhard", kitchen: "tiny" } },
    "rating",
    "abc 123",
    { profile: "gerhard", kitchen: null },
  ),
  false,
  "different propertyId must never match",
);
assert.equal(
  isSuperseded(
    { kind: "property", propertyId: "abc 123", body: { kitchen: "tiny" } },
    "rating",
    "abc 123",
    { profile: "gerhard", kitchen: null },
  ),
  false,
  "different kind must never match",
);

// Key-scoped, not kind-scoped: a queued `look` edit must survive a successful
// `kitchen` write for the same profile/property — no shared value key.
assert.equal(
  isSuperseded(
    { kind: "rating", propertyId: "abc 123", body: { profile: "gerhard", look: "good" } },
    "rating",
    "abc 123",
    { profile: "gerhard", kitchen: "tiny" },
  ),
  false,
  "queued look edit must survive a successful kitchen write — no overlapping value key",
);

// Same value key overlapping — this is the shape of the bug: an older queued
// `kitchen` job must be dropped by a newer successful `kitchen` write.
assert.equal(
  isSuperseded(
    { kind: "rating", propertyId: "abc 123", body: { profile: "gerhard", kitchen: "tiny" } },
    "rating",
    "abc 123",
    { profile: "gerhard", kitchen: null },
  ),
  true,
  "same profile + overlapping kitchen key must supersede",
);

// Same-profile rule for ratings: a queued job for one profile must never be
// dropped by another profile's successful write, even with an overlapping key.
assert.equal(
  isSuperseded(
    { kind: "rating", propertyId: "abc 123", body: { profile: "johanita", kitchen: "tiny" } },
    "rating",
    "abc 123",
    { profile: "gerhard", kitchen: null },
  ),
  false,
  "a queued johanita job must never be dropped by a gerhard write",
);

// `profile` is an identity field, excluded from the key-overlap check on both
// sides — two bodies sharing ONLY `profile` (no value key) must not match.
assert.equal(
  isSuperseded(
    { kind: "rating", propertyId: "abc 123", body: { profile: "gerhard" } },
    "rating",
    "abc 123",
    { profile: "gerhard", kitchen: null },
  ),
  false,
  "profile alone is not a value key — must not count as an overlap",
);

// `property` jobs have no profile field at all — key overlap alone decides.
assert.equal(
  isSuperseded(
    { kind: "property", propertyId: "abc 123", body: { hasEaves: 1 } },
    "property",
    "abc 123",
    { hasEaves: 0 },
  ),
  true,
  "property kind matches purely on key overlap",
);
assert.equal(
  isSuperseded(
    { kind: "property", propertyId: "abc 123", body: { viewed: "to-view" } },
    "property",
    "abc 123",
    { pros: "big backyard" },
  ),
  false,
  "queued viewed edit must survive a successful pros write",
);

console.log("outbox: ok");
