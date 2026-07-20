import assert from "node:assert/strict";
import { TILE, project } from "../src/lib/mercator";
import {
  DEFAULT_VIBE_CONFIG,
  vibeBreakdown,
  vibeScore,
  type Rating,
} from "../src/lib/vibes";

// --- Web Mercator ----------------------------------------------------------
// Null Island sits dead centre of the z=0 world tile.
const o = project(0, 0, 0);
assert.equal(Math.round(o.x), TILE / 2);
assert.equal(Math.round(o.y), TILE / 2);
// Longitude is linear: ±180° are the world edges.
assert.equal(Math.round(project(0, -180, 3).x), 0);
assert.equal(Math.round(project(0, 180, 3).x), TILE * 8);
// North is up, and each zoom step doubles the pixel scale.
assert.ok(project(40, 0, 5).y < project(-40, 0, 5).y);
assert.equal(project(-37.9, 144.75, 14).x, project(-37.9, 144.75, 13).x * 2);
// Melbourne lands in the tile the standard slippy-map formula says it should
// at z=12 — x=(lng+180)/360·2^z, y=(1−ln(tanφ+secφ)/π)/2·2^z.
const mel = project(-37.8136, 144.9631, 12);
assert.equal(Math.floor(mel.x / TILE), 3697);
assert.equal(Math.floor(mel.y / TILE), 2513);

// --- Vibes scoring ---------------------------------------------------------
const p = {
  priceNumeric: 900_000,
  stationDistanceM: 1200,
  greenCrossDistanceM: 8000,
  playgrounds500m: 0,
  ptMinutesToFlinders: 55,
  hasEaves: 0,
  pergolaCovered: null,
  hasLawn: 1,
};
const ratings: Rating[] = [
  { profile: "gerhard", vibe: "like", look: "good", kitchen: null },
  { profile: "johanita", vibe: "meh", look: null, kitchen: "small" },
];

const rows = vibeBreakdown(p, ratings, DEFAULT_VIBE_CONFIG);
// The panel must add up to the number shown on the card.
assert.equal(
  Math.round(rows.reduce((a, r) => a + r.pts, 0) * 10) / 10,
  vibeScore(p, ratings, DEFAULT_VIBE_CONFIG),
);
assert.equal(rows[0].label, "Base score");
assert.equal(rows[0].pts, 100);
// Both profiles' reactions count separately, and each is attributed.
assert.ok(rows.some((r) => r.label === "gerhard: liked it" && r.pts === 25));
assert.ok(rows.some((r) => r.label === "johanita: meh" && r.pts === -10));
// Only KNOWN-absent features are penalised: eaves=0 docks, pergola=null doesn't.
assert.ok(rows.some((r) => r.label === "No all-around eaves"));
assert.ok(!rows.some((r) => r.label.includes("pergola")));
assert.ok(!rows.some((r) => r.label === "No lawn"));
// Zero-magnitude terms are dropped rather than listed as "0".
assert.ok(rows.every((r) => r.pts !== 0));

console.log("features.test.ts ok");
