// Measured (not estimated) transit to Flinders St, for the metro suburbs.
//
//   node scripts/_transit-measure.mjs urls  <props.json>            -> prints one Maps URL per property
//   node scripts/_transit-measure.mjs apply <props.json> <measured.json> <out.json>
//
// There is no API here: Google is driven through the user's own Chrome, one
// navigation per property, and the trip is read out of document.body.innerText.
// Everything below is the hard-won part of that.
//
// THE URL. The `data=` blob is a protobuf-ish token stream and Maps validates
// its own length prefixes, so it cannot be hand-trimmed. This one was obtained
// by letting Maps rewrite a plain `?api=1&travelmode=transit` directions link,
// then inserting the depart-at group:
//
//   base from Maps:  !3m1!4b1!4m9 !4m8 !1m0!1m5!1m1!1s<dest>!2m2!1d<lng>!2d<lat>!3e3!5m1!1e2
//   + depart-at:     ...!2d<lat> !2m3!6e0!7e2!8j<EPOCH> !3e3...
//
// Adding those 4 elements bumps the inner group 8 -> 12 and the outer 9 -> 13.
// Get the counts wrong and Maps silently drops the transit + time tokens and
// answers a driving query instead.
//
// !1s IS NOT A DUMMY. The destination comes from that feature id, not from the
// readable path segment: pointing the path at Flinders while leaving Sydney's
// id in place returns a Melbourne -> Museum Station, Sydney trip.
//
// !8j IS LOCAL WALL-CLOCK ENCODED AS UTC. 07:30 Melbourne is the epoch that
// *decodes* to 07:30Z. Do not convert to true UTC.
//
// Torquay is deliberately excluded: the real commute there is drive to Waurn
// Ponds + V/Line to Southern Cross, which Google does not return by default.
// See _torquay-commute-build.mjs.
import fs from "node:fs";

const DEST_ID = "0x6ad642b6af832249:0xe39e415e49a7c44e"; // Flinders Street
const DEST_TXT = "Flinders+Street,+Flinders+St,+Melbourne+VIC+3000";
const DEST_LNG = "144.9670618";
const DEST_LAT = "-37.8182711";

/** Epoch for the next Monday at 07:30 *as if* that wall-clock were UTC. */
export function nextMonday0730(from = new Date()) {
  const d = new Date(Date.UTC(from.getUTCFullYear(), from.getUTCMonth(), from.getUTCDate()));
  do d.setUTCDate(d.getUTCDate() + 1);
  while (d.getUTCDay() !== 1);
  d.setUTCHours(7, 30, 0, 0);
  return Math.floor(d.getTime() / 1000);
}

const mapsUrl = (lat, lng, ts) =>
  `https://www.google.com/maps/dir/${lat},${lng}/${DEST_TXT}/@-37.8548641,144.6917521,11z/data=` +
  `!3m1!4b1!4m13!4m12!1m0!1m5!1m1!1s${DEST_ID}!2m2!1d${DEST_LNG}!2d${DEST_LAT}` +
  `!2m3!6e0!7e2!8j${ts}!3e3!5m1!1e2`;

const mode = process.argv[2];
const props = JSON.parse(fs.readFileSync(process.argv[3], "utf8"));

if (mode === "urls") {
  const ts = Number(process.env.DEPART_EPOCH || nextMonday0730());
  console.error(`depart epoch ${ts} (${new Date(ts * 1000).toISOString()} read as Melbourne local)`);
  console.log(JSON.stringify(props.map((p) => [p.addr, mapsUrl(p.lat, p.lng, ts)])));
} else if (mode === "apply") {
  // measured.json: { "<address>": { min, dep, arr, route }, ... }
  const measured = JSON.parse(fs.readFileSync(process.argv[4], "utf8"));
  const out = [];
  const missing = [];
  for (const p of props) {
    const m = measured[p.addr];
    if (!m || !m.min) {
      missing.push(p.addr);
      continue;
    }
    const bus = /^(\d+)\s/.exec(m.route)?.[1];
    const summary = bus ? `Bus ${bus} + Werribee train` : m.route;
    out.push({
      listingUrl: p.url,
      ptMinutesToFlinders: m.min,
      ptRouteSummary: summary,
      // NOT prefixed "Estimated" — that prefix is what drives the UI's "*"
      // marker, and these are real measured trips.
      ptSteps: `Depart 7:30am (Mon) from ${p.addr.split(",")[0]}: ${summary}, board ${m.dep} → Flinders St ${m.arr}, ~${m.min} min.`,
    });
  }
  fs.writeFileSync(process.argv[5], JSON.stringify({ properties: out }, null, 1));
  console.log(JSON.stringify({ measured: out.length, missing, out: process.argv[5] }));
} else {
  console.error("usage: _transit-measure.mjs urls <props.json> | apply <props.json> <measured.json> <out.json>");
  process.exit(1);
}
