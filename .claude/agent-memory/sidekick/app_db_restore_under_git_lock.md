---
name: app-db-restore-under-git-lock
description: how to restore data/app.db to HEAD when .git/index.lock is held by a concurrent agent, without touching the lock
metadata:
  type: project
---

Opening `data/app.db` even read-only (e.g. `new Database(..., {readonly:true})`
in a tsx script, or importing `src/db/client`) bumps the SQLite header's
file-change-counter bytes, so `data/app.db` shows as modified in `git status`
with identical byte length ("Bin N -> N bytes, 0 insertions/deletions"). The
documented restore recipe (`rm -f data/app.db-wal data/app.db-shm && git
checkout -- data/app.db`) needs `.git/index.lock`, which another concurrent
agent working in this same repo can be holding (this repo runs multiple
sidekicks in parallel — see [[ponytail_mode_convention]]). Do not remove
someone else's lock file.

Workaround that needs no lock: `git show HEAD:data/app.db > /tmp/copy.db`
(read-only, no lock) then `cp /tmp/copy.db data/app.db` (plain filesystem
copy, bypasses the git index entirely). Verify with `cmp` before and after.
`git status`/`git diff --stat` on the path afterward confirm clean once the
lock clears, but the file itself is already correct immediately.

**Why:** hard constraint in this repo is local `data/app.db` must never be
staged/committed; the standard fix command was blocked by another agent's
in-progress git operation and force-clearing a lock you don't own risks
corrupting their work. **How to apply:** any time a script that merely reads
`data/app.db` leaves it showing modified, and `.git/index.lock` exists, use
the `git show` + `cp` route instead of `git checkout`.
