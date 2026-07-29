---
name: ponytail-mode-convention
description: master-of-my-domain repo uses a "ponytail mode" convention for deliberately-simplified code, and a file-ownership split between concurrent agents
metadata:
  type: project
---

In `E:\Projects 2024\master-of-my-domain`, briefs sometimes invoke "PONYTAIL
MODE" — laziest solution that works, no new npm deps, shortest diff, and every
deliberate simplification gets a `// ponytail: ...` comment explaining the
tradeoff (e.g. skipping a real currency-string parser in favor of a digit
regex when the dataset never uses k/m shorthand).

**Why:** the project owner runs multiple agents concurrently on this repo, each
scoped to an explicit file allowlist (e.g. "you own X, Y, Z; do NOT touch A, B,
C — another agent owns those and depends on/is depended on by your changes").
Briefs state what's "already done for you" by the other agent (schema columns,
API routes, query functions) — treat those as a fixed contract, don't
re-verify or reimplement them, just grep to confirm the named export/column
exists before using it.

**How to apply:** when a brief says ponytail mode is active, prefer inlining
logic in the one file that needs it over creating new shared helpers/files,
mark every shortcut with a `// ponytail:` comment, and respect the file
ownership boundaries literally — even a read-only edit to an out-of-scope file
should be avoided in favor of asking or working around it. See
[[hydration-safe-localstorage]] for the specific pattern used for client
components reading localStorage on this project.
