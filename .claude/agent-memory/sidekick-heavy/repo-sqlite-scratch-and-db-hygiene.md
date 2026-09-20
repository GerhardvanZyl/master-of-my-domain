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
- **`npm test` is a single `&&` chain and short-circuits, and there is NO test
  auto-discovery** — a new `test/*.test.ts` that is not appended to that chain
  in `package.json` silently never runs. (The `adapters.test.ts` fixture rot
  noted here previously was fixed; the whole chain was green on 2026-09-20.)
- **Spawning a `tsx` script in a test from a foreign cwd works** — set
  `TSX_TSCONFIG_PATH=<repo>/tsconfig.json` so `@/*` still resolves, and
  `DB_PATH`/`DATA_DIR` into the temp dir so the child gets a throwaway database
  and its relative `data/harvest/...` output lands in the temp dir instead of
  clobbering the operator's real report. Verified on tsx 4.23.
- **Quoted heredocs in the Bash tool still eat backslashes.** `<<'EOF'` did NOT
  preserve `\` inside a JS regex literal; the written file had `\` and node
  died with "Invalid regular expression". Use the Write/Edit tools for any file
  containing regex or escape sequences.

Related: [[project-sqlite-connect-migration]], [[project-twin-merge-convergence]]
