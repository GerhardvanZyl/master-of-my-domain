import "../src/lib/load-env";
import { parseFlags } from "../src/lib/args";
import { listUntaggedImages } from "../src/db/queries/tags";

const flags = parseFlags(process.argv.slice(2));
const propertyId =
  typeof flags.property === "string" ? flags.property : undefined;
const limit = typeof flags.limit === "string" ? Number(flags.limit) : undefined;

const images = listUntaggedImages({ propertyId, limit });
// JSON to stdout so Claude Code can parse it and Read each absPath.
process.stdout.write(JSON.stringify(images, null, 2) + "\n");
