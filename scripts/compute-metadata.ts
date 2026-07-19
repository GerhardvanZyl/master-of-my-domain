/**
 * compute-metadata.ts — standalone metadata computer.
 *
 * For each harvested property computes:
 *   - greenCrossDistanceM: straight-line metres to Greencross Vet Hospital, Werribee.
 *   - playgrounds500m:     count of public playgrounds within 500 m.
 *   - colesDistanceM / colesName: nearest Coles supermarket + its name.
 *
 * Run: npx tsx scripts/compute-metadata.ts
 * Writes: data/harvest/metadata.json
 */
import { readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";

// Greencross Vet Hospital at the University of Melbourne, Werribee.
// Address: Building 411, 250 Princes Highway, Werribee VIC 3030.
// Coords via OSM/Nominatim (the veterinary amenity on the UniMelb Werribee campus).
const GREENCROSS = { lat: -37.8896074, lng: 144.6925735 };

// ponytail: playground coordinates snapshotted from Overpass API on request
// (leisure=playground, node+way `out center`, over the Point Cook / Williams Landing box).
const PLAYGROUNDS: [number, number][] = [
  [-37.8797594, 144.7916084], [-37.8889874, 144.7290742], [-37.8907472, 144.7246556],
  [-37.8767756, 144.7864720], [-37.8628829, 144.7221323], [-37.8584833, 144.7760876],
  [-37.8602276, 144.7689792], [-37.8614783, 144.7740809], [-37.8615682, 144.7688412],
  [-37.8628646, 144.7720003], [-37.8536605, 144.7726805], [-37.8672605, 144.7146456],
  [-37.8848020, 144.7886297], [-37.8724370, 144.7072782], [-37.9063142, 144.7315196],
  // ways (center coords)
  [-37.8850693, 144.7511718], [-37.8735650, 144.7565302], [-37.9284302, 144.7719096],
  [-37.9284466, 144.7729302], [-37.8551628, 144.7345717], [-37.8474724, 144.7245680],
  [-37.8591433, 144.7428668], [-37.8680227, 144.7721254], [-37.8891998, 144.7525322],
  [-37.8891043, 144.7411270], [-37.8994273, 144.7345495], [-37.8803853, 144.7561913],
  [-37.8569138, 144.7512311], [-37.8773724, 144.7047550], [-37.8861016, 144.7348757],
  [-37.8823641, 144.7492954], [-37.8851321, 144.7586381], [-37.8845932, 144.7609504],
  [-37.8785321, 144.7442665], [-37.8504018, 144.7098610], [-37.8951814, 144.7411302],
  [-37.8976196, 144.7457862], [-37.8960877, 144.7451294], [-37.8864773, 144.7449336],
  [-37.9132642, 144.7795120], [-37.9086832, 144.7583333], [-37.9163689, 144.7805745],
  [-37.8400523, 144.7164412], [-37.9085739, 144.7662213], [-37.8912503, 144.7832797],
  [-37.9087976, 144.7614229], [-37.8656676, 144.7836891], [-37.8804278, 144.7364759],
  [-37.9093479, 144.7498693], [-37.9142951, 144.7607363], [-37.8928433, 144.7543271],
  [-37.8927315, 144.7543756], [-37.8925392, 144.7543382], [-37.8876248, 144.7153616],
  [-37.8599856, 144.7504472], [-37.9027081, 144.7487979], [-37.9138297, 144.7853986],
  [-37.9032531, 144.7382101], [-37.9040506, 144.7435215], [-37.8726777, 144.7665263],
  [-37.8727703, 144.7621049], [-37.8525144, 144.7416045], [-37.9016067, 144.7796553],
  [-37.8644517, 144.7356051], [-37.8848195, 144.7885872], [-37.8673695, 144.7664796],
  [-37.8634424, 144.7531845], [-37.8884590, 144.7405552], [-37.9100095, 144.7269703],
  [-37.9016554, 144.7180326], [-37.9001559, 144.7235698], [-37.8999920, 144.7558881],
  [-37.8657323, 144.7000665], [-37.8672568, 144.7214697], [-37.8858251, 144.7212502],
  [-37.9130029, 144.7687899], [-37.9027799, 144.7089155], [-37.9029437, 144.7095832],
  [-37.9036194, 144.7095231], [-37.9035493, 144.7088090], [-37.9097646, 144.7667809],
  [-37.8922556, 144.7198644], [-37.8465432, 144.7145329], [-37.8466943, 144.7144612],
  [-37.8468203, 144.7147255],
];

// ponytail: Coles supermarket coordinates snapshotted from Overpass API on request
// (shop=supermarket, name~"Coles" case-insensitive, node+way `out center`).
const COLES: { name: string; lat: number; lng: number }[] = [
  { name: "Coles", lat: -37.8952497, lng: 144.7530363 },
  { name: "Coles", lat: -37.8815939, lng: 144.7032684 },
  { name: "Coles", lat: -37.8732777, lng: 144.7759322 },
  { name: "Coles", lat: -37.8825051, lng: 144.7346373 },
  { name: "Coles", lat: -37.8490120, lng: 144.7037194 },
];

function haversineM(lat1: number, lng1: number, lat2: number, lng2: number): number {
  const R = 6371000;
  const toRad = (d: number) => (d * Math.PI) / 180;
  const dLat = toRad(lat2 - lat1);
  const dLng = toRad(lng2 - lng1);
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(a));
}

const root = process.cwd(); // run from repo root: npx tsx scripts/compute-metadata.ts
const props: { listingUrl: string; latitude?: number; longitude?: number }[] =
  JSON.parse(readFileSync(resolve(root, "data/harvest/enriched-core.json"), "utf8"));

const out = props.map((p) => {
  const { listingUrl, latitude: lat, longitude: lng } = p;
  if (lat == null || lng == null) {
    return {
      listingUrl,
      greenCrossDistanceM: null,
      playgrounds500m: null,
      colesDistanceM: null,
      colesName: null,
    };
  }
  const greenCrossDistanceM = Math.round(haversineM(lat, lng, GREENCROSS.lat, GREENCROSS.lng));
  const playgrounds500m = PLAYGROUNDS.reduce(
    (n, [plat, plng]) => n + (haversineM(lat, lng, plat, plng) <= 500 ? 1 : 0),
    0,
  );
  let nearest = COLES[0];
  let nearestD = Infinity;
  for (const c of COLES) {
    const d = haversineM(lat, lng, c.lat, c.lng);
    if (d < nearestD) {
      nearestD = d;
      nearest = c;
    }
  }
  return {
    listingUrl,
    greenCrossDistanceM,
    playgrounds500m,
    colesDistanceM: Math.round(nearestD),
    colesName: nearest.name,
  };
});

const outPath = resolve(root, "data/harvest/metadata.json");
writeFileSync(outPath, JSON.stringify(out, null, 2));
console.log(`Wrote ${out.length} rows -> ${outPath}`);
console.log(`With coords: ${out.filter((r) => r.greenCrossDistanceM != null).length}`);
