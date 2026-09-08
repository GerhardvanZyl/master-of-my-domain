// Diff an REA search harvest against the LIVE app's baseline snapshot.
//
//   npx tsx scripts/_rea-diff.ts [data/harvest/rea-search.json]
//
// Emits, into data/harvest/:
//   _rea-new.json        rows whose address we do not already hold  -> listing pass
//   _rea-price.json      rows we hold whose price has moved         -> priceObserve
//   _rea-sold.json       rows the sold search says are settled      -> sold section
//   _rea-unparsed.json   rows whose card text would not parse       -> eyeball these
//
// The overlap matcher uses addressKey() from src/scrape/persist.ts — the same
// function upsertProperty consults — so the prediction cannot drift from what
// ingest actually does. /api/batch has no DELETE, so a duplicate is permanent.
//
// Two guards the address key alone does not give:
//  - DELISTED rows still occupy their address. Without them in the key set, the
//    house-and-land packages dropped in an earlier round come back as "new".
//  - A listing REA re-renders under a different address ("2/57-59 Cowrie Road"
//    -> "59 Cowrie Road") keys differently and reads as new; the external_id
//    check catches it.
//
// On the card text: it is textContent, so the fields run together with no
// separators — "…$1,100,0001 Frankie Way, Point Cook422684m²•House". That is
// why the price pattern insists on comma-grouped thousands: an unanchored
// \$[\d,]+ swallows the leading digit of the street number.
import fs from "node:fs";
import { __addressKeyForTest as addressKey } from "../src/scrape/persist";

type Card = { url: string; id: string; labels: string[]; text: string; sub: string };

const H = JSON.parse(fs.readFileSync(process.argv[2] ?? "data/harvest/rea-search.json", "utf8")) as {
  rows: Card[];
  sold: Card[];
};
const SNAP = (JSON.parse(fs.readFileSync("data/harvest/_snapshot.json", "utf8")).rows as any[]).filter((r) =>
  /^https?:/.test(r.listing_url ?? ""),
);

const haveIds = new Set(SNAP.map((r) => String(r.external_id)).filter(Boolean));
const byKey = new Map<string, any>();
for (const r of SNAP) {
  const k = addressKey({ address: r.address, suburb: r.suburb });
  // Prefer a live row over a delisted one at the same address, but keep the
  // delisted one when it is all we have — it still occupies that address.
  if (k && (!byKey.has(k) || (byKey.get(k).delisted && !r.delisted))) byKey.set(k, r);
}

const SUB: Record<string, string> = {
  "point+cook": "Point Cook",
  "williams+landing": "Williams Landing",
  seabrook: "Seabrook",
  torquay: "Torquay",
};
const suburbOf = (url: string) => SUB[(url.match(/-vic-([^-]+)-\d+$/) || [])[1]] ?? null;

// Comma-grouped thousands only — see the header note about run-together text.
const PRICE = /\$\s?\d{1,3}(?:,\d{3})+/g;
const numOf = (p: string | null) => (p ? Number((p.match(/[\d,]+/) || ["0"])[0].replace(/,/g, "")) : null);

/** Price display + where it ends, taken from the run of $ figures before the address. */
function priceRun(text: string, upto: number) {
  const ms = [...text.matchAll(PRICE)].filter((m) => m.index! < upto);
  if (!ms.length) return null;
  const first = ms[0];
  let last = first;
  for (const m of ms.slice(1)) {
    // Same run only: a second figure more than ~6 chars past the previous one
    // belongs to something else (a repayment blurb, an agent's tagline).
    if (m.index! - (last.index! + last[0].length) > 6) break;
    last = m;
  }
  const end = last.index! + last[0].length;
  return { display: text.slice(first.index!, end).replace(/\s+/g, " ").trim(), end };
}

