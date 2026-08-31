# Review conventions

Deviations examined in a review round and deliberately accepted. Anything recorded
here is never a finding again. Accumulates from triage decisions only — never
authored speculatively.

---

## `data/app.db` is modified by simply running the test suite

**Owning lane:** artifacts (also reachable from requirements)
**Recorded:** 2026-08-21, run `20260820-2043-feat-property-detail-and-map`

`src/db/client.ts` applies the DDL and `migrateColumns()` on **every connection
open**, and `DB_PATH` defaults to `./data/app.db`. `test/units.test.ts` does not
override `DB_PATH` or `DATA_DIR`, so `npm test` connects to the real, git-tracked
database. Any change that adds a column to `migrateColumns()` therefore causes
`npm test`, `npm run dev` and `npm run build` to retrofit that column into the
tracked 11.6MB binary.

**This is pre-existing and out of scope for a feature branch.** Do not raise it as
an introduced defect, and do not "fix" `client.ts` — the connect-time migration is
deliberate.

**What a run must do instead:** treat `data/app.db` as never-staged. Restore it
immediately before staging with:

```
rm -f data/app.db-wal data/app.db-shm && git checkout -- data/app.db
```

The WAL sidecars must go first, or SQLite replays the discarded writes back over the
restored file.

**Corollary for briefs:** a definition of done cannot contain both "`npm test` /
`npm run build` clean" and "`data/app.db` unmodified" — they are mutually exclusive.
The achievable wording is "`data/app.db` must not be STAGED OR COMMITTED; an
additive connect-time migration is expected whenever the app or suite is run and
must be reverted before commit."

---

## `src/db/queries/load.ts` is a binary file to git

**Owning lane:** any lane reading the diff
**Recorded:** 2026-08-21, run `20260820-2043-feat-property-detail-and-map`

The file contains 4 NUL bytes, used deliberately as a delimiter in a price-history
dedup key: `` `${r.date}\0${r.event}\0${r.priceDisplay}` ``. Git therefore reports
`Binary files ... differ` and a plain `git diff` shows **nothing** for it.

Review it with `git diff -a -- src/db/queries/load.ts`. A lane that runs a plain
`git diff` will silently review an empty change and report no findings — which reads
identically to a clean file.

Not a defect. NUL is a valid delimiter choice here precisely because it cannot occur
in the data being joined.

## Measure line length as UTF-8, not bytes

The 120-character limit is a MUST in the `coding-standards` skill (this repo has
no `.claude/standards.md`, so the baseline governs). This codebase uses
multi-byte characters liberally in UI copy — `—`, `²`, `…`, `≤`, `×` — and both
a byte count (`awk '{print length}'`, `wc -L`) and PowerShell's `Get-Content`
under the console's default encoding **inflate** those lines.

In one run this cost three separate mis-measurements of the same two lines:
124-129, 147, and 121/122, against a true length of 118 and 119.

Measure the way the compiler reads the file:

```bash
python -c "import io;print([len(l) for l in io.open('FILE',encoding='utf-8').read().split('\n')])"
```

or `[System.IO.File]::ReadAllText(...)` in PowerShell. Do not raise a
line-length finding from a count you have not taken this way.

Note that `src/components/VibesConfig.tsx` has pre-existing lines genuinely over
120 (the `stationExponent` hint is 145). Those are `stale` — not a licence for
new ones, and not a finding on a diff that does not touch them.

## `VibeConfig` changes need no migration

`VibeConfig` (`src/lib/vibes.ts`) is persisted as a **JSON blob**, not as
columns — in `localStorage` under `vibeConfig`, and in a server settings row
reached through `/api/config` and `src/db/queries/settings.ts`.

`parseVibeConfig` iterates `Object.keys(DEFAULT_VIBE_CONFIG)` and fills any
absent key from the default, dropping anything non-numeric or non-finite. So
**adding a field to `VibeConfig` requires no migration, no DDL change, and no
coordinated deploy**: every stored config picks up the new default on read, and
an older client silently ignores a key it does not know.

