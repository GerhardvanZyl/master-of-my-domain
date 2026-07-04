import { eq } from "drizzle-orm";
import { db } from "@/db/client";
import { scrapeJobs } from "@/db/schema";
import { newId } from "@/lib/id";
import { SCRAPE_CONCURRENCY } from "@/lib/env";
import { runScrape } from "./runScrape";

interface QueueState {
  pending: string[]; // job ids
  active: number;
}

const g = globalThis as unknown as { __scrapeQueue?: QueueState };
const state: QueueState = (g.__scrapeQueue ??= { pending: [], active: 0 });

function setJob(
  id: string,
  fields: Partial<{
    status: string;
    propertyId: string | null;
    error: string | null;
  }>,
) {
  db.update(scrapeJobs)
    .set({ ...fields, updatedAt: new Date().toISOString() })
    .where(eq(scrapeJobs.id, id))
    .run();
}

async function processJob(jobId: string) {
  const job = db
    .select()
    .from(scrapeJobs)
    .where(eq(scrapeJobs.id, jobId))
    .get();
  if (!job) return;
  setJob(jobId, { status: "running" });
  try {
    const out = await runScrape(job.url);
    setJob(jobId, {
      status: out.ok ? "done" : "error",
      propertyId: out.propertyId ?? null,
      error: out.ok ? null : out.error ?? "unknown error",
    });
  } catch (e) {
    setJob(jobId, {
      status: "error",
      error: e instanceof Error ? e.message : String(e),
    });
  }
}

function pump() {
  while (state.active < SCRAPE_CONCURRENCY && state.pending.length > 0) {
    const jobId = state.pending.shift()!;
    state.active++;
    void processJob(jobId).finally(() => {
      state.active--;
      pump();
    });
  }
}

/** Create a queued scrape job and start processing. Returns the job id. */
export function enqueueScrape(url: string): string {
  const id = newId("job");
  const now = new Date().toISOString();
  db.insert(scrapeJobs)
    .values({ id, url, status: "queued", createdAt: now, updatedAt: now })
    .run();
  state.pending.push(id);
  pump();
  return id;
}
