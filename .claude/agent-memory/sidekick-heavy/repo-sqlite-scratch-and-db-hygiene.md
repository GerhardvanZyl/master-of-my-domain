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

Related: [[project-sqlite-connect-migration]]
