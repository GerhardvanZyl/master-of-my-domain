/**
 * scripts/_groups-from-tags.mjs's filterNewCandidates is the entire invariant
 * change 2 (per-property duplicate guard) adds (tests-003, round 1 of
 * 20260823-1800-fix-tagging-round-defects). Pure and side-effect-free, so
 * it's tested directly without the network harness the rest of scripts/
 * deliberately doesn't have.
 *
 * Was scripts/_group-guard.mjs, a sibling module that existed only to make
 * this importable around the script's unconditional main(); retired in round
 * 2 (arch-004) once the script gained the same isMain entrypoint guard
 * scripts/_tag-remote.ts already had, so the function is exported directly
 * from the script it belongs to.
 */
import assert from "node:assert";
import { filterNewCandidates } from "../scripts/_groups-from-tags.mjs";

const candidates = [{ pid: "pid-a" }, { pid: "pid-b" }, { pid: "pid-c" }];

assert.deepEqual(
  filterNewCandidates(candidates, new Set()),
  candidates,
  "an empty already-member set passes every candidate through",
);

assert.deepEqual(
  filterNewCandidates(candidates, new Set(["pid-b"])).map((c) => c.pid),
  ["pid-a", "pid-c"],
  "a pid present in the already-member set is excluded",
);

assert.deepEqual(
  filterNewCandidates(candidates, new Set(["pid-z"])),
  candidates,
  "a pid absent from the already-member set is kept",
);

console.log("✓ group-guard.test: all assertions passed");
