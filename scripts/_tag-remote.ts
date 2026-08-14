/**
 * Tag photos on the LIVE app over HTTP only — no local DB, no local image files.
 *
 * `tag:auto` reads data/app.db and data/images; this round the local DB is
 * off-limits (all writes go to http://192.168.68.125:3225 via POST /api/batch),
 * so instead: discover image ids from the live app's rendered property pages,
 * pull the bytes from /api/img, classify with the same local vision model, and
 * write the tags back through /api/batch.
 *
 * Also sets each listing's hero. Domain's own cover is the search feed's
 * images[0] basename, and we know which slot that basename occupies in the
 * gallery we uploaded, so the hero is simply the image at that ordinal.
 *
 * Usage: npx tsx scripts/_tag-remote.ts <out-payload.json>
 */
import fs from "node:fs";
import path from "node:path";
import { classifyRoom, DEFAULT_VISION_MODEL } from "@/lib/room-classify";

const BASE = process.env.LIVE_BASE ?? "http://192.168.68.125:3225";
const H = "data/harvest";
const TMP = process.env.REMOTE_IMG_DIR ?? "./.remote-imgs";
const MODEL = process.env.LOCAL_VLM_MODEL || DEFAULT_VISION_MODEL;
const ROOMS = new Set([
  "kitchen", "bathroom", "bedroom", "living", "dining",
  "exterior", "other", "aerial", "exclude",
]);

const read = (f: string) => JSON.parse(fs.readFileSync(`${H}/${f}`, "utf8"));
const get = async (u: string) => {
  const r = await fetch(u);
  if (!r.ok) throw new Error(`${r.status} ${u}`);
  return r.text();
};
const basename = (u: string) => u.split("/").pop()!.split("?")[0];

async function main() {
  const pass1: Record<string, { imgs?: string[] }> = read("pass-1.json");
  const feed: { rows: unknown[][] } = read("feed.json");
  const items: { listingUrl: string; address?: string }[] = read("feed-items.json");

  // listingUrl -> Domain cover basename (feed images[0] IS the og:image cover)
  const coverByUrl = new Map<string, string>();
  const addrByUrl = new Map<string, string>();
  for (const r of feed.rows) {
    const url = "https://www.domain.com.au" + String(r[0]);
    coverByUrl.set(url, String(r[15] ?? ""));
  }
  for (const it of items) if (it.address) addrByUrl.set(it.listingUrl, it.address);

  // address -> propertyId, scraped from the live home grid
  const home = await get(`${BASE}/`);
  const byAddr = new Map<string, string>();
  // Normalised form, so a listing absent from the current feed (no address in
  // feed-items) can still be matched from its URL slug.
  const norm = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
  const byNorm = new Map<string, string>();
  for (const m of home.matchAll(/href="\/property\/([0-9a-f-]{36})">([^<]{5,120})</g)) {
    byAddr.set(m[2].trim(), m[1]);
    byNorm.set(norm(m[2]), m[1]);
  }
  console.log(`home grid: ${byAddr.size} properties`);
  const slugAddr = (url: string) =>
    norm(url.split("/").pop()!.replace(/-\d{6,}$/, "").replace(/-/g, " "));

  fs.mkdirSync(TMP, { recursive: true });
  const tags: Record<string, unknown>[] = [];
  let classified = 0, skipped = 0, errored = 0;

  for (const [listingUrl, v] of Object.entries(pass1)) {
    if (!v.imgs?.length) continue;
    const addr = addrByUrl.get(listingUrl) ?? "";
    const pid = byAddr.get(addr) ?? byNorm.get(slugAddr(listingUrl));
    if (!pid) {
      console.log(`NO PROPERTY for "${addr}" (${listingUrl})`);
      errored++;
      continue;
    }

    const html = await get(`${BASE}/property/${pid}`);
    // Image ids in document order = ordinal order. Keep the trailing chunk so an
    // existing room badge can be spotted and that photo left alone.
    const seen = new Set<string>();
    const imgs: { id: string; tagged: boolean }[] = [];
    for (const m of html.matchAll(/(img_[0-9a-f]+)\.webp([\s\S]{0,400})/g)) {
      if (seen.has(m[1])) continue;
      seen.add(m[1]);
      const badge = /uppercase[^>]*>([a-z]+)<\/span>/.exec(m[2]);
      imgs.push({ id: m[1], tagged: !!(badge && ROOMS.has(badge[1])) });
    }

    // Which slot is Domain's cover? Full basename first, then the
    // <listingId>_<photoIndex>_ prefix (relisted listings carry another id).
    const cover = coverByUrl.get(listingUrl) ?? "";
    let heroIdx = v.imgs.findIndex((u) => basename(u) === cover);
    if (heroIdx < 0 && cover) {
      const pre = cover.split("_").slice(0, 2).join("_") + "_";
      heroIdx = v.imgs.findIndex((u) => basename(u).startsWith(pre));
    }

    console.log(
      `\n${addr} -> ${pid} | imgs ${imgs.length} (untagged ${imgs.filter((i) => !i.tagged).length}) | hero slot ${heroIdx}`,
    );

    for (let i = 0; i < imgs.length; i++) {
      const im = imgs[i];
      const isHero = i === heroIdx;
      if (im.tagged && !isHero) {
        skipped++;
        continue;
      }
      const file = path.join(TMP, `${im.id}.webp`);
      try {
        if (!fs.existsSync(file)) {
          const r = await fetch(`${BASE}/api/img/${pid}/${im.id}.webp`);
          if (!r.ok) throw new Error(`img ${r.status}`);
          fs.writeFileSync(file, Buffer.from(await r.arrayBuffer()));
        }
        const verdict = await classifyRoom(path.resolve(file), MODEL);
        classified++;
        // Domain puts the floorplan last; notes='floorplan' beats the app's
        // aspect-ratio heuristic, which misses plans rendered at 4:3 and 3:2.
        const isLast = i === imgs.length - 1;
        const notes = isHero
          ? "hero"
          : verdict.room === "other" && isLast
            ? "floorplan"
            : `local:${MODEL}`;
        tags.push({
          imageId: im.id,
          roomType: verdict.room,
          confidence: verdict.confidence,
          notes,
          taggedBy: verdict.source === "rule" ? "rule" : "local-vlm",
          // The hero must overwrite (it carries notes='hero'); everything else
          // must never clobber a hand correction.
          ifAbsent: !isHero,
        });
        process.stdout.write(`${i}${isHero ? "*" : ""}:${verdict.room} `);
      } catch (e) {
        errored++;
        process.stdout.write(`${i}:ERR(${(e as Error).message}) `);
      }
    }
  }

  const out = process.argv[2] ?? "tags-payload.json";
  fs.writeFileSync(out, JSON.stringify({ tags }, null, 1));
  console.log(
    "\n" + JSON.stringify({ classified, skipped, errored, tags: tags.length, out }, null, 1),
  );
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
