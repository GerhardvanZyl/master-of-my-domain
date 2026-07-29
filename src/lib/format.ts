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

/** A price string that actually contains a dollar amount, not just a status. */
const hasAmount = (s?: string | null) => !!s && /\$\s?[\d,]/.test(s);

export function fmtAud(n: number): string {
  return new Intl.NumberFormat("en-AU", {
    style: "currency",
    currency: "AUD",
    maximumFractionDigits: 0,
  }).format(n);
}

export interface PricedEvent {
  event: string | null;
  date: string | null;
  priceDisplay: string | null;
}

/**
 * Best available price text for a listing, plus the status it replaced.
 * Domain routinely drops the guide once a listing goes under offer/sold and
 * leaves only a status string ("Under offer", "Contact agent"), so fall through
 * the advertised guide → numeric → last priced history row before admitting
 * there's no number. Never returns "—": the card always says *something*.
 */
export function priceLine(p: {
  priceDisplay: string | null;
  priceNumeric: number | null;
  advPriceCurrent?: string | null;
  lastPricedEvent?: PricedEvent | null;
}): { text: string; note: string | null } {
  if (hasAmount(p.priceDisplay)) return { text: p.priceDisplay!.trim(), note: null };
  const status = p.priceDisplay?.trim() || null;
  if (hasAmount(p.advPriceCurrent)) return { text: p.advPriceCurrent!.trim(), note: status };
  if (p.priceNumeric && p.priceNumeric > 0) return { text: fmtAud(p.priceNumeric), note: status };
  const h = p.lastPricedEvent;
  if (hasAmount(h?.priceDisplay)) {
    const when = [h!.event, h!.date].filter(Boolean).join(" ");
    return { text: h!.priceDisplay!.trim(), note: when || status };
  }
  return { text: "No price listed", note: status };
}

const SHORT_MONTHS = [
  "Jan", "Feb", "Mar", "Apr", "May", "Jun",
  "Jul", "Aug", "Sep", "Oct", "Nov", "Dec",
];

/**
 * Renders a `YYYY-MM-DD` sold date as "D Mon YY"/"D Mon YYYY". Built by hand
 * rather than Intl.DateTimeFormat({month:"short"}) — some ICU locale data
 * (incl. en-AU on this Node build) spells July out in full ("28 July 26")
 * even when asked for the short form, which is too wide for the tiny badge.
 * Parsed as UTC so a pure date string never shifts a day against local tz.
 */
function formatSoldDate(date: string, fullYear: boolean): string | null {
  const t = Date.parse(`${date}T00:00:00Z`);
  if (Number.isNaN(t)) return null;
  const d = new Date(t);
  const year = fullYear ? String(d.getUTCFullYear()) : String(d.getUTCFullYear()).slice(-2);
  return `${d.getUTCDate()} ${SHORT_MONTHS[d.getUTCMonth()]} ${year}`;
}

/** "28 Jul 26" — compact, for the tiny uppercase Sold badge on grid cards. */
export function fmtSoldDate(date: string | null): string | null {
  return date ? formatSoldDate(date, false) : null;
}

/** "28 Jul 2026" — full year, for the detail-page sold banner. */
export function fmtSoldDateLong(date: string | null): string | null {
  return date ? formatSoldDate(date, true) : null;
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

/**
 * A transit time carried over from the nearest tracked property rather than
 * looked up fresh (the Maps 7:30am UI can't be scripted). Marked in pt_steps;
 * the UI shows a `*` on such times. Keep this prefix in sync with the value
 * written by the transit-estimate step (see the processing-round memory).
 */
export function isTransitEstimated(ptSteps: string | null | undefined): boolean {
  return !!ptSteps && ptSteps.startsWith("Estimated from nearest tracked property");
}

/** ISO datetime -> "just now" / "5 min ago" / "3h ago" / "2d ago" / "14 Jul". */
export function fmtRelative(iso: string): string {
  const t = Date.parse(iso);
  if (Number.isNaN(t)) return "";
  const diffMs = Date.now() - t;
  const min = Math.floor(diffMs / 60_000);
  if (min < 1) return "just now";
  if (min < 60) return `${min} min ago`;
  const hr = Math.floor(min / 60);
  if (hr < 24) return `${hr}h ago`;
  const day = Math.floor(hr / 24);
  if (day < 7) return `${day}d ago`;
  return new Intl.DateTimeFormat("en-AU", {
    timeZone: "Australia/Melbourne",
    day: "numeric",
    month: "short",
  }).format(new Date(t));
}
