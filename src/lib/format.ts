export function formatPrice(
  display: string | null,
  numeric: number | null,
): string {
  if (display && display.trim()) return display;
  if (numeric && numeric > 0) {
    return new Intl.NumberFormat("en-AU", {
      style: "currency",
      currency: "AUD",
      maximumFractionDigits: 0,
    }).format(numeric);
  }
  return "—";
}

export function bedBathCar(
  beds: number | null,
  baths: number | null,
  parking: number | null,
): string {
  const parts: string[] = [];
  if (beds != null) parts.push(`${beds} bed`);
  if (baths != null) parts.push(`${baths} bath`);
  if (parking != null) parts.push(`${parking} car`);
  return parts.join(" · ") || "—";
}

export function fmtNum(n: number | null, suffix = ""): string {
  return n == null ? "—" : `${n}${suffix}`;
}

/** Metres → "850 m" / "1.4 km". */
export function fmtDistance(m: number | null): string {
  if (m == null) return "—";
  return m < 1000 ? `${m} m` : `${(m / 1000).toFixed(1)} km`;
}

/** Minutes → "18 min" / "1h 05m". */
export function fmtMinutes(min: number | null): string {
  if (min == null) return "—";
  const h = Math.floor(min / 60);
  const m = min % 60;
  return h ? `${h}h ${String(m).padStart(2, "0")}m` : `${m} min`;
}
