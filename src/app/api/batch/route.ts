import { NextResponse } from "next/server";
import { eq, isNotNull } from "drizzle-orm";
import { db } from "@/db/client";
import { properties } from "@/db/schema";
import { syncImages } from "@/scrape/images";
import { loadProperties, type LoadItem } from "@/db/queries/load";
import {
  setImageTag,
  setImageTagIfAbsent,
  ensureGroup,
  addGroupMember,
  isRoomType,
  tagStatus,
  listUntaggedImages,
} from "@/db/queries/tags";
import { markSold, markWithdrawn, recordPriceObservations } from "@/db/queries/status";

export const runtime = "nodejs";

/**
 * POST /api/batch — the whole property-update write path over HTTP.
 *
 * The update job runs on a workstation but the live app lives on another host
 * (192.168.68.125:3225), and every other write path here is a local CLI against
 * data/app.db. Without this, updating the live instance means shipping a 10MB
 * SQLite file and its images through git. Each section mirrors exactly one CLI,
 * so a remote run leaves the same rows as a local one:
 *
 *   properties    -> npm run load          (upsert by listing_url, partial)
 *   images        -> npm run load:images   (server downloads; SLOW — chunk it)
 *   tags          -> npm run tag:set       (notes carries hero/floorplan/master)
 *   groups        -> group:ensure + group:add
 *   sold          -> npm run mark-sold
 *   withdrawn     -> scrape_jobs status='withdrawn'
 *   priceObserve  -> npm run price:observe
 *
 * Every section is optional and every section is idempotent, so a failed run is
 * simply re-sent. Sections apply in the order above: properties must exist
 * before their images, images before their tags, tags before groups reference
 * them. Per-section errors are collected rather than thrown, so one bad row
 * can't discard the other 300 — check `errors` in the response, it is not a 4xx.
 *
 * ponytail: no auth. This is a single-user LAN app whose /api/ingest already
 * accepts unauthenticated writes; a token here would be a lock on one of two
 * doors. Add one when the app leaves the LAN, not before.
 */

interface TagInput {
  imageId: string;
  roomType?: string;
  confidence?: number | null;
  notes?: string | null;
  taggedBy?: string;
  /** Only tag if untagged — never clobber a hand correction. */
  ifAbsent?: boolean;
}

interface BatchBody {
  properties?: LoadItem[];
  images?: { listingUrl: string; imageUrls: string[] }[];
  tags?: TagInput[];
  groups?: { label: string; roomType?: string | null; imageIds?: string[] }[];
  sold?: { listingUrl?: string; externalId?: string; price?: number | null; date?: string }[];
  withdrawn?: { listingUrl?: string; externalId?: string }[];
  priceObserve?: boolean;
}

