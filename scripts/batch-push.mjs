// Push a batch payload to a Property Compare instance over HTTP.
//
// This is how the update job reaches the LIVE app on another host
// (http://192.168.68.125:3225) without shipping data/app.db + data/images
// through git. The payload is exactly the POST /api/batch body — see that
// route for the sections.
//
// Usage:
//   node scripts/batch-push.mjs --base=http://192.168.68.125:3225 --file=data/harvest/batch.json
//   node scripts/batch-push.mjs --base=... --file=... --chunk=5     # images per request
//   node scripts/batch-push.mjs --base=... --status                 # just read the summary
//
// Images are chunked because each one is a server-side download: a 300-photo
// section in one request sits there for minutes and any proxy in between gives
// up. Every section is idempotent, so a chunk that fails is simply re-sent.
import fs from "node:fs";

const flag = (n, d) => {
  const m = process.argv.find((a) => a.startsWith(`--${n}=`));
  return m ? m.slice(n.length + 3) : d;
};
const base = (flag("base") ?? "").replace(/\/$/, "");
if (!base) {
  console.error("usage: node scripts/batch-push.mjs --base=http://host:3225 --file=<payload.json>");
  process.exit(1);
}

const post = async (body) => {
  const r = await fetch(`${base}/api/batch`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  const j = await r.json().catch(() => ({ ok: false, error: `HTTP ${r.status}` }));
  if (!r.ok) throw new Error(`HTTP ${r.status}: ${JSON.stringify(j).slice(0, 300)}`);
  return j;
};

if (process.argv.includes("--status")) {
  const r = await fetch(`${base}/api/batch`);
  console.log(JSON.stringify(await r.json(), null, 1));
  process.exit(0);
}

const file = flag("file");
if (!file) {
  console.error("need --file=<payload.json> (or --status)");
  process.exit(1);
}
const chunkSize = Number(flag("chunk", "5"));
const payload = JSON.parse(fs.readFileSync(file, "utf8"));
const { images, ...rest } = payload;

const allErrors = [];
if (Object.keys(rest).length) {
  const res = await post(rest);
  console.log("main:", JSON.stringify({ ...res, errors: res.errors?.length ?? 0 }));
  allErrors.push(...(res.errors ?? []));
}

for (let i = 0; images?.length && i < images.length; i += chunkSize) {
  const chunk = images.slice(i, i + chunkSize);
  const res = await post({ images: chunk });
  const n = res.images ?? {};
  console.log(
    `images ${i + 1}-${i + chunk.length}/${images.length}: +${n.downloaded ?? 0} photos, ${n.failed ?? 0} failed`,
  );
  allErrors.push(...(res.errors ?? []));
}

if (allErrors.length) {
  console.log(`\n${allErrors.length} error rows:`);
  for (const e of allErrors.slice(0, 20)) console.log(" ", e.section, e.ref, "—", e.error);
  process.exit(1);
}
console.log("\nall sections applied cleanly");
