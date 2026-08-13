import "../src/lib/load-env";
import { recordPriceObservations } from "../src/db/queries/status";

/**
 * Append-only price observations — OUR OWN record of each listing's price over
 * time, independent of Domain's supplied timeline. Run after every update/sync
 * (see the processing-round memory). Idempotent — re-running the same day adds
 * nothing.
 *
 * The logic lives in src/db/queries/status.ts so that POST /api/batch
 * { priceObserve: true } against the live app does exactly the same thing.
 *
 * Run: npx tsx scripts/record-price-obs.ts   (or: npm run price:observe)
 */
console.log(JSON.stringify(recordPriceObservations()));
