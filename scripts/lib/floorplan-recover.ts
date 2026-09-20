/**
 * Shared floorplan-recovery step for scripts/_recover-floorplans.ts and
 * scripts/floorplan-coverage.ts. The rendered-page sweep the same two scripts
 * share with _verify-live.mjs lives in ./floorplan-scan.mjs — see its header
 * for why that half had to stay plain ESM.
 *
 * Why this module exists at all: the hero-safety invariant below used to be
 * written out twice, once per script, and the two copies drifted — one of them
 * grew a REA exemption the other never had, and that exemption put a
 * notes='floorplan' tag on the image the live app was rendering as the hero of
 * 9 Butchart Close (prop_927d99ebd31f, repaired 2026-09-20). One
 * implementation, no entry point, so importing it can never start a live run.
 *
 * THE INVARIANT, and the only correct way to state it:
 *
 *   The hero is whatever pickHero() returns for the images the app actually
 *   renders — i.e. the array AFTER isVisibleImage(). pickHero NEVER READS
 *   `ordinal`. It prefers an explicit notes='hero', then the lowest "Image N"
 *   index in the alt text, then the lowest-photoIndex 3:2 shot, then the
 *   lowest-index real landscape, then imgs[0]. So "ordinal 0 is the cover" is
 *   false in general and was false in practice: REA writes alt text like
 *   "Media Overview Image 2", which puts an image at ordinal 1 ahead of an
 *   untitled ordinal 0 on the very first rung.
 *
 * Resolving the hero with the real pickHero() also retires the old
 * "skip any property with no explicit notes='hero'" rule. That rule was a
 * stand-in for not knowing which image the app leads with; calling pickHero()
 * answers that exactly, for tagged and untagged properties alike, so there is
 * nothing left to guess and nothing to skip. Excluding pickHero()'s answer is
 * sufficient on its own, because a write from this module can never move it:
 * the tag it emits sets `notes` to 'floorplan' (never 'hero') and preserves a
 * non-'exclude' roomType, and pickHero reads only roomType==='exclude',
 * notes==='hero', alt, sourceUrl, width and height.
 */
import fs from "node:fs";
import path from "node:path";
import { prepareImage } from "@/lib/image-prep";
import { askLocal } from "@/lib/local-llm";
// Import the pure policy module directly, NOT @/db/queries/properties: that
// module imports `db` from ../client at load time, and src/db/client.ts opens
// and migrates data/app.db as an import-time side effect — merely importing
// pickHero from there would connect to and migrate the local (read-only) DB
// every time this recovery pass runs. See src/lib/photo.ts's header.
import { isVisibleImage, pickHero } from "@/lib/photo";

/** Below this, the model's "yes" is too weak to overwrite a live tag on. */
export const FLOORPLAN_THRESHOLD = 0.6;

/**
 * classifyRoom()'s generic ROOM_PROMPT collapses floorplans, site plans,
 * locality maps and unreadable detail shots all into "other" (see
 * src/lib/room-classify.ts) and cannot tell them apart, so floorplan recovery
 * uses this dedicated yes/no prompt instead.
 */
export const FLOORPLAN_PROMPT = `You are looking at one photo from an Australian real-estate listing.
Decide whether this specific image IS the property's architectural floorplan
— a top-down schematic diagram of the dwelling showing room layout, walls,
door/window openings, and (usually) room labels or dimensions.

Answer isFloorplan: true ONLY for that kind of diagram.
Answer isFloorplan: false for everything else, including:
- an ordinary photograph of any room, exterior, garden, or streetscape
- a site plan or lot/subdivision plan (property boundary outline, no interior room layout)
- a locality map, or an annotated aerial/drone shot of the neighbourhood
- agency branding, logo cards, or text/marketing panels with no floorplan content

confidence is your own probability that isFloorplan is correct: 1.0 means
certain, 0.5 means you are genuinely unsure. Be honest — a low number is
useful, an inflated one puts a wrong label in the database.`;

const FLOORPLAN_SCHEMA: Record<string, unknown> = {
  type: "object",
  properties: {
    isFloorplan: { type: "boolean" },
    confidence: { type: "number", minimum: 0, maximum: 1 },
  },
  required: ["isFloorplan", "confidence"],
  additionalProperties: false,
};

export interface FloorplanVerdict {
  isFloorplan: boolean;
  confidence: number;
  source: "model" | "rule";
}

export async function classifyFloorplan(absPath: string, model: string): Promise<FloorplanVerdict> {
  const prepared = prepareImage(absPath);
  if (prepared.kind === "svg") {
    // Same rationale as room-classify.ts's SVG_VERDICT: every SVG in this
    // library is agency branding, never a floorplan, and ffmpeg can't decode
    // SVG at all.
    return { isFloorplan: false, confidence: 1, source: "rule" };
  }
  const raw = (await askLocal({
    model,
    prompt: FLOORPLAN_PROMPT,
    imageBuffer: prepared.buffer,
    imageMime: prepared.mime,
    schema: FLOORPLAN_SCHEMA,
    schemaName: "floorplan_verdict",
  })) as { isFloorplan?: unknown; confidence?: unknown };
  if (typeof raw.isFloorplan !== "boolean") {
    throw new Error(`Model returned an invalid isFloorplan: ${JSON.stringify(raw.isFloorplan)}`);
  }
  if (typeof raw.confidence !== "number" || !Number.isFinite(raw.confidence)) {
    throw new Error(`Model returned an invalid confidence: ${JSON.stringify(raw.confidence)}`);
  }
  return { isFloorplan: raw.isFloorplan, confidence: raw.confidence, source: "model" };
}