export async function POST(req: Request) {
  const body = (await req.json().catch(() => null)) as BatchBody | null;
  if (!body || typeof body !== "object") {
    return NextResponse.json({ ok: false, error: "invalid JSON body" }, { status: 400 });
  }

  const result: Record<string, unknown> = {};
  const errors: { section: string; ref: string; error: string }[] = [];
  const fail = (section: string, ref: string, e: unknown) =>
    errors.push({ section, ref, error: e instanceof Error ? e.message : String(e) });

  if (body.properties?.length) {
    result.properties = loadProperties(body.properties);
  }

  if (body.images?.length) {
    let downloaded = 0,
      failed = 0;
    const perListing: { listingUrl: string; added: number; failed: number }[] = [];
    for (const it of body.images) {
      try {
        const prop = db
          .select({ id: properties.id })
          .from(properties)
          .where(eq(properties.listingUrl, it.listingUrl))
          .get();
        if (!prop) throw new Error("no property for listingUrl");
        // Same normalization load-images.ts does: ordinal is the array position.
        const norm = (it.imageUrls ?? []).map((sourceUrl, ordinal) => ({ sourceUrl, ordinal }));
        const res = await syncImages(prop.id, norm, it.listingUrl);
        downloaded += res.added;
        failed += res.failed;
        perListing.push({ listingUrl: it.listingUrl, added: res.added, failed: res.failed });
      } catch (e) {
        fail("images", it.listingUrl, e);
      }
    }
    result.images = { listings: body.images.length, downloaded, failed, perListing };
  }

  if (body.tags?.length) {
    let written = 0,
      skipped = 0;
    for (const t of body.tags) {
      try {
        if (!t.roomType || !isRoomType(t.roomType)) throw new Error(`bad roomType "${t.roomType}"`);
        const input = {
          imageId: t.imageId,
          roomType: t.roomType,
          confidence: t.confidence ?? null,
          notes: t.notes ?? null,
          taggedBy: t.taggedBy ?? "claude-code",
        };
        if (t.ifAbsent) {
          if (setImageTagIfAbsent(input)) written++;
          else skipped++;
        } else {
          setImageTag(input);
          written++;
        }
      } catch (e) {
        fail("tags", t.imageId, e);
      }
    }
    result.tags = { written, skipped };
  }

  if (body.groups?.length) {
    const groups: { label: string; groupId: string; created: boolean; added: number }[] = [];
    for (const g of body.groups) {
      try {
        const { groupId, created } = ensureGroup({ label: g.label, roomType: g.roomType ?? null });
        let added = 0;
        for (const imageId of g.imageIds ?? []) {
          try {
            addGroupMember(groupId, imageId);
            added++;
          } catch (e) {
            fail("groups", `${g.label}:${imageId}`, e);
          }
        }
        groups.push({ label: g.label, groupId, created, added });
      } catch (e) {
        fail("groups", g.label, e);
      }
    }
    result.groups = groups;
  }

  if (body.sold?.length) {
    let marked = 0;
    for (const s of body.sold) {
      try {
        markSold(s);
        marked++;
      } catch (e) {
        fail("sold", s.listingUrl ?? s.externalId ?? "?", e);
      }
    }
    result.sold = { marked };
  }

  if (body.withdrawn?.length) {
    let marked = 0;
    for (const w of body.withdrawn) {
      try {
        markWithdrawn(w);
        marked++;
      } catch (e) {
        fail("withdrawn", w.listingUrl ?? w.externalId ?? "?", e);
      }
    }
    result.withdrawn = { marked };
  }

  if (body.priceObserve) {
    result.priceObserve = recordPriceObservations();
  }

  return NextResponse.json({ ok: errors.length === 0, ...result, errors });
}

/** GET /api/batch — coverage summary, so a remote run can verify what it wrote. */
export async function GET() {
  const counts = db.select({ id: properties.id }).from(properties).all().length;
  // Coverage for the property.com.au enrichment — both are 0/null for every
  // row until a future sync round populates them; useful to confirm a batch
  // that sent these fields actually landed.
  const propertyComAuUrl = db
    .select({ id: properties.id })
    .from(properties)
    .where(isNotNull(properties.propertyComAuUrl))
    .all().length;
  const yearBuilt = db
    .select({ id: properties.id })
    .from(properties)
    .where(isNotNull(properties.yearBuilt))
    .all().length;

  // No route under /api enumerates raw image rows, which makes the `untagged`
  // count below undiscoverable — there's no way to go from "19 untagged" to
  // which 19. listUntaggedImages fills that gap. absPath is stripped: it
  // resolves against the container's DATA_DIR and leaks that path to a
  // caller for no benefit (it's only useful to the local Read tool).
  const untaggedImages = listUntaggedImages().map(({ absPath: _absPath, ...rest }) => rest);

  return NextResponse.json({
    ok: true,
    properties: counts,
    propertyComAuUrl,
    yearBuilt,
    ...tagStatus(),
    // `tagStatus().untagged` above counts by room_type IS NULL, which also
    // matches an image_tags row that exists but has a null room_type (e.g.
    // the hero-only insert at scripts/hero-set.ts:42). listUntaggedImages
    // filters on "no image_tags row at all", so this list can be SHORTER
    // than `untagged` — `note` makes that gap visible instead of letting a
    // caller assume this is the full set.
    untaggedImages: {
      images: untaggedImages,
      note:
        "May be shorter than `untagged` above: `untagged` also counts image_tags rows with a null room_type " +
        "(e.g. a hero-only row), which carry no entry here because they aren't tagless.",
    },
  });
}
