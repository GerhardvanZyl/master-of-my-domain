// Keyless Google Maps embeds (maps.google.com output=embed / svembed — no API
// key needed). Stacks an interactive map (pan + zoom controls built in),
// a satellite view, and a street view photo of the property.
export default function PropertyMap({
  lat,
  lng,
  address,
  // Min width each view wants before wrapping to the next line. On the wide
  // detail page all three sit side by side; in a narrow compare column they
  // stack. ~430px ≈ the old 288px-tall 2:1 view enlarged ~25%.
  minWidth = "430px",
}: {
  lat: number | null;
  lng: number | null;
  address?: string | null;
  minWidth?: string;
}) {
  if (lat == null || lng == null) return null;
  const q = `${lat},${lng}`;
  // aspect-[2/1] keeps every view a 2:1 (w:h) rectangle; flex-wrap keeps them
  // next to each other when there's room and wraps when there isn't.
  const frame =
    "aspect-[2/1] w-full rounded-lg border border-neutral-200 dark:border-neutral-800";
  const views = [
    { label: "Map", title: `Map of ${address ?? q}`, src: `https://maps.google.com/maps?q=${q}&z=13&output=embed` },
    { label: "Satellite", title: `Satellite view of ${address ?? q}`, src: `https://maps.google.com/maps?q=${q}&t=k&z=17&output=embed` },
    { label: "Street view", title: `Street view of ${address ?? q}`, src: `https://maps.google.com/maps?q=&layer=c&cbll=${q}&cbp=11,0,0,0,0&output=svembed` },
  ];
  return (
    <div className="space-y-1">
      <div className="flex flex-wrap gap-3">
        {views.map((v) => (
          <div key={v.label} className="flex-1 space-y-1" style={{ minWidth }}>
            <div className="text-xs font-medium text-neutral-400">{v.label}</div>
            <iframe
              title={v.title}
              src={v.src}
              loading="lazy"
              referrerPolicy="no-referrer-when-downgrade"
              className={frame}
            />
          </div>
        ))}
      </div>
      <a
        href={`https://www.google.com/maps/search/?api=1&query=${q}`}
        target="_blank"
        rel="noreferrer"
        className="inline-block text-xs text-blue-600 hover:underline"
      >
        Open in Google Maps ↗
      </a>
    </div>
  );
}

/** 10 street-view snapshots at deterministic points ~a few hundred m around the
 *  property — a feel for the surrounding area. Seeded off the property id so the
 *  set is stable across renders. */
export function AreaPhotos({
  lat,
  lng,
  seed,
}: {
  lat: number | null;
  lng: number | null;
  seed: string;
}) {
  if (lat == null || lng == null) return null;
  let s = 0;
  for (let i = 0; i < seed.length; i++) s = (s * 31 + seed.charCodeAt(i)) & 0x7fffffff;
  const pts: [number, number, number][] = [];
  for (let i = 0; i < 10; i++) {
    s = (s * 1103515245 + 12345) & 0x7fffffff;
    const dLat = (s / 0x7fffffff - 0.5) * 0.008; // ~±450 m
    s = (s * 1103515245 + 12345) & 0x7fffffff;
    const dLng = (s / 0x7fffffff - 0.5) * 0.008;
    pts.push([lat + dLat, lng + dLng, (i * 47) % 360]);
  }
  return (
    <div className="grid grid-cols-2 gap-2 sm:grid-cols-3 md:grid-cols-5">
      {pts.map(([la, ln, heading], i) => (
        <iframe
          key={i}
          title={`Area photo ${i + 1}`}
          src={`https://maps.google.com/maps?q=&layer=c&cbll=${la},${ln}&cbp=11,${heading},0,0,0&output=svembed`}
          loading="lazy"
          referrerPolicy="no-referrer-when-downgrade"
          className="aspect-square w-full rounded-md border border-neutral-200 dark:border-neutral-800"
        />
      ))}
    </div>
  );
}
