---
name: react-hydration-comment-markers
description: React/Next SSR inserts <!-- --> between adjacent JSX text/expression children — breaks naive regex scraping of rendered HTML across such a boundary
metadata:
  type: project
---

When JSX renders adjacent text and expression children on one line — e.g.
`{g.label} ({g.members})` — React's SSR output is NOT the literal concatenated
string. It inserts `<!-- -->` hydration markers between them to keep each
child distinguishable during hydration:

```
kitchen<!-- --> (<!-- -->374<!-- -->)
```

**Why:** this repo has several scripts (`scripts/_tag-remote.ts`,
`scripts/_live-http.mjs`, `scripts/_groups-from-tags.mjs`) that scrape the
live app's rendered HTML with regex instead of hitting an API, because no
enumeration endpoint exists for the data they need (see
[[shared_property_filter_module]] and the `_live-http.mjs` header for why
the flight stream is preferred over the badge HTML more generally). A regex
written by reading the JSX source and assuming "label immediately followed by
literal ' ('" will silently match zero rows in production-rendered HTML —
`npm test`/`tsc` won't catch it since there's no fixture exercising the real
SSR output, only source-level assumptions.

**How to apply:** any time a script regex-parses server-rendered HTML across
what looked like two adjacent JSX children (two `{expr}` or an `{expr}` next
to literal text on the same source line), write the regex to stop at the
first delimiter that's unambiguous for your purpose (e.g. match `>([a-z]+)`
and stop, rather than `>([a-z]+) \(`) — don't require the literal text that
JSX source shows immediately following the expression, because the render
output is not literally adjacent. Verify against a real running instance
(`next dev` on a throwaway DB, `curl`) before trusting the regex, not just
against the JSX source.
