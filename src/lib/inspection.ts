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

/**
 * Day-label for a group heading: "Sat 1 Aug" (weekday, day, month — no time),
 * built the same way formatInspection builds its own label.
 */
function dayLabel(d: Date): string {
  const p = Object.fromEntries(
    new Intl.DateTimeFormat("en-US", {
      timeZone: TZ,
      weekday: "short",
      day: "numeric",
      month: "short",
    })
      .formatToParts(d)
      .map((x) => [x.type, x.value]),
  );
  return `${p.weekday} ${p.day} ${p.month}`;
}

/**
 * Groups items by Melbourne calendar day of their `nextInspection`, for the
 * /inspect planning page. Day groups sorted chronologically ascending, items
 * within a day sorted by time ascending. Anything with no / unparseable
 * nextInspection, or whose day has already passed (formatInspection().upcoming
 * === false), lands in one trailing group keyed `""` — render that as
 * "No time yet" rather than a stale/empty date heading.
 */
export function groupByInspectionDay<T extends { nextInspection?: string | null }>(
  items: T[],
): { day: string; items: T[] }[] {
  const byDay = new Map<string, { label: string; items: T[] }>();
  const noTime: T[] = [];

  for (const item of items) {
    const info = formatInspection(item.nextInspection);
    if (!info || !info.upcoming) {
      noTime.push(item);
      continue;
    }
    const d = new Date(item.nextInspection!);
    const key = melDay(d);
    if (!byDay.has(key)) byDay.set(key, { label: dayLabel(d), items: [] });
    byDay.get(key)!.items.push(item);
  }

  const dayGroups = [...byDay.entries()]
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([, g]) => ({
      day: g.label,
      items: g.items.sort(
        (a, b) => new Date(a.nextInspection!).getTime() - new Date(b.nextInspection!).getTime(),
      ),
    }));

  return noTime.length > 0 ? [...dayGroups, { day: "", items: noTime }] : dayGroups;
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

  // Days ahead of TODAY, anchored to the Melbourne calendar date so the
  // fixture is independent of the machine's timezone. These were hardcoded
  // ("2026-08-01") until 2026-08-10, when they quietly became past dates and
  // every item fell into the trailing group — which nothing noticed, because
  // this block wasn't wired into `npm test`. It is now; keep it relative.
  const melDayAhead = (days: number) =>
    melDay(new Date(Date.now() + days * 86_400_000));
  const d1 = melDayAhead(7);
  const d2 = melDayAhead(8);
  const items = [
    { label: "d1-late", nextInspection: `${d1}T14:00:00+10:00` },
    { label: "d1-early", nextInspection: `${d1}T09:00:00+10:00` },
    { label: "d2", nextInspection: `${d2}T10:00:00+10:00` },
    { label: "no-time", nextInspection: null },
    { label: "past", nextInspection: "2000-01-01T10:00:00+10:00" },
    { label: "garbage", nextInspection: "nope" },
  ];
  const groups = groupByInspectionDay(items);
  assert(groups.length === 3, `expected 3 groups, got ${groups.length}`);
  assert(groups[0].day !== "" && groups[1].day !== "", "future days are labelled");
  assert(groups[0].day !== groups[1].day, "the two future days are distinct groups");
  assert(
    groups[0].items.map((i) => i.label).join(",") === "d1-early,d1-late",
    `within-day order was ${groups[0].items.map((i) => i.label).join(",")}`,
  );
  assert(groups[1].items.map((i) => i.label).join(",") === "d2", "day1 items");
  assert(groups[2].day === "", `trailing group day was ${JSON.stringify(groups[2].day)}`);
  assert(
    groups[2].items.map((i) => i.label).sort().join(",") === "garbage,no-time,past",
    `trailing group items were ${groups[2].items.map((i) => i.label).join(",")}`,
  );

  console.log("OK inspection", r.label);
}
