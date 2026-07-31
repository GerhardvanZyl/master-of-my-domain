import { ROOM_TYPES, type RoomType } from "@/db/schema";
import { askLocal } from "./local-llm";
import { prepareImage } from "./image-prep";

/** Set LOCAL_VLM_MODEL in .env.local to the model id LM Studio reports. */
export const DEFAULT_VISION_MODEL =
  process.env.LOCAL_VLM_MODEL ?? "qwen/qwen3-vl-8b";

/**
 * The one prompt. Both tag:bench and tag:auto use it — if they diverged, the
 * benchmark would measure a prompt that never ships.
 */
export const ROOM_PROMPT = `You are labelling one photo from an Australian real-estate listing.
Pick exactly one room type from this list: ${ROOM_TYPES.join(", ")}.

Rules for the cases that are actually confusable:
- An open-plan shot showing both a lounge setting (sofas or armchairs actually
  visible) and a dining table -> living. A room showing a kitchen and a dining
  table but NO lounge setting is NOT living: it is dining, or kitchen if the
  kitchen clearly dominates the frame.
- A room whose main subject is a dining table -> dining.
- A room whose main subject is a bed -> bedroom.
- Hallways, corridors, entry foyers, upstairs landings and staircases -> other.
  This applies even when another room (e.g. a lounge) is visible through a
  doorway or over a balustrade — the photo is of the circulation space, not
  that other room.
- A photo taken from inside a room looking out through open doors to a
  courtyard or garden is classified by the interior room it was taken from,
  when that room is identifiable (e.g. shot from a kitchen looking out ->
  kitchen, not exterior).
- Floorplans, site plans, locality maps, and close-up detail shots with no
  readable room -> other.
- An annotated aerial/drone locality shot of the neighbourhood (callouts
  pointing at schools, shops, wetlands etc., often with the subject property
  outlined and an agency logo) -> aerial. Do not confuse with other: aerial is
  specifically the annotated locality shot, other is floorplans/site plans/
  unidentifiable detail shots.
- Agency branding, logo cards, and pure text or price/marketing panels with no
  property content -> exclude. Do not confuse with other: exclude is content
  that should never be shown at all, other is a real (if unidentifiable or
  non-room) part of the listing like a floorplan.
- Facade, street view, driveway, backyard, garden, balcony, deck, pool -> exterior.
- Ensuite, powder room, toilet, and a laundry containing a basin -> bathroom.
  A laundry with no basin -> other.

confidence is your own probability that your label is correct: 1.0 means
certain, 0.5 means you are choosing between two plausible types. Be honest — a
low number is useful because it routes the photo to a human, an inflated one
puts a wrong label in the database.`;

export const ROOM_SCHEMA: Record<string, unknown> = {
  type: "object",
  properties: {
    room: { type: "string", enum: [...ROOM_TYPES] },
    confidence: { type: "number", minimum: 0, maximum: 1 },
  },
  required: ["room", "confidence"],
  additionalProperties: false,
};

export interface RoomVerdict {
  room: RoomType;
  confidence: number;
  /**
   * "model": a real verdict from the vision model.
   * "rule": a deterministic call made without asking the model at all (e.g.
   *   SVG -> exclude). Must be visibly distinguishable from a model answer —
   *   never disguised as one.
   */
  source: "model" | "rule";
}

/** Validate a model reply. The server enforces the schema; this is the belt. */
export function parseRoomVerdict(raw: unknown): RoomVerdict {
  const o = raw as { room?: unknown; confidence?: unknown } | null;
  const room = o?.room;
  if (
    typeof room !== "string" ||
    !(ROOM_TYPES as readonly string[]).includes(room)
  ) {
    throw new Error(`Model returned an invalid room: ${JSON.stringify(room)}`);
  }
  const c = o?.confidence;
  if (typeof c !== "number" || !Number.isFinite(c) || c < 0 || c > 1) {
    throw new Error(
      `Model returned an invalid confidence: ${JSON.stringify(c)}`,
    );
  }
  return { room: room as RoomType, confidence: c, source: "model" };
}

/**
 * SVG files in this library (377, measured) are exclusively agent
 * logos/branding — never a room — and ffmpeg has no SVG decoder, so there is
 * no way to hand one to the model at all. This is a rule, not a guess: it is
 * tagged as `source: "rule"` precisely so it is never mistaken for a model
 * answer downstream (tag:auto's notes, tag:bench's figures). Verdict is
 * `exclude` (not `other`) — agency branding must never be shown in the app.
 */
const SVG_VERDICT: RoomVerdict = { room: "exclude", confidence: 1, source: "rule" };

export async function classifyRoom(
  absPath: string,
  model: string = DEFAULT_VISION_MODEL,
  opts?: { maxEdge?: number },
): Promise<RoomVerdict> {
  const prepared = prepareImage(absPath, { maxEdge: opts?.maxEdge });
  if (prepared.kind === "svg") {
    return SVG_VERDICT;
  }
  return parseRoomVerdict(
    await askLocal({
      model,
      prompt: ROOM_PROMPT,
      imageBuffer: prepared.buffer,
      imageMime: prepared.mime,
      schema: ROOM_SCHEMA,
      schemaName: "room_verdict",
    }),
  );
}

/**
 * The gate. At or above the threshold a tag may be written; below it the photo
 * stays untagged and queues for human review. Inclusive at the boundary.
 */
export function passesGate(v: RoomVerdict, threshold: number): boolean {
  return v.confidence >= threshold;
}
