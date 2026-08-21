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
