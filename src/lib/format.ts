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
