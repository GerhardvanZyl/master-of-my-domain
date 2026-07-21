import { NextResponse } from "next/server";
import { updatePropertyMetadata } from "@/db/queries/metadata";

// PATCH /api/properties/<id>/metadata
// Correctable deduced metadata (task 10). Body is a partial of:
//   hasEaves|pergolaCovered|hasLawn|floodOverlay|bushfireOverlay : 0|1|null
//   masterBedSqm|avgOtherBedSqm|commonAreasCount|balconySqm|backGardenSqm|altitudeM : number|null
//   lawnType : "real"|"fake"|null
// Only fields present in the body change; "" or null clears to NULL.
const BOOL = new Set([
  "hasEaves",
  "pergolaCovered",
  "hasLawn",
  "floodOverlay",
  "bushfireOverlay",
]);
const NUM = new Set([
  "masterBedSqm",
  "avgOtherBedSqm",
  "commonAreasCount",
  "balconySqm",
  "backGardenSqm",
  "altitudeM",
]);

function coerce(key: string, v: unknown): number | string | null | undefined {
  if (v === undefined) return undefined; // not provided
  if (v === "" || v === null) return null; // clear
  if (BOOL.has(key)) return v === 1 || v === "1" || v === true ? 1 : 0;
  if (NUM.has(key)) {
    const n = Number(v);
    return Number.isNaN(n) ? undefined : n;
  }
  if (key === "lawnType") return v === "real" || v === "fake" ? v : undefined;
  return undefined;
}

export async function PATCH(
  req: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;
  let body: Record<string, unknown>;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "invalid JSON body" }, { status: 400 });
  }

  const values: Record<string, number | string | null> = {};
  for (const [k, raw] of Object.entries(body)) {
    const c = coerce(k, raw);
    if (c !== undefined) values[k] = c;
  }
  if (Object.keys(values).length === 0) {
    return NextResponse.json({ error: "no valid fields" }, { status: 400 });
  }

  try {
    updatePropertyMetadata(id, values);
  } catch (e) {
    return NextResponse.json(
      { error: e instanceof Error ? e.message : String(e) },
      { status: 404 },
    );
  }
  return NextResponse.json({ ok: true, id, set: values });
}
