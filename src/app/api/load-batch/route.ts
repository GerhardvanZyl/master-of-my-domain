import { NextResponse } from "next/server";
import { loadProperties, type LoadItem } from "@/db/queries/load";

export const runtime = "nodejs";

// Allow the Domain tab (a public HTTPS origin) to POST here on localhost.
// Chrome's Private Network Access needs the PNA header on the preflight.
const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type",
  "Access-Control-Allow-Private-Network": "true",
};

export function OPTIONS() {
  return new Response(null, { status: 204, headers: CORS });
}

/**
 * Bulk-load browser-gathered listings (with train/PT/price-history enrichment)
 * straight into the DB. Body: a JSON array of LoadItem. Local single-user use —
 * the transport for the Domain harvest done via the Chrome extension/automation.
 */
export async function POST(req: Request) {
  const body = (await req.json().catch(() => null)) as LoadItem[] | null;
  if (!Array.isArray(body)) {
    return NextResponse.json(
      { ok: false, error: "expected a JSON array of listings" },
      { status: 400, headers: CORS },
    );
  }
  const result = loadProperties(body);
  return NextResponse.json({ ok: true, ...result }, { headers: CORS });
}
