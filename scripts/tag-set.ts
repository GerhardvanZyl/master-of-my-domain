import "../src/lib/load-env";
import { parseFlags } from "../src/lib/args";
import { setImageTag, isRoomType } from "../src/db/queries/tags";
import { ROOM_TYPES } from "../src/db/schema";

const f = parseFlags(process.argv.slice(2));
const image = typeof f.image === "string" ? f.image : "";
const room = typeof f.room === "string" ? f.room : "";
const confidence =
  typeof f.confidence === "string" ? Number(f.confidence) : undefined;
const notes = typeof f.notes === "string" ? f.notes : undefined;

if (!image || !room) {
  console.error(
    "Usage: npm run tag:set -- --image=<id> --room=<type> [--confidence=0.9] [--notes=...]\n" +
      `Valid rooms: ${ROOM_TYPES.join(", ")}`,
  );
  process.exit(1);
}
if (!isRoomType(room)) {
  console.error(`Invalid room "${room}". Valid: ${ROOM_TYPES.join(", ")}`);
  process.exit(1);
}

try {
  setImageTag({ imageId: image, roomType: room, confidence, notes });
  console.log(JSON.stringify({ ok: true, image, room }));
} catch (e) {
  console.error(e instanceof Error ? e.message : String(e));
  process.exit(1);
}
