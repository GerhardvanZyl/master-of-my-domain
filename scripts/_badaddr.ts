import { sqlite } from "../src/db/client";
const rows = sqlite
  .prepare(
    `SELECT id, address, listing_url AS url FROM properties
      WHERE address IS NULL OR address = '' OR address = 'Domain'
         OR address NOT LIKE '%,%'`,
  )
  .all() as { id: string; address: string | null; url: string }[];
console.log("bad addresses:", rows.length);
console.log(JSON.stringify(rows.slice(0, 8), null, 1));
