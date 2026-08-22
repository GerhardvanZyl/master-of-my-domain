---
name: project-sqlite-connect-migration
description: How the connect-time SQLite migration in src/db/ddl.ts is guarded, and the non-obvious constraints any change to it must respect
metadata:
  type: project
---

`migrateColumns` (`src/db/ddl.ts`) is guarded by an unlocked pre-check plus
`db.transaction(...).immediate()` (BEGIN IMMEDIATE), not by a lock, a version
counter, or error swallowing.

**Why:** it runs on every connection open, and Next.js `next build` opens one
connection per parallel page-data worker. Against an unmigrated `data/app.db`
the old check-then-act shape failed roughly 1 round in 3 at 12-way concurrency
with `duplicate column name: viewed` / `no such column: "attended_at"`.

**How to apply:**

- `BEGIN` (deferred) does **not** fix it. A deferred transaction takes its read
  snapshot *before* the write lock, so both processes still read the stale
  column set. Only `BEGIN IMMEDIATE` takes the lock first. `busy_timeout` does
  not fix it either — the processes are not contending, they are acting on a
  stale read.
- The unlocked pre-check is load-bearing, not an optimisation. Measured: with
  another process holding a write transaction, the pre-check returns in **0ms**,
  while an unconditional `BEGIN IMMEDIATE` blocks the full busy_timeout and then
  throws `database is locked` — i.e. dropping the pre-check would turn every
  connect into a possible failure whenever `/api/ingest`, `/api/batch` or a load
  script holds a write.
- The pre-check is sound only because every step is monotonic: no column is ever
  dropped, and `attended_at` presence only decreases. Adding a migration step
  that can *undo* itself would break it.
- Adding a column means adding it to the `add` map inside `pendingMigrations`.
  Nothing else — the guard covers all five check-then-act sites uniformly.

Related: [[repo-sqlite-scratch-and-db-hygiene]]
