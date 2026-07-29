import "../src/lib/load-env";
import { randomUUID } from "node:crypto";
import { sqlite } from "../src/db/client";

/**
 * 2026-07-28 Domain run. Two sources:
 *  - gone from the search feed → own listing page checked
 *    ("SOLD - $X" in listingModel.price, or a /property-profile/ redirect with
 *    no listingModel = withdrawn);
 *  - still in the feed but the agent's price text reads "Sold" — those are sold
 *    even though Domain keeps them in results under the "Under offer" tag.
 * Plain "Under contract"/"Under offer" is NOT treated as sold: not settled, and
 * the UI already surfaces it from price_display.
 */
const CLASS: { ext: string; status: "sold" | "withdrawn"; salePrice: number | null }[] = [
  { ext: "2020888517", status: "sold", salePrice: 685000 },      // 18 Jemma Ave — "SOLD - $685,000"
  { ext: "2020654589", status: "withdrawn", salePrice: null },   // 280 Boardwalk Blvd — profile redirect
  { ext: "2020693569", status: "withdrawn", salePrice: null },   // 9 Tamworth Grove — profile redirect
  { ext: "2020927495", status: "sold", salePrice: null },        // 9 Faro St — "SOLD by SHAHEEL!"
  { ext: "2020808002", status: "sold", salePrice: 1030000 },     // 47 Middle Park Dr — "Sold ... $1,030,000"
  { ext: "2019501372", status: "sold", salePrice: null },        // 47 Yacht Rd — "Sold"
  { ext: "2018338643", status: "sold", salePrice: null },        // 62 Harlem Cct — "SOLD by BOBBY LAKRA..."
  { ext: "2020915386", status: "sold", salePrice: null },        // 29 Sumner Cr — still "SOLD By ASH"
];

const today = new Date().toISOString().slice(0, 10);
const now = new Date().toISOString();

const getProp = sqlite.prepare("SELECT id, listing_url u FROM properties WHERE external_id = ?");
const clearJobs = sqlite.prepare(
  "DELETE FROM scrape_jobs WHERE url = ? AND status IN ('delisted','sold','withdrawn')",
);
const insJob = sqlite.prepare(
  "INSERT INTO scrape_jobs (id, url, status, property_id, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)",
);
const priceExists = sqlite.prepare(
  "SELECT 1 FROM price_history WHERE property_id = ? AND event = 'Sold' AND price_numeric = ?",
);
const insPrice = sqlite.prepare(
  "INSERT INTO price_history (id, property_id, date, event, price_display, price_numeric, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
);

const report: unknown[] = [];
for (const c of CLASS) {
  const p = getProp.get(c.ext) as { id: string; u: string } | undefined;
  if (!p) {
    report.push({ ext: c.ext, error: "not found" });
    continue;
  }
  clearJobs.run(p.u);
  insJob.run(randomUUID(), p.u, c.status, p.id, now, now);
  let priceRow = false;
  if (c.status === "sold" && c.salePrice != null && !priceExists.get(p.id, c.salePrice)) {
    insPrice.run(
      randomUUID(), p.id, today, "Sold",
      "Sold - $" + c.salePrice.toLocaleString("en-AU"), c.salePrice, now,
    );
    priceRow = true;
  }
  report.push({ ext: c.ext, status: c.status, salePrice: c.salePrice, priceRow });
}
console.log(JSON.stringify({ applied: report.length, report }, null, 1));
