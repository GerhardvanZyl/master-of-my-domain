import "../src/lib/load-env";
import fs from "node:fs";
import { migrate } from "../src/db/migrate";
import { loadProperties } from "../src/db/queries/load";

/**
 * Bulk-load properties gathered by browsing into the DB from a JSON file.
 * Usage: npm run load -- <path-to.json>   (array of LoadItem, see load.ts)
 */
const file = process.argv[2];
if (!file) {
  console.error("Usage: npm run load -- <path-to.json>");
  process.exit(1);
}

migrate();
const items = JSON.parse(fs.readFileSync(file, "utf8"));
console.log(JSON.stringify(loadProperties(items)));
