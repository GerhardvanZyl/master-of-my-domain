# Memory index

- [Ponytail mode convention](ponytail_mode_convention.md) — laziest-solution mode + concurrent-agent file-ownership split used in briefs for this repo
- [Hydration-safe localStorage pattern](hydration_safe_localstorage.md) — how client components should read localStorage/avoid router.refresh() in this repo
- [Floorplan metadata batches](floorplan_metadata_batches.md) — meta:set job: many agency floorplans have no printed dimensions (legit skip); resolution check for illegible ones
- [load.ts NUL bytes](load_ts_nul_bytes.md) — src/db/queries/load.ts has pre-existing embedded NUL bytes; `git diff` on it needs `-a` or it reports "binary files differ"
- [Shared property-filter module](shared_property_filter_module.md) — src/lib/property-filters.ts is the one filter-predicate definition PropertyGrid + MapView both use
- [MapView region scoping](map_view_region_scoping.md) — since 2026-08-21: /map=VIC, /sydney/map=NSW, MapView takes `region` prop, one filter key (old dual-read deleted)
- [Native select arrow-key writes](native_select_arrow_key_writes.md) — closed `<select>` consumes arrow keys itself; guard on the control that owns the write, not the global handler
- [UI test write verification](ui_test_write_verification.md) — prefer page.on("request") over DOM state to prove a write did/didn't happen in test/ui.test.ts
- [Walkthrough anchor drift](walkthrough_anchor_drift.md) — pr-walkthrough drafts here cite ranges anchored to the wrong nearby boundary; grep the real symbol before trusting a line range
- [Map pin hit vs visual size](map_pin_hit_vs_visual_size.md) — pin button (24px-floored hit area) != inner span (true 5-50px scaled dot); test the span for size
- [Drag vs click suppression](drag_vs_click_suppression.md) — capture pointer only once a drag is DETECTED, not on pointerdown (capture-at-down retargets click to the container, swallowing every click); reset draggedRef on pointerdown too
- [Photo fixture visibility filter](photo_fixture_visibility_filter.md) — a photo's on-screen Lightbox/PhotoGrid index is the isVisibleImage-filtered index, not its raw `ordinal`; don't hand-pick a UUID+ordinal from inspection
- [Migration test harness argv override](migration_test_harness_argv_override.md) — pass an alt ddl.ts path as argv[2] to migration-concurrency.test.ts instead of editing ddl.ts in place
