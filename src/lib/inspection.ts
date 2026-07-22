const TZ = "Australia/Melbourne";

/** YYYY-MM-DD for a date, in Melbourne — so "upcoming" is a calendar-day test,
 *  not an instant test (an inspection stays shown all day, hides the day after). */
function melDay(d: Date): string {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: TZ,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(d);
}

/**
 * Format a stored next-inspection ISO datetime into a short pill label, e.g.
 * "Sat 26 Jul, 11am". Returns null for missing/unparseable input. `upcoming` is
 * false once the inspection day has passed, so stale values drop out of the UI.
 */
export function formatInspection(
  iso: string | null | undefined,
): { label: string; upcoming: boolean } | null {
  if (!iso) return null;
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return null;
  const p = Object.fromEntries(
    new Intl.DateTimeFormat("en-US", {
      timeZone: TZ,
      weekday: "short",
      day: "numeric",
      month: "short",
      hour: "numeric",
      minute: "2-digit",
      hour12: true,
    })
      .formatToParts(d)
      .map((x) => [x.type, x.value]),
  );
  const time =
    p.minute === "00"
      ? `${p.hour}${p.dayPeriod.toLowerCase()}`
      : `${p.hour}:${p.minute}${p.dayPeriod.toLowerCase()}`;
  return {
    label: `${p.weekday} ${p.day} ${p.month}, ${time}`,
    upcoming: melDay(d) >= melDay(new Date()),
  };
}

if (process.argv[1]?.endsWith("inspection.ts")) {
  const assert = (c: unknown, m: string) => {
    if (!c) throw new Error(m);
  };
  assert(formatInspection(null) === null, "null in");
  assert(formatInspection("nope") === null, "garbage in");
  const r = formatInspection("2026-07-25T11:00:00+10:00")!;
  assert(r.label === "Sat 25 Jul, 11am", `label was ${r.label}`);
  assert(
    formatInspection("2026-07-25T11:30:00+10:00")!.label === "Sat 25 Jul, 11:30am",
    "half past",
  );
  assert(formatInspection("2000-01-01T11:00:00+10:00")!.upcoming === false, "past");
  assert(formatInspection("2999-01-01T11:00:00+10:00")!.upcoming === true, "future");
  console.log("OK inspection", r.label);
}