This is the premise that decides loop eligibility for a vibe-config change — it
is what keeps one out of the full `dev-loop`'s "a migration or schema changes"
gate — and it is not visible without reading the parser. Adding a field to
`VibeConfig` is not a schema change. Adding a *column* still is.

## `migrateColumns` is idempotent but NOT concurrency-safe

`migrateColumns` (`src/db/ddl.ts`) says "Idempotent; safe to run on every
connect". True **serially**. It is a check-then-act across processes with no
lock: it reads the column set once, then decides. Two processes that both read
before either writes will both decide to add, and the loser gets

```
SqliteError: duplicate column name: viewed
```

Next.js collects page data with parallel workers, so `npm run build` against an
**unmigrated** `data/app.db` can fail this way. Seen 2026-08-22 on
`/api/properties/[id]`, and once in the previous run.

Observed rate: **once in four cold builds** against an unmigrated DB — a genuine
timing race, not a deterministic failure. Do not expect to reproduce it on
demand, and do not conclude from one green build that it is gone. A DB that is
already migrated cannot hit it at all, which is why the first build after a
restore is the risky one.

The transaction wrapper means the loser fails cleanly rather than half-applying,
so there is no data-loss path. The symptom is a failed build or a failed
request, and **re-running succeeds** because the winner completed the migration.

Deploy consequence — **corrected 2026-08-23, after `df6ab73`.** This entry
originally said the DB tracked in git is unmigrated, so the first start on
`192.168.68.125` after a pull runs the migration. That is no longer how prod
works and following it would send you looking in the wrong place.

`docker-compose.yml` now bind-mounts `${LIVE_DATA:-../property-compare-data}`
— a directory **outside the repo** — at `/app/data`. Nothing `git pull` or
`git checkout` does can reach the live DB or images. Prod's database is a
persistent external volume and is already migrated.

The race still matters, and arguably more: it fires whenever a DB that is
behind the current schema is opened by several processes at once. That is now
a **fresh or empty mount** on first boot, or a restore from an older copy —
not a `git pull`. The repo's own `data/app.db` is a dev-box snapshot that runs
behind prod, and is still unmigrated, so a local `npm run build` remains the
easiest way to reproduce it.

The container logs the DB it opened and its row count on connect
(`[db] /app/data/app.db — 442 properties`). Check that line after any deploy
that touched the mount — an empty or wrongly-pointed mount otherwise looks
exactly like a working app with no properties yet.

## `git status` clean does NOT mean `data/app.db` is unmigrated

This one invalidates the obvious reading of the restore procedure above.

SQLite in WAL mode writes to `data/app.db-wal`, not to `data/app.db`. So a
process that migrates the DB can leave `git status` reporting **clean** while
every reader — including `PRAGMA table_info` — sees the migrated schema through
the WAL.

Consequences:

- Restoring must delete the sidecars *and* checkout the main file, in that
  order. `rm -f data/app.db-wal data/app.db-shm && git checkout -- data/app.db`.
  Deleting only the main file, or only the sidecars, leaves a mismatch.
- To inspect what is actually committed, extract it — `git show HEAD:data/app.db
  > /tmp/head.db` — and open that. Opening `data/app.db` in place reads the WAL
  and tells you about the working state, not the committed one.
- A clean `git status` is not evidence the DB was untouched by a command you
  just ran. Check for the sidecar files.

## `package.json`'s `test` line will always exceed 120 characters

It is a single JSON string value chaining every test file with `&&` — 535
characters as of 2026-08-22, and 494 before that. There is no line-continuation
inside a JSON string, so it cannot be wrapped, and every test added to this repo
has extended it in the same idiom.

Raised and correctly dropped by the Standards lane in run
`20260822-1105-fix-migration-race-and-tagselect-key`, which flagged it as the
one item where a reasonable reviewer could land the other way. Recorded so it is
not re-argued every time a test file is added: **adding a clause to that line is
never a line-length finding.** Splitting the runner into a script file would be
a real change with its own justification, not a style fix.

## The tree-snapshot integrity check always fails on `data/app.db`

