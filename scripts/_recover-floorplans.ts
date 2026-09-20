/**
 * Job 2 (2026-08-23 straggler round): recover floorplans already stored but
 * never marked, for the live-VIC properties data/harvest/_audit-hero-floorplan.json
 * lists under `noFloorplan`.
 *
 * Real gap being fixed: scripts/_tag-remote.ts applies `notes: "floorplan"`
 * with `ifAbsent: true`, so any image that already carried ANY tag row (even
 * one with roomType='other' from the generic room prompt) silently kept its
 * old notes and the floorplan mark was dropped — setImageTagIfAbsent is an
 * `ON CONFLICT DO NOTHING` insert, not a per-column upsert.
 *
 * The prompt, threshold, hero-exclusion rule and bucket split all live in
 * scripts/lib/floorplan-recover.ts, shared with scripts/floorplan-coverage.ts
 * — see that module's header for why the hero must come from pickHero() and
 * not from `ordinal`. This file is only the orchestration: which properties to
 * visit, and what to write out.
 *
 * roomType is left as whatever the model already classified it (usually
 * "other") — floorplan is a notes value, not a room type, and "floorplan" is
 * not in ROOM_TYPES.
 *
 * Usage: npx tsx scripts/_recover-floorplans.ts
 */
import fs from "node:fs";
import { DEFAULT_VISION_MODEL } from "@/lib/room-classify";
import { getLiveImages } from "./_live-http.mjs";
import {
  floorplanTagRow,
  liveImageClassifier,
  recoverFloorplanForProperty,
  recoveryOutcome,
  type RecoverableImage,
} from "./lib/floorplan-recover";

const BASE = process.env.LIVE_BASE ?? "http://192.168.68.125:3225";
const H = "data/harvest";
const TMP = process.env.REMOTE_IMG_DIR ?? "./.remote-imgs-floorplan";
const MODEL = process.env.LOCAL_VLM_MODEL || DEFAULT_VISION_MODEL;

async function main() {
  const audit = JSON.parse(fs.readFileSync(`${H}/_audit-hero-floorplan.json`, "utf8")) as {
    noFloorplan: { id: string; address: string; imageCount: number }[];
  };
  const targets = audit.noFloorplan;
  console.log(`candidates: ${targets.length}`);
  fs.mkdirSync(TMP, { recursive: true });

  const tags: Record<string, unknown>[] = [];
  const recovered: { id: string; address: string; imageId: string; confidence: number }[] = [];
  const genuinelyNoFloorplan: {
    id: string;
    address: string;
    failedImageIds: string[];
    heroImageId: string | null;
  }[] = [];
  const notClassified: { id: string; address: string; failedImageIds: string[] }[] = [];
  let errored = 0;

  for (const p of targets) {
    const imgs = (await getLiveImages(BASE, p.id)) as RecoverableImage[];
    const result = await recoverFloorplanForProperty({
      images: imgs,
      classify: liveImageClassifier({ base: BASE, propertyId: p.id, tmpDir: TMP, model: MODEL }),
      onVerdict: (im, verdict, error) =>
        process.stdout.write(
          verdict
            ? `${im.id}:${verdict.isFloorplan ? "FP" : "no"}(${verdict.confidence.toFixed(2)}) `
            : `${im.id}:ERR(${error?.message}) `,
        ),
    });
    console.log(
      `\n${p.address} (${p.id}) — ${result.candidates} candidates ` +
        `(hero excluded: ${result.hero?.id ?? "none visible"})`,
    );
    errored += result.failedImageIds.length;

    const outcome = recoveryOutcome(result);
    if (outcome === "recovered" && result.best) {
      recovered.push({
        id: p.id,
        address: p.address,
        imageId: result.best.imageId,
        confidence: result.best.confidence,
      });
      tags.push({ propertyId: p.id, address: p.address, ...floorplanTagRow(result.best) });
    } else if (outcome === "notClassified") {
      notClassified.push({ id: p.id, address: p.address, failedImageIds: result.failedImageIds });
    } else {
      // Names the image splitOnRenderedHero withheld from classification (see
      // recoveryOutcome's doc comment) so this bucket doesn't read as
      // indistinguishable from "no floorplan exists" when it's actually the
      // rendered hero (tech-004) — never tagged here.
      genuinelyNoFloorplan.push({
        id: p.id,
        address: p.address,
        failedImageIds: result.failedImageIds,
        heroImageId: result.hero?.id ?? null,
      });
    }
  }

  fs.mkdirSync(H, { recursive: true });
  fs.writeFileSync(`${H}/_tags-floorplan-recover.json`, JSON.stringify({ tags }, null, 1));
  const stripped = tags.map(({ imageId, roomType, confidence, notes, taggedBy, ifAbsent }) => ({
    imageId,
    roomType,
    confidence,
    notes,
    taggedBy,
    ifAbsent,
  }));
  fs.writeFileSync(
    `${H}/_batch-tags-floorplan-recover.json`,
    JSON.stringify({ tags: stripped }, null, 1),
  );
  fs.writeFileSync(
    `${H}/_floorplan-recover-report.json`,
    JSON.stringify(
      { candidates: targets.length, recovered, notClassified, genuinelyNoFloorplan, errored },
      null,
      1,
    ),
  );

  console.log(
    "\n" +
      JSON.stringify(
        {
          candidates: targets.length,
          recovered: recovered.length,
          notClassified: notClassified.length,
          genuinelyNoFloorplan: genuinelyNoFloorplan.length,
          errored,
        },
        null,
        1,
      ),
  );
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
