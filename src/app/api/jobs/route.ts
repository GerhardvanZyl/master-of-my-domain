import { NextResponse } from "next/server";
import { desc } from "drizzle-orm";
import { db } from "@/db/client";
import { scrapeJobs } from "@/db/schema";

export const runtime = "nodejs";

export async function GET() {
  const jobs = db
    .select()
    .from(scrapeJobs)
    .orderBy(desc(scrapeJobs.updatedAt))
    .limit(50)
    .all();
  const active = jobs.some(
    (j) => j.status === "queued" || j.status === "running",
  );
  return NextResponse.json({ jobs, active });
}
