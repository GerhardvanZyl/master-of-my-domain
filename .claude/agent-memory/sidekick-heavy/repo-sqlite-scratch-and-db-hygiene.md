---
name: repo-sqlite-scratch-and-db-hygiene
description: Sharp edges when experimenting in this repo — scratch scripts, module resolution, CRLF, sed vs python line numbers, and data/app.db restore
metadata:
  type: project
---

Practical traps that cost time in this repo. All discovered by hitting them.

**Why:** several of them fail silently or produce a misleading error, so the
time is spent chasing the wrong thing.

**How to apply:**

- **Scratch scripts must live inside the repo.** `npx tsx /tmp/foo.ts` fails with
  `Cannot find module 'better-sqlite3'` — resolution is relative to the script,
  not the cwd. Put scratch in a repo subdir and delete it afterwards.
- **Name scratch files `.mts`, not `.ts`.** `tsconfig.json` includes `**/*.ts`,
  so a stray scratch `.ts` gets type-checked by `npx tsc --noEmit`. `.mts` is not
  matched by that glob, and `tsx` runs it fine.
- **Source files are CRLF with `core.autocrlf=true`.** Rewrite them with
  `newline="\r\n"` or the whole file shows as changed.
- **`sed -n 'N,Mp'` and Python's `split("\n")` disagree by one line here.** Anchor
  edits on file *content*, not line numbers.
- **`data/app.db` restore:** `rm -f data/app.db-wal data/app.db-shm && git checkout
  -- data/app.db`, sidecars first. `git checkout -- <file>` is a file restore, not
  a branch switch, so it is allowed even under a "no git checkout" constraint.
  Do the restore *last*, after the final `npm test` / `npm run build`, so the tree
  is left clean for the lead.
- **The committed `data/app.db` is genuinely unmigrated** (396 properties;
  `attended_at` present, `viewed`/`viewed_at`/`year_built` absent). Extract it with
  `git show HEAD:data/app.db > <tmp>/head.db` to test a migration against real
  data. The full migration takes **4ms** on it — 1250x inside the 5000ms
  `busy_timeout`.
- **There is no `npm run lint` script.** `npx tsc --noEmit` + `npm test` +
  `npm run build` is the whole gate.
- **A failing `next build` dumps ~2.2MB of `bundle5.js` source to stdout**, so
  the real error is invisible in a truncated read. Redirect to a file and check
  `$?` instead. The `WasmHash._updateWithBuffer` / "Cannot read properties of
  undefined (reading 'length')" crash is a stale `.next`, not your code:
  `rm -rf .next` and rebuild. Hit and cleared 2026-09-07.
- **Some test files leave an untracked `.next-test-*/types/` directory** behind
  (named by `test/ui.test.ts`). It shows up as `??` in `git status` and is a
  regenerable artifact — delete it before handing the tree back.
- **`npm test` is a single `&&` chain and short-circuits.** As of 2026-09-07
  `test/adapters.test.ts` fails on a rotted REA `nextInspection` fixture
  (`expected '2026-09-05T02:00:00.000Z', actual null`), so `npm test` never
  reaches the 24 files after it. Sweep them with
  `for f in test/*.test.ts; do npx tsx "$f"; done` instead, skipping
  `adapters.test.ts` and `ui.test.ts` (the latter drives real Chrome and is
  `npm run test:ui`, not part of `npm test`).

Related: [[project-sqlite-connect-migration]], [[project-twin-merge-convergence]]
