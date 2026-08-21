---
name: load-ts-nul-bytes
description: src/db/queries/load.ts contains embedded NUL bytes (pre-existing, not a bug I introduced) that make `git diff` show it as binary
metadata:
  type: project
---

`src/db/queries/load.ts`'s price-history dedup key-building lines
(`` `${r.date}\0${r.event}\0${r.priceDisplay}` ``-style template literals, ~line
175-190) contain literal `\x00` NUL bytes instead of the space characters a
normal Read/cat view of the file appears to show. Confirmed present in `HEAD`
before any of my edits — this is pre-existing, not something introduced by a
change. It's presumably an intentional delimiter choice (NUL can't appear in
the joined fields) but the file's odd raw encoding means:

- `file src/db/queries/load.ts` reports it as `data`, not text.
- Plain `git diff` on this file prints "Binary files ... differ" instead of a
  readable diff — use `git diff -a -- src/db/queries/load.ts` to force a text
  diff when reviewing changes to this file.

**Why:** wasted time confirming a real diff was clean because the file
misreported as binary. **How to apply:** any future edit to
`src/db/queries/load.ts`, always diff with `-a` (or `--text`) rather than
trusting a "binary files differ" result to mean something is wrong.
