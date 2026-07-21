import "../src/lib/load-env";
import { parseFlags } from "../src/lib/args";
import { META_COLUMNS, setPropertyMetadata } from "../src/db/queries/metadata";

// 0/1 flags, numeric-sqm flags, and the one enum flag.
const BOOL = new Set(["has-eaves", "pergola", "has-lawn"]);
const NUM = new Set([
  "master-bed",
  "avg-other-bed",
  "common-areas",
  "balcony",
  "back-garden",
]);

const f = parseFlags(process.argv.slice(2));
const property = typeof f.property === "string" ? f.property : "";

if (!property) {
  console.error(
    "Usage: npm run meta:set -- --property=<id> [flags]\n" +
      "Flags: --has-eaves=0|1 --master-bed=<sqm> --avg-other-bed=<sqm>\n" +
      "       --common-areas=<n> --balcony=<sqm> --back-garden=<sqm>\n" +
      "       --pergola=0|1 --has-lawn=0|1 --lawn-type=real|fake\n" +
      "Pass empty (e.g. --balcony=) to clear a value to NULL.",
  );
  process.exit(1);
}

const values: Record<string, number | string | null> = {};
for (const key of Object.keys(META_COLUMNS)) {
  if (!(key in f)) continue;
  const raw = f[key];
  if (raw === "" ) {
    values[key] = null;
    continue;
  }
  if (BOOL.has(key)) {
    const v = String(raw).toLowerCase();
    values[key] = v === "1" || v === "true" || v === "yes" ? 1 : 0;
  } else if (NUM.has(key)) {
    const n = Number(raw);
    if (Number.isNaN(n)) {
      console.error(`--${key} must be a number, got "${raw}"`);
      process.exit(1);
    }
    values[key] = n;
  } else if (key === "lawn-type") {
    const v = String(raw).toLowerCase();
    if (v !== "real" && v !== "fake") {
      console.error(`--lawn-type must be real|fake, got "${raw}"`);
      process.exit(1);
    }
    values[key] = v;
  }
}

if (Object.keys(values).length === 0) {
  console.error("No metadata flags given — nothing to set.");
  process.exit(1);
}

try {
  setPropertyMetadata(property, values);
  console.log(JSON.stringify({ ok: true, property, set: values }));
} catch (e) {
  console.error(e instanceof Error ? e.message : String(e));
  process.exit(1);
}
