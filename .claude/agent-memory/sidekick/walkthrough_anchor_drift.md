---
name: walkthrough-anchor-drift
description: pr-walkthrough drafts in this repo tend to cite line ranges that are too wide or start too early, anchored to a nearby export/component boundary rather than the specific logic described
metadata:
  type: feedback
---

When reviewing a `pr-walkthrough` draft in this repo (via `pr-walkthrough-review`),
don't trust a cited range just because the file and rough area are right. Observed
pattern in the `property-detail-and-map` walkthrough: a range like
`MapView.tsx:23-56` was cited for "restores both regions' saved filters via
`loadRegionFilters`", but that logic actually lived at lines 59-70 — the draft had
anchored to the start of the enclosing component/file section rather than the
specific hook/effect being described. Same pattern hit `TagSelect.tsx:22-53` cited
for a single function that actually ends at line 36 (the range bled into the next,
unrelated function).

**Why:** these ranges are the whole reason `pr-walkthrough-review` exists — a wrong
line sends the reviewer to the wrong place with false confidence, worse than no
anchor at all.

**How to apply:** for every `file:start-end` anchor, grep the described symbol
(function name, hook call, JSX attribute) for its real line number and check it
falls inside the cited range, not just near it. Don't accept "close enough within
the right function neighbourhood" — tighten to the actual span of the thing being
described. See [[load_ts_nul_bytes]] for the one file in this repo where a plain
`grep -n` silently returns nothing and `-a` is needed instead.
