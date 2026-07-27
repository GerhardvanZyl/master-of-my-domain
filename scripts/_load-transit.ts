import "../src/lib/load-env";
import { sqlite } from "../src/db/client";
import { loadProperties, type LoadItem } from "../src/db/queries/load";
// Exact Google Maps transit (depart Mon 07:30, epoch 1785742200) for the 11 new listings.
const R: Record<string, { min: number; route: string }> = {
  "2020910894": { min: 58, route: "Bus 494 + Werribee train" },
  "2021014749": { min: 52, route: "Bus 153 + Werribee train" },
  "2021016249": { min: 83, route: "Bus 495 + Werribee train" },
  "2021017542": { min: 64, route: "Bus 494 + Werribee train" },
  "2021017752": { min: 76, route: "Bus 498 + Werribee train" },
  "2021019617": { min: 80, route: "Bus 497 + Werribee train" },
  "2021019698": { min: 76, route: "Bus 495 + Werribee train" },
  "2021020062": { min: 73, route: "Bus 495 + Werribee train" },
  "2021022838": { min: 52, route: "Bus 495 + Werribee train" },
  "2021022852": { min: 58, route: "Bus 152 + Werribee train" },
  "2021025994": { min: 70, route: "Bus 495 + Werribee train" },
};
const getUrl = sqlite.prepare("SELECT listing_url u, address FROM properties WHERE external_id=?");
const items: LoadItem[] = [];
for (const [ext, v] of Object.entries(R)) {
  const row = getUrl.get(ext) as any;
  if (!row) { console.log("MISSING", ext); continue; }
  items.push({
    listingUrl: row.u,
    ptMinutesToFlinders: v.min,
    ptRouteSummary: v.route,
    // NOT prefixed "Estimated" -> UI drops the * estimated marker.
    ptSteps: `Depart ~7:30am (Mon) from ${row.address.split(",")[0]}: ${v.route} → Flinders St, ~${v.min} min.`,
  });
}
const res = loadProperties(items);
console.log(JSON.stringify({ loaded: items.length, res }));
