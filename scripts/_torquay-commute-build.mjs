import fs from "node:fs";

/**
 * Torquay commute = drive to Waurn Ponds Station + V/Line Geelong service to
 * Southern Cross. Replaces the bus/train-to-Flinders-St routing Google returns
 * by default, which is not how anyone actually commutes from the Surf Coast.
 *
 * Timetable scraped from Google Maps for Mon 10 Aug 2026 (Waurn Ponds ->
 * Southern Cross). Departure/arrival are clock minutes past midnight.
 */
const TRAINS = [
  { dep: 7 * 60 + 39, arr: 9 * 60 + 6 },
  { dep: 7 * 60 + 58, arr: 9 * 60 + 27 },
  { dep: 8 * 60 + 16, arr: 9 * 60 + 44 },
  { dep: 8 * 60 + 30, arr: 9 * 60 + 47 },
  { dep: 8 * 60 + 38, arr: 10 * 60 + 10 },
  { dep: 9 * 60 + 0, arr: 10 * 60 + 30 },
];
const LEAVE_HOME = 7 * 60 + 30; // 07:30
const PARK_BUFFER = 5; // park the car + walk to the platform

const hhmm = (m) => {
  const h24 = Math.floor(m / 60);
  const h = h24 % 12 === 0 ? 12 : h24 % 12;
  return `${h}:${String(m % 60).padStart(2, "0")} ${h24 < 12 ? "AM" : "PM"}`;
};

const drives = JSON.parse(fs.readFileSync("data/harvest/_torquay-drive.json", "utf8"));
const out = [];
const missed = [];
for (const d of drives) {
  const atStation = LEAVE_HOME + d.driveMin;
  const ready = atStation + PARK_BUFFER;
  const train = TRAINS.find((t) => t.dep >= ready);
  if (!train) {
    missed.push(d.address);
    continue;
  }
  const total = train.arr - LEAVE_HOME;
  const wait = train.dep - atStation;
  const via = d.via ? d.via.replace(/^via\s*/i, "") : "Surf Coast Hwy";
  out.push({
    listingUrl: d.listingUrl,
    ptMinutesToFlinders: total,
    ptRouteSummary: `Drive ${d.driveMin} min to Waurn Ponds + V/Line to Southern Cross`,
    ptSteps:
      `Leave 7:30 AM, drive ~${d.driveMin} min to Waurn Ponds Station via ${via} (${d.km ?? "?"} km), ` +
      `arrive ${hhmm(atStation)}. Park (~${wait} min wait), catch the ${hhmm(train.dep)} V/Line Geelong service, ` +
      `arrive Southern Cross ${hhmm(train.arr)}. Total ${total} min.`,
    _driveMin: d.driveMin,
    _wait: wait,
    _address: d.address,
  });
}

const mins = out.map((o) => o.ptMinutesToFlinders).sort((a, b) => a - b);
console.log("built:", out.length, "of", drives.length);
if (missed.length) console.log("no train after arrival (!):", missed);
console.log("total minutes  min/median/max:", mins[0], mins[Math.floor(mins.length / 2)], mins[mins.length - 1]);
const dm = out.map((o) => o._driveMin).sort((a, b) => a - b);
console.log("drive minutes  min/median/max:", dm[0], dm[Math.floor(dm.length / 2)], dm[dm.length - 1]);
const trainUse = {};
for (const o of out) trainUse[o.ptSteps.match(/catch the ([\d:]+ [AP]M)/)[1]] ??= 0;
for (const o of out) trainUse[o.ptSteps.match(/catch the ([\d:]+ [AP]M)/)[1]]++;
console.log("train caught:", JSON.stringify(trainUse));
console.log("\nsample:", out[0].ptSteps);

fs.writeFileSync(
  "data/harvest/torquay-commute.json",
  JSON.stringify(out.map(({ _driveMin, _wait, _address, ...r }) => r), null, 1),
);
console.log("\nwrote data/harvest/torquay-commute.json");
