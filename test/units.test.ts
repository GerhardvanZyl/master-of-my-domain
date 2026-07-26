/**
 * Fast, no-browser unit tests for the pure parsing/formatting helpers — the
 * core logic behind every scrape. Runs anywhere (no Chromium, no DB, no net).
 */
import assert from "node:assert";
import { firstInt, parsePrice } from "../src/scrape/adapters/base";
import { deepCollect, collectImageUrls, firstDeep } from "../src/scrape/extract";
import { parseFlags } from "../src/lib/args";
import { imageUrl } from "../src/lib/images";
import { formatPrice, bedBathCar, fmtNum } from "../src/lib/format";
import { priorityScore } from "../src/lib/priority";
import { pickHero } from "../src/db/queries/properties";

// --- firstInt ---
assert.equal(firstInt(4), 4);
assert.equal(firstInt("3 beds"), 3);
assert.equal(firstInt("1,250"), 1250, "strips thousands commas");
assert.equal(firstInt("  12  "), 12);
assert.equal(firstInt(2.9), 2, "truncates floats");
assert.equal(firstInt("none"), null);
assert.equal(firstInt(null), null);
assert.equal(firstInt(NaN), null, "NaN is not a finite number");

// --- parsePrice (money path) ---
assert.equal(parsePrice("$1,250,000"), 1250000);
assert.equal(parsePrice("$1.2m"), 1200000, "m suffix");
assert.equal(parsePrice("$750k"), 750000, "k suffix");
assert.equal(parsePrice("Offers over $1,100,000"), 1100000, "leading words");
assert.equal(parsePrice(900000), 900000, "numeric passthrough");
assert.equal(parsePrice("Contact agent"), null, "no digits -> null");
assert.equal(parsePrice(null), null);
// Regression: a trailing word starting with m/k must NOT be read as a
// million/thousand multiplier. "$550,000 median" is $550k, not $550 billion.
assert.equal(parsePrice("$550,000 median price"), 550000, "no false m-multiplier");
assert.equal(parsePrice("$599,000 knockdown"), 599000, "no false k-multiplier");

// --- deepCollect / firstDeep ---
const tree = { a: 1, b: { a: 2, c: [{ a: 3 }] } };
assert.deepEqual(deepCollect(tree, (k) => k === "a").sort(), [1, 2, 3]);
assert.equal(firstDeep({ x: "", y: "hit" }, ["y"]), "hit");
assert.equal(firstDeep({ x: "", y: "hit" }, ["x", "y"]), "hit", "skips empty string");
assert.equal(firstDeep({ Foo: "v" }, ["foo"]), "v", "case-insensitive key");
assert.equal(firstDeep({}, ["missing"]), undefined);
// Cyclic graphs must not hang the walker.
const cyc: Record<string, unknown> = { a: 1 };
cyc.self = cyc;
assert.deepEqual(deepCollect(cyc, (k) => k === "a"), [1], "handles cycles");

// --- collectImageUrls ---
const host = /cdn\.example\.com/;
const imgTree = {
  hero: "https://cdn.example.com/a.jpg",
  gallery: [
    { url: "https://cdn.example.com/b.png" },
    { url: "https://cdn.example.com/a.jpg" }, // dup -> dropped
    { url: "https://other.com/c.jpg" }, // wrong host -> dropped
    { url: "https://cdn.example.com/notimage.txt" }, // not an image -> dropped
  ],
};
assert.deepEqual(
  collectImageUrls(imgTree, host),
  ["https://cdn.example.com/a.jpg", "https://cdn.example.com/b.png"],
  "first-seen order, deduped, host+extension filtered",
);
assert.deepEqual(
  collectImageUrls({ u: "https://cdn.example.com/x.webp?w=800" }, host),
  ["https://cdn.example.com/x.webp?w=800"],
  "query string after extension is allowed",
);

// --- parseFlags ---
assert.deepEqual(parseFlags(["--room=kitchen"]), { room: "kitchen" });
assert.deepEqual(parseFlags(["--image", "img_1"]), { image: "img_1" });
assert.deepEqual(parseFlags(["--force"]), { force: true }, "bare flag");
assert.deepEqual(
  parseFlags(["--room=bath", "--limit", "5", "--v"]),
  { room: "bath", limit: "5", v: true },
);
assert.deepEqual(parseFlags(["positional", "--k=v"]), { k: "v" }, "ignores positionals");
assert.deepEqual(
  parseFlags(["--notes=has=equals"]),
  { notes: "has=equals" },
  "only splits on first =",
);

