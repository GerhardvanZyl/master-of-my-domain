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

Recurred in `pin-rank-scale-and-pca-search-link.md` (2026-08-23): three citations
of a corrected `MapView.tsx` comment all read `:150-152`, off by exactly one line
from the comment's real span (`151-153`) — consistent within the document (same
wrong number reused, not three independent typos), so a single stale grep result
got copy-pasted rather than re-verified per citation. Also caught a range that
started one blank line too early (`pin-scale.test.ts:47-66` vs the real `48-66`)
and one that ended short of the block's closing brace (`ui.test.ts:1745-1771` vs
`1745-1774`), cutting off before the assertions the prose actually described.
Check the *end* of a range against the closing brace/paren, not just the start.
