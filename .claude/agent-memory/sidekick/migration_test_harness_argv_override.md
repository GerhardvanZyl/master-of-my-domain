---
name: migration_test_harness_argv_override
description: test/migration-concurrency.test.ts accepts an optional argv[2] path to an alternate ddl.ts module — use it instead of overwriting src/db/ddl.ts when proving a mutation
metadata:
  type: project
---

`test/migration-concurrency.test.ts`'s `main()` reads `process.argv[2]` as an
optional override path for the module under test (defaults to
`src/db/ddl.ts`). The child process dynamically imports whatever path is
passed via `tsx`, so a mutation copy for proving a fix/regression can live
anywhere on disk — `ddl.ts` has no relative imports (only a type-only import
of `better-sqlite3`), so a standalone copy works from any directory.

**Why:** a brief asked to "revert `.immediate()`" and "disable a guard" in a
scratch copy to prove test coverage, while leaving `src/db/ddl.ts` completely
untouched (a hard constraint — that file drew zero review findings and must
not move even transiently). Passing a mutated copy's path as argv[2] means the
real `ddl.ts` is never edited, so there's no revert step and no risk of
forgetting one.

**How to apply:** `npx tsx test/migration-concurrency.test.ts /path/to/mutated-ddl.ts`.
No need for the pre-built `.claude/review/runs/<run>/round-1/scratch` copy of
the whole project (that one may hold a stale/old-revision `ddl.ts` used for a
different demonstration — check its contents before trusting it, don't assume
it mirrors the current tree).

See also [[write_via_http_batch_only]] for the separate `data/app.db` restore
convention (`rm -f data/app.db-wal data/app.db-shm && git checkout -- data/app.db`),
which is unrelated but adjacent — running the full `npm test` suite (not just
this one file directly via tsx) touches the real tracked DB via `client.ts`'s
connect-time migration.
