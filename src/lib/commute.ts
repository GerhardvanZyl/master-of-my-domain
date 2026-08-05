// `pt_minutes_to_flinders` measures the morning commute, but which station it
// commutes *to* now depends on where the property is:
//   - NSW rows (Sydney dataset) → Museum Station.
//   - Torquay (VIC 3228) → drives to Waurn Ponds, V/Line to Southern Cross.
//   - everything else (Point Cook / Williams Landing) → Flinders St.
// The column name stays `ptMinutesToFlinders` — renaming it across
// schema/ddl/load/queries isn't worth it — but the label shown to the user
// must name the right destination.
export function commuteDestination(p: {
  state?: string | null;
  suburb?: string | null;
}): string {
  if (p.state === "NSW") return "Museum Stn";
  if (p.suburb === "Torquay") return "Southern Cross";
  return "Flinders St";
}
