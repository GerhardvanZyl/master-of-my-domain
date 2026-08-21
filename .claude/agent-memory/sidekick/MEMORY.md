# Memory index

- [Ponytail mode convention](ponytail_mode_convention.md) — laziest-solution mode + concurrent-agent file-ownership split used in briefs for this repo
- [Hydration-safe localStorage pattern](hydration_safe_localstorage.md) — how client components should read localStorage/avoid router.refresh() in this repo
- [Floorplan metadata batches](floorplan_metadata_batches.md) — meta:set job: many agency floorplans have no printed dimensions (legit skip); resolution check for illegible ones
- [load.ts NUL bytes](load_ts_nul_bytes.md) — src/db/queries/load.ts has pre-existing embedded NUL bytes; `git diff` on it needs `-a` or it reports "binary files differ"
- [Shared property-filter module](shared_property_filter_module.md) — src/lib/property-filters.ts is the one filter-predicate definition PropertyGrid + MapView both use
- [MapView region scoping](map_view_region_scoping.md) — /map shows both VIC+NSW; grid filters are region-scoped localStorage keys, so /map must read both
- [Native select arrow-key writes](native_select_arrow_key_writes.md) — closed `<select>` consumes arrow keys itself; guard on the control that owns the write, not the global handler
- [UI test write verification](ui_test_write_verification.md) — prefer page.on("request") over DOM state to prove a write did/didn't happen in test/ui.test.ts
