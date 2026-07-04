import "../src/lib/load-env";
import { parseFlags } from "../src/lib/args";
import { ensureGroup } from "../src/db/queries/tags";

const f = parseFlags(process.argv.slice(2));
const label = typeof f.label === "string" ? f.label : "";
const room = typeof f.room === "string" ? f.room : undefined;

if (!label) {
  console.error(
    "Usage: npm run group:ensure -- --label=<label> [--room=<type>]",
  );
  process.exit(1);
}

const { groupId, created } = ensureGroup({ label, roomType: room });
console.log(JSON.stringify({ groupId, label, created }));