**Owning lane:** none — this is the lead's Phase 3/4 procedure.
**Recorded:** 2026-08-23, run `20260823-1500-fix-pin-scale-and-pca-link`

`dev-loop`'s integrity check compares a content digest of the working tree taken
before reviewers spawn against one taken after they drain, to prove no reviewer
wrote to the code it was reviewing.

**It will fail every round in which any reviewer is given a validation command
to run.** `src/db/client.ts` applies `migrateColumns()` on every connection open
and `DB_PATH` defaults to `./data/app.db`, so `npm test` and `npm run build`
necessarily rewrite the tracked 11.6MB database — see the first entry in this
file. The digest cannot distinguish that from a reviewer editing source.

Observed: 4 lanes, all given `npm test` / `npm run build`, digest moved
`9a76841… -> cedc2fb…`, delta was exactly `data/app.db` and no source file.

**Procedure.** Do not skip the check, and do not exclude `data/app.db` from the
snapshot — a reviewer that corrupted the DB is worth knowing about. Instead,
when it fails:

1. `git diff --stat <before> <after>` — **name the changed files before
   concluding anything.**
2. If the only entry is `data/app.db`, restore it and retake the digest:
   `rm -f data/app.db-wal data/app.db-shm && git checkout -- data/app.db`
   The sidecars must go first, or SQLite replays the discarded writes back.
3. If it now matches the Phase 3 value, no source file moved and the findings
   stand. Record both digests in `triage.md`.
4. If **any** other path appears in step 1, or the digest still differs after
   the restore, follow the real recovery path in `tree-snapshot.md`.

The trap this entry exists to prevent is step 1 being skipped: a lead who
learns "the integrity check always fails on the DB" and stops reading the file
list will one day wave through a round where a reviewer really did edit source.
The failure is expected; **which files moved** is the thing that is never
assumed.

---

## The "one image per property per group" invariant has no owner at the write boundary

**Owning lane:** architecture (raised as `arch-002`)
**Recorded:** 2026-08-23, run `20260823-1800-fix-tagging-round-defects`

`addGroupMember` (`src/db/queries/tags.ts:203-216`) is `INSERT OR IGNORE` keyed on
`(group_id, image_id)`. It enforces image uniqueness and nothing else. The
per-property rule — one representative image per property per group, because the
rooms view renders one column per property — is therefore re-implemented
independently by every producer:

- `scripts/_group-topup.ts:20-29` — SQL `NOT IN`
- `scripts/_build-groups.ts:11-16,27-32` — an `already` set plus a `pickedProp` set
- `scripts/_groups-from-tags.mjs` — an `already` set read over HTTP

**This is examined and accepted, not an oversight.** Moving the invariant next to
`addGroupMember` would make the only writer of `similarity_group_members`
destructive — it would have to delete a property's other members before
inserting — and that writer is reachable from `POST /api/batch`, which is
**deliberately unauthenticated** on the LAN (`CLAUDE.md`: "a token here would
lock one of two doors"). Adding a delete path there is a security-posture
decision reserved for the user.

Do not raise the duplication as a finding while that constraint holds. If the
user later authorises a destructive write path, the invariant belongs in one
place and the three producers collapse to candidate selection.
## Scraper adapter tests use real captured payloads as golden fixtures

Recorded: 2026-08-31 (run `2026-08-31-rea-source`, Tests lane, rejected Major).

Adapter tests under `test/` assert against payloads captured from real listing
pages (`test/fixtures/*.json`), with exact expected values. A reviewer will
correctly observe that this couples the test to one capture and that a genuine
markup change breaks it. That is intended and is not a finding.

Rationale: the realestate.com.au adapter was completely non-functional from the
day it was written — it read a window global the site no longer populates — and
produced zero rows while its test passed, because that test used a hand-written
payload shaped like nothing the site serves. For a scraper, a test that keeps
passing when the upstream markup changes is worthless; the break *is* the
signal that a re-capture is due.

Synthetic payloads remain the right tool for logic variation (parsing branches,
edge cases, degradation paths) and adapters carry both. Do not raise fixture
coupling, "brittleness", or over-fitting against a golden capture again.
