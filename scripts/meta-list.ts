import "../src/lib/load-env";
import { parseFlags } from "../src/lib/args";
import { listPropertiesForMetadata } from "../src/db/queries/metadata";

const f = parseFlags(process.argv.slice(2));
const propertyId = typeof f.property === "string" ? f.property : undefined;
const limit = typeof f.limit === "string" ? Number(f.limit) : undefined;
const all = f.all === true;

// JSON to stdout so Claude Code can parse it and Read each image absPath.
process.stdout.write(
  JSON.stringify(listPropertiesForMetadata({ propertyId, limit, all }), null, 2) + "\n",
);
