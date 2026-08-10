/**
 * Offline outbox replay rules. The IndexedDB half only runs in a browser, so
 * what's checked here is the part that decides what request a queued job turns
 * into and whether a failure is worth retrying — get that wrong and the queue
 * either loses captures or jams forever.
 */
import assert from "node:assert";
import { jobRequest, replay, type Job } from "../src/lib/outbox";

const notes: Job = { kind: "notes", propertyId: "abc 123", text: "  loved the kitchen  " };
const photo: Job = {
  kind: "media",
  propertyId: "abc 123",
  name: "front.jpg",
  type: "image/jpeg",
  blob: new Blob([new Uint8Array([1, 2, 3])], { type: "image/jpeg" }),
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

console.log("outbox: ok");
