import { desc } from "drizzle-orm";
import { db } from "../client";
import { scrapeJobs } from "../schema";
import type { ScrapeJob } from "../schema";

/** Every URL ever submitted, newest first. This IS the search history. */
export function listSearchHistory(limit = 50): ScrapeJob[] {
  // ponytail: capped at 50; add pagination when the log actually gets long.
  return db
    .select()
    .from(scrapeJobs)
    .orderBy(desc(scrapeJobs.createdAt))
    .limit(limit)
    .all();
}