/** The getLiveImages() row shape, narrowed to the fields this module reads. */
export interface RecoverableImage {
  id: string;
  localPath: string;
  width: number | null;
  height: number | null;
  alt?: string | null;
  sourceUrl?: string | null;
  ordinal?: number | null;
  roomType: string | null;
  notes: string | null;
}

export interface HeroSplit<T> {
  /** The image the live app renders as the hero; null only when nothing is visible. */
  hero: T | null;
  /** Every other visible image — safe to tag, because none of them is the hero. */
  candidates: T[];
}

/** Splits an image list the way the app sees it: see THE INVARIANT above. */
export function splitOnRenderedHero<T extends RecoverableImage>(images: T[]): HeroSplit<T> {
  const visible = images.filter(isVisibleImage);
  const hero = pickHero(visible);
  return { hero, candidates: visible.filter((i) => i.id !== hero?.id) };
}

export type ClassifyImage<T> = (image: T) => Promise<FloorplanVerdict>;

export interface FloorplanBest {
  imageId: string;
  confidence: number;
  /** Preserved, not invented: floorplan is a notes value, not a room type. */
  roomType: string | null;
}

export interface PropertyRecovery<T> {
  hero: T | null;
  candidates: number;
  /** Candidates the classifier returned a verdict for. */
  classified: number;
  /** Candidates that threw — a download failure, or an unusable verdict. */
  failedImageIds: string[];
  best: FloorplanBest | null;
}

/**
 * One property's recovery pass: exclude the rendered hero, classify every
 * other visible image, keep the most confident floorplan verdict over the
 * threshold. `classify` is injected so the selection policy is testable
 * without a live app or a local model behind it.
 */
export async function recoverFloorplanForProperty<T extends RecoverableImage>(opts: {
  images: T[];
  classify: ClassifyImage<T>;
  onVerdict?: (image: T, verdict: FloorplanVerdict | null, error?: Error) => void;
}): Promise<PropertyRecovery<T>> {
  const { hero, candidates } = splitOnRenderedHero(opts.images);
  const failedImageIds: string[] = [];
  let classified = 0;
  let best: FloorplanBest | null = null;
  for (const image of candidates) {
    try {
      const verdict = await opts.classify(image);
      classified++;
      opts.onVerdict?.(image, verdict);
      const strong = verdict.isFloorplan && verdict.confidence >= FLOORPLAN_THRESHOLD;
      if (strong && (!best || verdict.confidence > best.confidence)) {
        best = { imageId: image.id, confidence: verdict.confidence, roomType: image.roomType };
      }
    } catch (e) {
      failedImageIds.push(image.id);
      opts.onVerdict?.(image, null, e as Error);
    }
  }
  return { hero, candidates: candidates.length, classified, failedImageIds, best };
}

export type RecoveryOutcome = "recovered" | "notClassified" | "noCandidateStored";

/**
 * Which bucket a property belongs in. `notClassified` exists because the other
 * two demand opposite responses: `noCandidateStored` is the STOP-and-ask-for-a
 * -browser-capture bucket, while a property whose every candidate failed to
 * classify (LM Studio down, /api/img erroring) was simply never looked at and
 * needs nothing but a re-run. Filing the second as the first sends an operator
 * asking the user for a capture that is not needed.
 *
 * `noCandidateStored` does NOT mean "every candidate was looked at and none is
 * a floorplan" on its own — it also fires whenever `classified < candidates`
 * (some candidates threw and the rest were clean misses), because re-running
 * this pass is a full re-classification with no per-image cache, and one is
 * not worth it for a single blip among many good verdicts (tech-005). Callers
 * that need to tell "every candidate genuinely classified as not-a-floorplan"
 * apart from "some of them errored" must check the entry's own
 * `failedImageIds`: empty means the former, non-empty means the latter —
 * SKILL.md's STOP condition is gated on exactly that, not on this outcome
 * alone.
 */
export function recoveryOutcome(r: {
  best: FloorplanBest | null;
  candidates: number;
  classified: number;
}): RecoveryOutcome {
  if (r.best) return "recovered";
  return r.candidates > 0 && r.classified === 0 ? "notClassified" : "noCandidateStored";
}

/** The /api/batch `tags` row for a recovered floorplan. */
export function floorplanTagRow(best: FloorplanBest): {
  imageId: string;
  roomType: string;
  confidence: number;
  notes: string;
  taggedBy: string;
  ifAbsent: boolean;
} {
  return {
    imageId: best.imageId,
    roomType: best.roomType ?? "other",
    confidence: best.confidence,
    notes: "floorplan",
    taggedBy: "local-vlm",
    // Must overwrite the room tagger's existing row, so never ifAbsent.
    ifAbsent: false,
  };
}

/**
 * Downloads each candidate from the live app (cached on disk between runs) and
 * classifies it. Throws per image — recoverFloorplanForProperty() records that
 * against the image rather than losing the whole property.
 */
export function liveImageClassifier(opts: {
  base: string;
  propertyId: string;
  tmpDir: string;
  model: string;
}): ClassifyImage<RecoverableImage> {
  return async (image) => {
    const ext = path.extname(image.localPath) || ".webp";
    const file = path.join(opts.tmpDir, `${image.id}${ext}`);
    if (!fs.existsSync(file)) {
      const r = await fetch(`${opts.base}/api/img/${opts.propertyId}/${image.id}${ext}`);
      if (!r.ok) throw new Error(`img ${r.status}`);
      fs.writeFileSync(file, Buffer.from(await r.arrayBuffer()));
    }
    return classifyFloorplan(path.resolve(file), opts.model);
  };
}

