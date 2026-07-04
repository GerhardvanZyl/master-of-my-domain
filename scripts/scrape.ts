import "../src/lib/load-env";
import { migrate } from "../src/db/migrate";
import { runScrape } from "../src/scrape/runScrape";
import { closeBrowser } from "../src/scrape/browser";

async function main() {
  const urls = process.argv.slice(2).filter((a) => /^https?:\/\//.test(a));
  if (urls.length === 0) {
    console.error("Usage: npm run scrape -- <listing-url> [<listing-url> ...]");
    process.exit(1);
  }
  migrate(); // ensure schema exists

  for (const url of urls) {
    process.stdout.write(`\n▶ ${url}\n`);
    const out = await runScrape(url);
    if (out.ok) {
      console.log(
        `  ✓ ${out.status}  property=${out.propertyId}  ` +
          `images: +${out.images?.added ?? 0} kept ${out.images?.kept ?? 0} ` +
          `dup ${out.images?.skippedDup ?? 0} failed ${out.images?.failed ?? 0}`,
      );
    } else {
      console.log(`  ✗ error: ${out.error}`);
    }
  }
  await closeBrowser();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
