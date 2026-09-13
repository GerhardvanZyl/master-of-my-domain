---
name: path-traversal-guard-limits-and-precheck-gating
description: post-resolution ancestor checks (startsWith/dirname) can't catch an id that collapses via ".." into a sibling's exact dir name; and a caller-side pre-check SELECT can silently defeat a callee's own idempotent-retry fix
metadata:
  type: feedback
---

Two non-obvious findings from the `feat/batch-delete` round-1 fix pass
(`src/db/queries/delete.ts`), in case either resurfaces.

**1. `path.dirname(dir) === root` (or `startsWith(root+sep)`) cannot block an id
that normalizes to another real sibling's directory name.** A review cited
`id = 'sub/../<victimId>'` as the repro for "the guard confines to the subtree,
not a direct child," with the stated fix being `path.dirname(dir) === root`.
Verified empirically (`path.resolve`) that `'sub/../<victimId>'` collapses to
`root/<victimId>` — a single segment past root — so `dirname(dir) === root` is
STILL true after the fix; it does not block that exact repro. What the
dirname-tightening *does* block is a genuinely nested case: an id containing a
plain `/` with no `..` at all (e.g. `'<victimId>/nested'`), which resolves to
`root/<victimId>/nested` and would otherwise let `fs.rm({recursive:true})`
reach *into* another property's own directory. Any purely post-resolution,
ancestor-based path check is structurally unable to stop the collapse-to-alias
case — that would need pre-validating the raw id string (reject `/` or `..`
outright) before ever calling `path.resolve`. Reported as a discrepancy rather
than silently substituting a test that wouldn't prove what the review claimed;
implemented the literal one-line fix (still closes the nested case) plus a
test built on the nested-subfolder repro instead of the literal quoted one.

**2. A caller-side existence pre-check can neutralize a callee's own retry
fix.** The accepted fix for "a re-send can never clear a failed image
directory" was to make `deleteProperty(id)` run its `fs.rmSync` step
unconditionally, regardless of whether a DB row was actually deleted. That
alone did NOT fix the bug: the caller, `deletePropertiesByRef`, did
`byId.get(id)` first and only invoked `deleteProperty` at all when a row was
found — so a re-send (row already gone) never called `deleteProperty` a
second time, and the "unconditional fs step" inside it was never reached.
**When a fix relies on a function running unconditionally, check every call
site for a pre-check that gates the call itself, not just the function body.**
Fixed here by dropping the pre-check entirely for the `ids` path (the ref IS
the id, so there's nothing to look up) and calling `deleteProperty` directly;
`listingUrls` refs still need a SELECT to translate URL→id and inherently
cannot retry a failed removal once the row (and thus the mapping) is gone —
noted as an accepted, unavoidable asymmetry between the two ref types.

**Round-2 update (2026-09-08): the collapse-to-alias case above was exploited
for real.** Combining finding 2's fix (fs step runs unconditionally, even on
`deleted: false`) with finding 1's known gap (dirname-only guard doesn't stop
`sub/../<victimId>`) meant an id matching no row could still wipe a sibling's
real image directory, 200/`ok:true`, nothing in `errors`. Fixed by adding
`path.basename(id) !== id` as a first check, BEFORE `path.resolve` — this is
exactly the "pre-validate the raw id string" fix flagged as needed in finding 1
but not implemented at the time. Kept the existing `dirname(dir) === root`
check too rather than replacing it: `basename` alone misses `.` and `..`
(their basename equals the whole string, but they resolve to non-child paths),
so both checks are independently necessary — verified against a 7-row
discriminator table before writing the fix. Test added two regression cases in
`test/batch.test.ts`: `sub/../<victimId>` (the actual bypass — matches no row,
must leave the victim's real directory alone) and `<victimId>/nested` (costs
nothing, same guard covers it, already caught by the pre-existing dirname
check alone).

**Round-3 update (2026-09-08): the basename+dirname pair was replaced outright
with an identity check, per round-2 review.** The two-condition guard proved
*containment* (resolved path is a direct child of root) but not *identity*
(the resolved path is the child literally NAMED `id`) — on Windows, an 8.3
short name (`PROP_A~1`), a case-only variant, and the NTFS
`<id>::$INDEX_ALLOCATION` stream form all pass both conditions while deleting
a DIFFERENT real directory than the one `id` names. Fix: keep
`basename(id) !== id` as a cheap pre-reject (still needed — it alone blocks
`.`/`..`/separators before ever touching the filesystem), then replace the
`dirname` check with `fs.readdirSync(root).includes(id)`. A literal directory
listing entry is a direct child by construction, so identity subsumes
containment in one check, and it kills every present and future alias on any
platform, not just the two forms the security review happened to try. Handle
a missing/unreadable `root` by returning "nothing to remove" (never throw)
rather than letting `readdirSync` itself become a new way to fail an
otherwise-successful delete.

**Round-3 update, ambiguous `listingUrls` ref (2026-09-08):** widening
resolution to `listing_url = ? OR alt_listing_url = ?` (round-1 finding E) was
read with `.get()`, so a URL matching two different rows (one exactly by
`listing_url`, another only via a stale `alt_listing_url`) let SQLite's scan
order pick the victim — deletes a property the caller did not name, and a
different one on every identical re-send, defeating the whole idempotent-resend
contract. Fixed by reading with `.all()` and resolving deterministically: an
exact `listing_url` match always wins (that column is UNIQUE, so at most one
row can have it) regardless of how many other rows match via `alt_listing_url`;
otherwise a lone match is used as-is; two or more matches with no exact one
among them is refused outright (nothing deleted, one `errors` entry naming the
ref) rather than guessed. Built the colliding DB state for the test using only
the app's own `/api/batch` `properties` path (a cross-source twin-merge attaches
an alt URL, then a later address-less partial refresh of that same URL misses
the twin match and inserts a second row whose OWN `listing_url` is that URL) —
matches how the round-2 security/technical review lanes reproduced it, so the
test proves the real-world path, not just a hand-crafted SQL fixture.

**Test technique confirmed working:** to force an `fs.rmSync` failure in a
`tsx`-run test without a mocking library, patch the property on the *default*
import object: `const fsMod = (await import("node:fs")).default; const orig =
fsMod.rmSync; fsMod.rmSync = (...) => { throw ... }`. The plain namespace
import (`await import("node:fs")` without `.default`) is a frozen ESM module
object and throws `Cannot assign to read only property`; the default-export
object is the same mutable object every `import fs from "node:fs"` in the
codebase references via property lookup (`fs.rmSync(...)`, not destructured),
so the patch is observed everywhere. Restore in a `finally` immediately after
the one call under test.
