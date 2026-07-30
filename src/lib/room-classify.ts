import { ROOM_TYPES, type RoomType } from "@/db/schema";
import { askLocal } from "./local-llm";

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
- An open-plan shot showing both a lounge setting and a dining table -> living.
- A room whose main subject is a dining table -> dining.
- A room whose main subject is a bed -> bedroom.
- Floorplans, site plans, locality maps, agent branding, price or text overlays,
  and close-up detail shots with no readable room -> other.
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
  return { room: room as RoomType, confidence: c };
}

export async function classifyRoom(
  absPath: string,
  model: string = DEFAULT_VISION_MODEL,
): Promise<RoomVerdict> {
  return parseRoomVerdict(
    await askLocal({
      model,
      prompt: ROOM_PROMPT,
      imagePath: absPath,
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
