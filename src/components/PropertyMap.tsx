// Keyless Google Maps embeds (maps.google.com output=embed / svembed — no API
// key needed). Stacks an interactive map (pan + zoom controls built in),
// a satellite view, and a street view photo of the property.
export default function PropertyMap({
  lat,
  lng,
  address,
  className = "h-72",
}: {
  lat: number | null;
  lng: number | null;
  address?: string | null;
  className?: string;
}) {
  if (lat == null || lng == null) return null;
  const q = `${lat},${lng}`;
  const frame = "w-full rounded-xl border border-line bg-fill";
  return (
    <div className="space-y-3">
      <div className="space-y-1">
        <iframe
          title={`Map of ${address ?? q}`}
          src={`https://maps.google.com/maps?q=${q}&z=13&output=embed`}
          loading="lazy"
          referrerPolicy="no-referrer-when-downgrade"
          className={`${frame} ${className}`}
        />
        <a
          href={`https://www.google.com/maps/search/?api=1&query=${q}`}
          target="_blank"
          rel="noreferrer"
          className="text-xs text-forest hover:text-forest-hi"
        >
          Open in Google Maps ↗
        </a>
      </div>
      {/* Satellite + street view side by side, as in the mock. */}
      <div className="grid grid-cols-2 gap-3">
        <div className="space-y-1.5">
          <div className="label-cap text-[11px] tracking-wide">Satellite</div>
          <iframe
            title={`Satellite view of ${address ?? q}`}
            src={`https://maps.google.com/maps?q=${q}&t=k&z=17&output=embed`}
            loading="lazy"
            referrerPolicy="no-referrer-when-downgrade"
            className={`${frame} h-[150px]`}
          />
        </div>
        <div className="space-y-1.5">
          <div className="label-cap text-[11px] tracking-wide">Street view</div>
          <iframe
            title={`Street view of ${address ?? q}`}
            src={`https://maps.google.com/maps?q=&layer=c&cbll=${q}&cbp=11,0,0,0,0&output=svembed`}
            loading="lazy"
            referrerPolicy="no-referrer-when-downgrade"
            className={`${frame} h-[150px]`}
          />
        </div>
      </div>
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
          className="aspect-square w-full rounded-xl border border-line bg-fill"
        />
      ))}
    </div>
  );
}
