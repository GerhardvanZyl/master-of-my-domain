/**
 * First-class, repeatable LIVE floorplan coverage check.
 *
 * Two independent failure modes cause a property page to render no
 * `>Floorplan<` block (see .claude/review/runs/20260920-1449-bugfix/brief.md,
 * ITEM 4, and the `domain-floorplans` memory this repo was built from):
 *
 *   1. Never downloaded — no candidate image for the floorplan was ever
 *      stored, either because the scraper's gallery source was incomplete
 *      (Domain project/development pages) or because the agent never
 *      published one.
 *   2. Downloaded but not recognised — the floorplan IS among the stored
 *      images, but pickFloorplan's aspect heuristic
 *      (src/db/queries/properties.ts) misses it (4:3, 1.29, 1.47, 3:2, ...)
 *      and no explicit notes='floorplan' tag has been set yet.
 *
 * A plain HTTP scan of the rendered page (as scripts/_audit-hero-floorplan.mjs
 * already does) can name properties missing a floorplan, but CANNOT tell those
 * two modes apart from the page alone — that needs actually looking at what is
 * in the gallery. So, by default, this script classifies every non-hero
 * candidate image of every property missing a floorplan. The prompt, model
 * cutoff, hero exclusion and bucket rule all come from
 * scripts/lib/floorplan-recover.ts, shared verbatim with
 * scripts/_recover-floorplans.ts — read that module's header before changing
 * anything about which image counts as the hero.
 *
 * Buckets:
 *
 *   - storedButUnmarked — at least one stored image classifies as a
 *     floorplan. Recoverable by tagging it (`--write-tags` below).
 *   - noCandidateStored — no candidate classified as the floorplan. Check the
 *     entry's own `failedImageIds`: EMPTY means every candidate was
 *     genuinely looked at and none is a floorplan — EITHER genuinely never
 *     downloaded, OR the agent never published one (this script cannot tell
 *     those apart; closing that needs a fresh browser capture, out of scope
 *     for an unattended pass — STOP and ask). NON-EMPTY means some candidates
 *     threw and a re-run may still find it; do not treat that as a request
 *     for a capture.
 *   - notClassified — the property had candidates but EVERY one of them threw
 *     (LM Studio unreachable, /api/img erroring, an off-schema verdict), so
 *     none was ever looked at. NOT the same as a noCandidateStored entry with
 *     a non-empty `failedImageIds`: this bucket needs only a re-run, never a
 *     browser capture — conflating the two sends someone asking for a capture
 *     that is not needed.
 *
 * KNOWN BLIND SPOT, inherent to every HTTP scan (documented at the top of
 * _live-http.mjs): only VISIBLE images ever reach the client (isVisibleImage()
 * in src/db/queries/properties.ts filters server-side before any component
 * sees the array). An image that is both untagged and outside pickFloorplan's
 * aspect window is invisible to this scan, and to every other one that reads
 * the rendered page or its flight JSON — there is no endpoint that lists raw,
 * unfiltered image rows. So `noCandidateStored` can under-count "never
 * downloaded": some of what it reports there may in fact be a
 * genuinely-invisible STORED image, not an absent one. This script always
 * prints that caveat rather than a number that quietly excludes it.
 *
 * Usage:
 *   npm run floorplan:coverage
 *     Full check: HTTP scan + classification, buckets reported and written
 *     to data/harvest/_floorplan-coverage.json. Slow — one local-model call
 *     per candidate image (~1-4s each); ~2000+ images at 133/567 missing.
 *
 *   npm run floorplan:coverage -- --fast
 *     HTTP-only: names properties missing a floorplan, split by source, but
 *     does NOT run the model and does NOT split the buckets — the report
 *     says so explicitly rather than guessing.
 *
 *   npm run floorplan:coverage -- --write-tags=data/harvest/_batch-tags-floorplan-coverage.json
 *     Also emit a ready-to-push `{tags:[...]}` /api/batch payload for the
 *     storedButUnmarked bucket, from the SAME classification pass (so the
 *     backfill needs no second model sweep). Push it with:
 *       node scripts/batch-push.mjs --base=<live> --file=<that path>
 */
