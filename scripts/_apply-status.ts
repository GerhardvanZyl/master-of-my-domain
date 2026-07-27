import "../src/lib/load-env";
import { randomUUID } from "node:crypto";
import { sqlite } from "../src/db/client";

// Sold/withdrawn classification gathered from each listing's own page
// (listingModel.price = "SOLD - $X" / "SOLD - Price Withheld", or a redirect to
// /property-profile/ with no sale = withdrawn). external_id -> outcome.
const CLASS: { ext: string; status: "sold" | "withdrawn"; salePrice: number | null }[] = [
  { ext: "2020674660", status: "sold", salePrice: 950000 }, // 16 Grasso
  { ext: "2020758181", status: "sold", salePrice: null },   // 17 Nassau (withheld)
  { ext: "2020861680", status: "sold", salePrice: 772000 }, // 3 Freshet
  { ext: "2020478632", status: "sold", salePrice: 860000 }, // 33 Seafarer
  { ext: "2020913606", status: "withdrawn", salePrice: null }, // 4 Dalkeith
  { ext: "2020955625", status: "sold", salePrice: 645000 }, // 47 Parkwood
  { ext: "2020906159", status: "sold", salePrice: 927000 }, // 5 Grandpark
  { ext: "2020423922", status: "withdrawn", salePrice: null }, // 69 Fongeo
  { ext: "2020768002", status: "sold", salePrice: null },   // 85 Astoria (withheld)
  { ext: "2020915386", status: "sold", salePrice: null },   // 29 Sumner ("SOLD By ASH")
];

const today = new Date().toISOString().slice(0, 10);
const now = new Date().toISOString();

const getProp = sqlite.prepare(
  "SELECT id, listing_url u FROM properties WHERE external_id = ?",
);
// Drop any prior status rows for this url so re-runs stay idempotent.
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

const report: any[] = [];
for (const c of CLASS) {
  const p = getProp.get(c.ext) as { id: string; u: string } | undefined;
  if (!p) { report.push({ ext: c.ext, error: "not found" }); continue; }
  clearJobs.run(p.u);
  insJob.run(randomUUID(), p.u, c.status, p.id, now, now);
  let priceRow = false;
  if (c.status === "sold" && c.salePrice != null) {
    if (!priceExists.get(p.id, c.salePrice)) {
      insPrice.run(
        randomUUID(), p.id, today, "Sold",
        "Sold - $" + c.salePrice.toLocaleString("en-AU"), c.salePrice, now,
      );
      priceRow = true;
    }
  }
  report.push({ ext: c.ext, status: c.status, salePrice: c.salePrice, priceRow });
}
console.log(JSON.stringify({ applied: report.length, report }, null, 1));
