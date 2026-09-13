---
name: sqlite-transaction-atomicity-test-via-trigger
description: how to prove a better-sqlite3 sqlite.transaction() actually rolls back both statements, without adding a test seam to production code
metadata:
  type: feedback
---

To test that a multi-statement `sqlite.transaction(() => { stepA(); stepB(); })()`
really rolls back `stepA` when `stepB` fails (rather than trusting the cascade/
transaction blindly), force the failure with a `CREATE TEMP TRIGGER ... BEFORE
DELETE ON <table> WHEN OLD.id = '<id>' BEGIN SELECT RAISE(ABORT, 'msg'); END;`
targeted at one specific row, call the function, assert it throws, then assert
the earlier statement's effect (e.g. a detached FK column) is back to its
pre-transaction value. `DROP TRIGGER` afterward and re-run the same call to
prove it succeeds once unblocked.

**Why:** this was flagged as the hardest-to-test case in a batch-delete brief —
verifying atomicity without editing `deleteProperty` to add a test hook. A TEMP
TRIGGER is a pure SQLite object created from the test file itself; it needs no
production-code seam and better-sqlite3's `transaction()` wrapper rolls back on
any thrown error, including a `SqliteError` raised by a trigger.

**How to apply:** any time a brief asks to verify one-transaction atomicity in
this codebase (`src/db/queries/*.ts` all use `sqlite.transaction(...)()`), reach
for this pattern before saying the case can't be tested. Confirmed working on
`deletePropertyByRef`'s scrape_jobs-detach + property-DELETE pair
(2026-09-08): `RAISE(ABORT, ...)` on a `BEFORE DELETE` trigger threw a
`SqliteError` that propagated out of `deleteProperty`, and the earlier
`UPDATE scrape_jobs SET property_id = NULL` rolled back with it.