import fs from "node:fs";
import { DEFAULT_VISION_MODEL } from "@/lib/room-classify";
import { getAllLiveProperties, getLiveImages } from "./_live-http.mjs";
import {
  floorplanTagRow,
  liveImageClassifier,
  recoverFloorplanForProperty,
  recoveryOutcome,
  type RecoverableImage,
} from "./lib/floorplan-recover";
import { scanRenderedFloorplans } from "./lib/floorplan-scan.mjs";

const BASE = process.env.LIVE_BASE ?? "http://192.168.68.125:3225";
const H = "data/harvest";
const TMP = process.env.REMOTE_IMG_DIR ?? "./.remote-imgs-floorplan";
const MODEL = process.env.LOCAL_VLM_MODEL || DEFAULT_VISION_MODEL;
const FAST = process.argv.includes("--fast");
const writeTagsArg = process.argv.find((a) => a.startsWith("--write-tags="));
const WRITE_TAGS = writeTagsArg ? writeTagsArg.slice("--write-tags=".length) : null;

interface LiveProperty {
  id: string;
  address: string;
  sourceSite?: string | null;
  state?: string | null;
}

type Site = "domain" | "rea";

interface Target {
  id: string;
  address: string;
  site: Site;
}

async function main() {
  const all = (await getAllLiveProperties(BASE)) as LiveProperty[];
  // "Reachable from the home grid" == every VIC row, live or
  // delisted/sold/withdrawn — the 25 NSW rows live on a separate route
  // (/sydney) and are frozen (see sydney-museum-transit memory). Confirmed
  // empirically 2026-09-20 against the brief's own wording: this filter
  // yields exactly 567 (of 592 total), matching the brief's denominator, and
  // scanning those 567 for the ">Floorplan<" marker reproduces its 73 Domain
  // + 60 REA = 133 exactly.
  const vic = all.filter((p) => (p.state ?? "") !== "NSW");
  console.error(
    `home-grid properties: ${vic.length} (of ${all.length} total; ${all.length - vic.length} frozen NSW excluded)`,
  );

  const targets: Target[] = vic.map((p) => ({
    id: p.id,
    address: p.address,
    site: p.sourceSite === "rea" ? "rea" : "domain",
  }));
  const domainTotal = targets.filter((t) => t.site === "domain").length;
  const reaTotal = targets.length - domainTotal;

  const scan = await scanRenderedFloorplans(BASE, targets, {
    onProgress: (scanned, total) => {
      if (scanned % 50 === 0) console.error(`  ...scanned ${scanned}/${total}`);
    },
  });
  const missing = scan.missing;
  const domainMissing = missing.filter((m) => m.site === "domain").length;
  const reaMissing = missing.length - domainMissing;
  console.error(
    `\nmissing a rendered floorplan: ${missing.length}/${targets.length} ` +
      `(domain ${domainMissing}/${domainTotal}, rea ${reaMissing}/${reaTotal}` +
      `${scan.errors.length ? `; ${scan.errors.length} page(s) unreadable` : ""})`,
  );

  const blindSpotNote =
    "Only VISIBLE images ever reach the client (isVisibleImage() filters " +
    "server-side); an image that is both untagged and outside pickFloorplan's " +
    "aspect window is invisible to this scan. noCandidateStored can therefore " +
    "under-count 'never downloaded' — some of it may be a genuinely-invisible " +
    "stored image rather than an absent one. There is no endpoint that lists " +
    "raw, unfiltered image rows to close this gap.";

  fs.mkdirSync(H, { recursive: true });

  if (FAST) {
    const report = {
      base: BASE,
      mode: "fast" as const,
      checkedAt: new Date().toISOString(),
      homeGridTotal: targets.length,
      domainTotal,
      reaTotal,
      missing: missing.length,
      domainMissing,
      reaMissing,
      scanErrors: scan.errors,
      buckets: null,
      note:
        "fast mode is HTTP-only and does not classify stored images, so it " +
        "cannot split 'no candidate image stored' from 'stored but unmarked' " +
        "— run without --fast for that split. " +
        blindSpotNote,
    };
    fs.writeFileSync(`${H}/_floorplan-coverage.json`, JSON.stringify(report, null, 1));
    console.log(JSON.stringify(report, null, 1));
    return;
  }

  fs.mkdirSync(TMP, { recursive: true });
  type Recovered = Target & { imageId: string; confidence: number; roomType: string | null };
  type Unrecovered = Target & { failedImageIds: string[]; error?: string; heroImageId?: string | null };
  const storedButUnmarked: Recovered[] = [];
  const noCandidateStored: Unrecovered[] = [];
  const notClassified: Unrecovered[] = [];
  let errored = 0;

  let classified = 0;
  // Sequential over properties (mirrors _recover-floorplans.ts): the local
  // model server has no meaningful concurrency to exploit, so parallelising
  // this loop would only queue requests behind each other, not speed them up.
  for (const m of missing) {
    let imgs: RecoverableImage[];
    try {
      imgs = (await getLiveImages(BASE, m.id)) as RecoverableImage[];
    } catch (e) {
      // Unreadable gallery — never looked at, so it belongs with the other
      // re-runnable failures and NOT in the STOP bucket.
      notClassified.push({ ...m, failedImageIds: [], error: (e as Error).message });
      continue;
    }
    const result = await recoverFloorplanForProperty({
      images: imgs,
      classify: liveImageClassifier({ base: BASE, propertyId: m.id, tmpDir: TMP, model: MODEL }),
      onVerdict: (im, _verdict, error) => {
        if (error) console.error(`${m.id}/${im.id}: ${error.message}`);
      },
    });
    errored += result.failedImageIds.length;

    const outcome = recoveryOutcome(result);
    if (outcome === "recovered" && result.best) {
      storedButUnmarked.push({ ...m, ...result.best });
    } else if (outcome === "notClassified") {
      notClassified.push({ ...m, failedImageIds: result.failedImageIds });
    } else {
      // Names the image splitOnRenderedHero withheld from classification, so a
      // property whose only floorplan candidate IS its rendered hero (tech-004)
      // is distinguishable from one with no candidate at all — without ever
      // tagging that image, which would reintroduce the hero-clobbering
      // regression this module's header describes.
      noCandidateStored.push({ ...m, failedImageIds: result.failedImageIds, heroImageId: result.hero?.id ?? null });
    }

    classified++;
    if (classified % 10 === 0) console.error(`  ...classified ${classified}/${missing.length}`);
  }

  const report = {
    base: BASE,
    mode: "deep" as const,
    checkedAt: new Date().toISOString(),
    homeGridTotal: targets.length,
    domainTotal,
    reaTotal,
    missing: missing.length,
    domainMissing,
    reaMissing,
    scanErrors: scan.errors,
    buckets: {
      storedButUnmarked: storedButUnmarked.length,
      noCandidateStored: noCandidateStored.length,
      notClassified: notClassified.length,
    },
    storedButUnmarked,
    noCandidateStored,
    notClassified,
    errored,
    note: blindSpotNote,
  };
  fs.writeFileSync(`${H}/_floorplan-coverage.json`, JSON.stringify(report, null, 1));

  if (WRITE_TAGS) {
    const tags = storedButUnmarked.map((r) =>
      floorplanTagRow({ imageId: r.imageId, confidence: r.confidence, roomType: r.roomType }),
    );
    fs.writeFileSync(WRITE_TAGS, JSON.stringify({ tags }, null, 1));
    console.error(`\nwrote ${tags.length} tag(s) to ${WRITE_TAGS}`);
  }

  console.log(
    JSON.stringify(
      {
        homeGridTotal: targets.length,
        missing: missing.length,
        domainMissing,
        reaMissing,
        scanErrors: scan.errors.length,
        storedButUnmarked: storedButUnmarked.length,
        noCandidateStored: noCandidateStored.length,
        notClassified: notClassified.length,
        errored,
      },
      null,
      1,
    ),
  );
  console.error(`\n${blindSpotNote}`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
