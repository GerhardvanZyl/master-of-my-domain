import { NextResponse } from "next/server";
import { enqueueScrape } from "@/scrape/queue";
import { pickAdapter } from "@/scrape/adapters";

export const runtime = "nodejs";

/** Extract http(s) URLs from a pasted blob or an array. */
function parseUrls(input: unknown): string[] {
  let text = "";
  if (typeof input === "string") text = input;
  else if (Array.isArray(input)) text = input.join("\n");
  const matches = text.match(/https?:\/\/[^\s"'<>]+/g) ?? [];
  return [...new Set(matches.map((u) => u.replace(/[.,)]+$/, "")))];
}

export async function POST(req: Request) {
  const body = await req.json().catch(() => ({}));
  const urls = parseUrls(body.urls ?? body.text);
  if (urls.length === 0) {
    return NextResponse.json({ error: "No URLs found" }, { status: 400 });
  }

  const jobs = urls.map((url) => {
    const supported = !!pickAdapter(url);
    const jobId = enqueueScrape(url);
    return { jobId, url, supported };
  });

  return NextResponse.json({ jobs });
}