// --- imageUrl ---
assert.equal(imageUrl({ localPath: "images/prop_1/0.jpg" }), "/api/img/prop_1/0.jpg");
assert.equal(
  imageUrl({ localPath: "images\\prop_1\\0.jpg" }),
  "/api/img/prop_1/0.jpg",
  "normalizes Windows backslash paths",
);
assert.equal(
  imageUrl({ localPath: "images/prop 1/a b.jpg" }),
  "/api/img/prop%201/a%20b.jpg",
  "url-encodes each segment",
);

// --- format helpers ---
assert.equal(formatPrice("$1.25M", null), "$1.25M", "prefers display string");
assert.equal(formatPrice(null, 1250000), "$1,250,000", "formats numeric AUD");
assert.equal(formatPrice("  ", 0), "—", "blank display + zero numeric -> dash");
assert.equal(bedBathCar(4, 2, 1), "4 bed · 2 bath · 1 car");
assert.equal(bedBathCar(null, null, null), "—");
assert.equal(bedBathCar(0, null, null), "0 bed", "zero is a real value, not missing");
assert.equal(fmtNum(650, " m²"), "650 m²");
assert.equal(fmtNum(null), "—");

// --- priorityScore (ranking: $850k proximity dominates, beds boosts) ---
assert.ok(
  priorityScore(4, 850000) > priorityScore(4, 950000),
  "closer to $850k ranks higher at equal beds",
);
assert.ok(
  priorityScore(5, 850000) > priorityScore(3, 850000),
  "more beds ranks higher at equal price",
);
assert.ok(
  priorityScore(3, 850000) > priorityScore(5, 950000),
  "$100k off outweighs +2 beds (price leads)",
);
assert.equal(priorityScore(4, null), -Infinity, "missing price sinks to bottom");
assert.ok(
  priorityScore(4, 900000) > priorityScore(4, null),
  "any priced listing beats an unpriced one",
);

// --- pickHero (lead with Domain's own cover, never a floorplan/logo) ---
const U = (id: string, pi: number, crop = 1) =>
  `https://rimh2.domainstatic.com.au/x/${id}_${pi}_${crop}_260101_010101-w1-h1`;
type HImg = { width: number | null; height: number | null; notes?: string | null; sourceUrl?: string | null };
// Ordinal order (as ingested) leads with the floorplan; pickHero must skip it
// and return Domain's lowest-photoIndex 3:2 photo instead.
const heroImgs: HImg[] = [
  { width: 1130, height: 800, sourceUrl: U("100", 9, 3) }, // A-paper floorplan, first
  { width: 1600, height: 1067, sourceUrl: U("100", 5) }, // 3:2 photo, index 5
  { width: 1600, height: 1067, sourceUrl: U("100", 1) }, // 3:2 photo, index 1 = cover
  { width: 1080, height: 1080, sourceUrl: U("999", 1) }, // foreign square logo
];
assert.equal(pickHero(heroImgs)?.sourceUrl, U("100", 1), "picks lowest-index 3:2 of own listing");
assert.equal(
  pickHero([{ width: 200, height: 70, sourceUrl: U("1", 1) }, ...heroImgs])?.sourceUrl,
  U("100", 1),
  "ignores a foreign banner strip with a lower index",
);
assert.equal(
  pickHero([{ width: 1, height: 1, notes: "hero", sourceUrl: U("100", 8) }, ...heroImgs])?.sourceUrl,
  U("100", 8),
  "explicit notes='hero' always wins",
);
// Acreage: no 3:2 shot → fall back to lowest-index real landscape (16:9 aerial),
// not the portrait or A-paper floorplan.
assert.equal(
  pickHero([
    { width: 712, height: 1080, sourceUrl: U("200", 2) }, // portrait floorplan
    { width: 1920, height: 1080, sourceUrl: U("200", 5) }, // 16:9 aerial, index 5
    { width: 1920, height: 1080, sourceUrl: U("200", 1) }, // 16:9 aerial, index 1
  ])?.sourceUrl,
  U("200", 1),
  "landscape fallback also leads with lowest index, skips floorplans",
);

console.log("✓ units.test: all assertions passed");
