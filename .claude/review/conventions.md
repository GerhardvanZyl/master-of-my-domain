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

Deploy consequence: the DB tracked in git is unmigrated, so the first start on
`192.168.68.125` after a pull runs the migration. If that instance serves
concurrent traffic at startup, it can hit the same race. Re-run and it will be
fine.

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
