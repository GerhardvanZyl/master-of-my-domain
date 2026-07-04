import "../src/lib/load-env";
import { parseFlags } from "../src/lib/args";
import { addGroupMember } from "../src/db/queries/tags";

const f = parseFlags(process.argv.slice(2));
const group = typeof f.group === "string" ? f.group : "";
const image = typeof f.image === "string" ? f.image : "";

if (!group || !image) {
  console.error("Usage: npm run group:add -- --group=<id> --image=<id>");
  process.exit(1);
}

try {
  addGroupMember(group, image);
  console.log(JSON.stringify({ ok: true, group, image }));
} catch (e) {
  console.error(e instanceof Error ? e.message : String(e));
  process.exit(1);
}
