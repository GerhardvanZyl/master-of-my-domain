---
name: rendered-page-badge-scraping-pitfalls
description: Three concrete traps when regex-scraping /property/[id] HTML for a room-tag badge (used by _tag-remote.ts and any coverage-audit script) — first-occurrence bias, matchAll window overshoot, and non-.webp extensions
metadata:
  type: project
---

`scripts/_tag-remote.ts` greps rendered `/property/[id]` HTML for
`(img_[0-9a-f]+)\.webp([\s\S]{0,400})` and treats a `class="...uppercase...">
{room}</span>` inside the captured window as "already tagged." That regex is
narrower than it looks and breaks the moment you reuse it for a different
question ("is this image tagged *anywhere* on the page?" rather than
"the first place this id appears, is it tagged?"):

1. **Every image id appears many times per page** — HeroGallery (hero +
   showcase strip) renders before PhotoGrid in document order, and each is
   its own `next/image` with a multi-width `srcSet`. HeroGallery never
   renders a badge at all, so taking the *first* occurrence of an id (as
   `_tag-remote.ts` does) systematically misreads every hero/showcase photo
   as untagged, even when PhotoGrid's later rendering of the same id has one.
2. **A fixed lookahead window is unsound with `matchAll`'s non-overlapping
   semantics** — the window text is consumed as part of the match, so a
   match starting at the wrong occurrence can jump straight over the one
   genuine badge and silently report 0 tagged images for an entire property.
   Widening the window (tried up to 2000 chars) does not fix this and can
   make it worse. Fix: match the whole `<img>`/`<Image>` tag with `[^<]*`
   (safe — HTML attribute values never contain a literal `<`) through to its
   own `/>`, collapsing all `srcSet` repeats of one id into a single match,
   then check for a badge immediately following that specific tag.
3. **The badge word isn't always followed by `</span>`** — PhotoGrid nests a
   second dot `<span>` inside the badge for machine-tagged-not-reviewed
   images, so `word</span>` fails on exactly those; match the word right
   after the opening tag instead, no closing-tag assumption.
4. **Not every stored image is `.webp`** — at least one live listing had a
   `.gif`. A regex hardcoded to `\.webp` silently drops those images from any
   count.

**How to apply:** any future script that scrapes `/property/[id]` HTML for
room-tag/badge presence needs the OR-across-every-occurrence + whole-tag-match
version, not a copy of `_tag-remote.ts`'s regex verbatim — that regex is fine
for *that* script's own narrower use (checking one already-known occurrence
per fetched page in a single-pass tagging flow) but wrong for a coverage
count. See `scripts/_audit-hero-floorplan.mjs` for the corrected regex.

Related: [[floorplan_metadata_batches]], [[photo_fixture_visibility_filter]].
