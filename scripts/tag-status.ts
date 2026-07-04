import "../src/lib/load-env";
import { tagStatus } from "../src/db/queries/tags";

const s = tagStatus();
process.stdout.write(JSON.stringify(s, null, 2) + "\n");

// Human-friendly summary on stderr (stdout stays clean JSON for scripting).
const rooms = Object.entries(s.byRoom)
  .map(([r, c]) => `${r}:${c}`)
  .join(" ");
console.error(
  `\n${s.tagged}/${s.totalImages} images tagged (${s.untagged} untagged). ` +
    `Rooms: ${rooms || "none"}. Groups: ${s.groups.length}.`,
);
