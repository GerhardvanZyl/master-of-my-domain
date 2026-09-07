import "../src/lib/load-env";
import fs from "node:fs";
import { setDomainShortlist } from "../src/db/queries/shortlist";
import { parseFlags } from "../src/lib/args";

/**
 * Sanctioned write path for the domain.com.au shortlist mirror. Calls the
 * same setDomainShortlist as POST /api/batch { shortlist }, so a local run and
 * a remote batch push against the live app leave the same rows (see
 * db/queries/status.ts's doc comment for why this pairing exists elsewhere).
 *
 * Full replace: sets domain_shortlisted=1 for the given URLs and 0 for every
 * other Domain-sourced property — send the whole shortlist as it stands on
 * Domain right now, not just what changed.
 *
 * Run: npm run shortlist:set -- <url1> <url2> ...
 *   or: npm run shortlist:set -- --file=<path.json>   (JSON array of URLs)
 */
const args = process.argv.slice(2);
const flags = parseFlags(args);
// --file's value is never a positional URL, so keeping it out of parseFlags's
// scope is fine here: the variadic URL list is everything ELSE on argv,
// which parseFlags doesn't (and isn't meant to) cover.
const fileArg = typeof flags.file === "string" ? flags.file : undefined;
const positional = args.filter((a) => !a.startsWith("--"));

const fromFile: string[] = fileArg ? JSON.parse(fs.readFileSync(fileArg, "utf8")) : [];
const urls = [...positional, ...fromFile];

if (urls.length === 0) {
  console.error(
    "Usage: npm run shortlist:set -- <url1> <url2> ...\n" +
      "   or: npm run shortlist:set -- --file=<path.json>   (JSON array of URLs)",
  );
  process.exit(1);
}

try {
  console.log(JSON.stringify(setDomainShortlist(urls)));
} catch (e) {
  console.error(e instanceof Error ? e.message : String(e));
  process.exit(1);
}
