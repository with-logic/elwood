/** Guards the AI Review workflow trigger against re-acquiring a base-branch filter (§16). */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { fileURLToPath } from "node:url";

const workflow = readFileSync(
  fileURLToPath(new URL("../../../.github/workflows/claude.yml", import.meta.url)),
  "utf8",
);

test("C-REVIEW-05 the pull_request trigger does not filter by base branch", () => {
  // GitHub applies a `branches:` filter BEFORE the job runs, so a filter here drops the
  // event for a stacked PR and `eligible()` never gets to judge it — the PR receives no
  // automatic review at all, silently. The repository boundary belongs in `policy.mjs`,
  // which checks that head and base are both in this repository; it cannot be expressed
  // as a branch-name filter.
  const trigger = /\n {2}pull_request:\n((?: {4}.*\n|\n)*)/u.exec(workflow);
  assert.ok(trigger, "the workflow must keep a pull_request trigger");
  assert.match(trigger[1], /types: \[opened, ready_for_review\]/u);
  assert.doesNotMatch(trigger[1], /branches(-ignore)?:/u);
});