// The street address is the run ending at ", <Suburb>". Two shapes have to be
// handled and neither covers the other:
//  - "…$1,100,0001 Frankie Way, Point Cook" — the price and the street number
//    run together, so only the end of the price run says where the number
//    starts. A pattern alone would read "0001 Frankie Way".
//  - "…$800,000 - $850,000 | Exceptional Family Living44 Kittyhawk Road, …" and
//    the auction listings, which put "Indicative price:" AFTER the address and
//    so have no price run in front of it at all.
// \d{1,5}, not \d+: at index 0 the lookbehind is vacuously satisfied, so an
// unbounded run happily reads an agent's mobile number as the street number
// ("045236880610 Fairwater Drive").
const STREET = /(?<![\d,])(\d{1,5}[A-Za-z]?(?:[/-]\d{1,5}[A-Za-z]?)?\s+[A-Za-z][A-Za-z' ]*)$/;
function streetOf(rawHead: string, priceEnd: number | null) {
  const head = rawHead.replace(/[\s,.]+$/, "");
  if (priceEnd != null) {
    const tail = head
      .slice(priceEnd)
      // A second price figure can sit between the run we matched and the address
      // ("$990,000 – 1,089,00011 Ashwell Ave" — en-dash, no second $).
      .replace(/^[\s\-–—|.]*\$?\d{1,3}(?:,\d{3})+/, "")
      // …and so can an agent's mobile.
      .replace(/^0[45]\d{8}/, "");
    // A street number is at most a few digits — more means an agent's phone
    // number ran into the address ("…0452368806" + "10 Fairwater Drive").
    if (/^\d{1,5}\D/.test(tail)) return tail.trim();
    const m = tail.match(STREET);
    if (m) return m[1].trim();
  }
  return head.match(STREET)?.[1].trim() ?? null;
}

function numsFromLabels(labels: string[]) {
  const c = labels.find((l) => /bedrooms?/i.test(l) && /bathrooms?/i.test(l));
  if (!c) return {};
  const g = (re: RegExp) => {
    const m = c.match(re);
    return m ? Number(m[1].replace(/,/g, "")) : null;
  };
  return {
    beds: g(/([\d.]+)\s*bedrooms?/i),
    baths: g(/([\d.]+)\s*bathrooms?/i),
    parking: g(/([\d.]+)\s*car\s*spaces?/i),
    landSizeSqm: g(/([\d,.]+)\s*m²\s*land/i),
  };
}

// House-and-land / off-the-plan / bare land never enters the DB — the round has
// to drop them EVERY time, or they come back as new on the next harvest.
// `\b` is no help here: the text runs together, so "…$797,190Lot 521" has no
// word boundary before "Lot" at all — 0 and L are both word characters.
const isHnl = (t: string, url: string) =>
  /off the plan|house and land|turnkey|turn key|fixed price|land only|display home/i.test(t) ||
  /•\s*(?:Residential land|Vacant land|Farmlet|Development site)/i.test(t) ||
  /(?:^|[^A-Za-z])LOT[- ]?\d/i.test(t) ||
  /(?:^|[^A-Za-z])From \$/.test(t) ||
  /\d\s+[A-Za-z' ]*Estate,/.test(t) ||
  /property-(?:new-)?land-|-development-/.test(url);

const out = { new: [] as any[], price: [] as any[], unparsed: [] as any[], hnl: 0 };

for (const r of H.rows) {
  const suburb = suburbOf(r.url);
  const at = suburb ? r.text.indexOf(", " + suburb) : -1;
  const pr = at > 0 ? priceRun(r.text, at) : null;
  // Auction listings carry "Indicative price: $X - $Y" after the address.
  const ind = at > 0 ? r.text.slice(at).match(/Indicative price:\s*(\$[\d,]+(?:\s*-\s*\$[\d,]+)?)/i) : null;
  const street = at > 0 ? streetOf(r.text.slice(0, at), pr?.end ?? null) : null;
  const address = street ? `${street}, ${suburb}` : null;
  const priceDisplay = pr?.display ?? ind?.[1].replace(/\s+/g, " ") ?? null;
  const rec = {
    url: r.url,
    id: r.id,
    address,
    suburb,
    priceDisplay,
    priceNumeric: numOf(priceDisplay),
    ...numsFromLabels(r.labels),
    text: r.text,
  };
  if (isHnl(r.text, r.url)) {
    out.hnl++;
    continue;
  }
  // A price is optional for the new/held decision — a "Contact agent" listing is
  // still a listing, and the listing page carries its own price text anyway.
  // The address is not optional: without it there is nothing to match on.
  if (!address) {
    out.unparsed.push(rec);
    continue;
  }
  const key = addressKey({ address, suburb });
  const held = key ? byKey.get(key) : null;
  const byId = held ?? SNAP.find((s) => String(s.external_id) === String(r.id));
  if (byId) {
    if (rec.priceNumeric && byId.price_numeric !== rec.priceNumeric) {
      out.price.push({
        id: byId.id,
        // The HELD row's URL, not the REA one: loadProperties upserts by
        // listing_url, so pushing the REA link at a row we hold from Domain
        // would repoint it at REA as a side effect of a price update.
        listingUrl: byId.listing_url,
        address: byId.address,
        was: byId.price_display,
        wasNumeric: byId.price_numeric,
        priceDisplay: rec.priceDisplay,
        priceNumeric: rec.priceNumeric,
        url: r.url,
      });
    }
  } else if (!haveIds.has(String(r.id))) {
    out.new.push(rec);
  }
}

// Sold: "…Sold$910,00031 Kerford Crescent, Point Cook422•HouseSold on 04 Sep 2026"
// REA's sold card carries the real settlement date, so this beats recording the
// day we happened to notice.
const soldOut: any[] = [];
const soldSeen = new Set<string>();
for (const r of H.sold) {
  const suburb = suburbOf(r.url);
  const at = suburb ? r.text.indexOf(", " + suburb) : -1;
  const d = r.text.match(/Sold on (\d{1,2} \w{3} \d{4})/i);
  const pr = at > 0 ? priceRun(r.text, at) : null;
  if (!d || !pr) continue;
  const street = streetOf(r.text.slice(0, at), pr.end);
  const key = street ? addressKey({ address: `${street}, ${suburb}`, suburb }) : null;
  const held = key ? byKey.get(key) : null;
  if (!held || held.sale_status === "sold" || soldSeen.has(held.id)) continue;
  soldSeen.add(held.id);
  soldOut.push({
    id: held.id,
    listingUrl: held.listing_url,
    externalId: held.external_id,
    address: held.address,
    wasDelisted: !!held.delisted,
    soldDate: new Date(`${d[1]} 12:00:00 GMT+1000`).toISOString().slice(0, 10),
    priceDisplay: `SOLD - ${pr.display}`,
    priceNumeric: numOf(pr.display),
    url: r.url,
  });
}

// The listing pass covers the unparsed rows too. Their card text would not give
// up an address, but the listing page's JSON-LD will, and the properties section
// of /api/batch resolves an address twin server-side (load.ts:106,
// findTwinByAddress) — so a row that turns out to be one we already hold merges
// onto it rather than duplicating. Only a row whose REA id we already carry can
// be ruled out from here.
const pass = [...out.new, ...out.unparsed.filter((r) => !haveIds.has(String(r.id)))];

const w = (n: string, v: unknown[]) => {
  fs.writeFileSync(`data/harvest/${n}.json`, JSON.stringify(v, null, 1));
  return v.length;
};
console.log({
  harvested: H.rows.length,
  soldCards: H.sold.length,
  new: w("_rea-new", out.new),
  priceChanges: w("_rea-price", out.price),
  sold: w("_rea-sold", soldOut),
  unparsed: w("_rea-unparsed", out.unparsed),
  toPass: w("_rea-pass", pass),
  houseAndLand: out.hnl,
});
