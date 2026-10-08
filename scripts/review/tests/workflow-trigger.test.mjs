/** Checks the active shared review triggers and stacked-PR eligibility (§16). */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { fileURLToPath } from "node:url";

const workflow = readFileSync(
  fileURLToPath(new URL("../../../.github/workflows/code-review.yml", import.meta.url)),
  "utf8",
);

test("C-REVIEW-05 the pull_request trigger does not filter by base branch", () => {
  // GitHub applies a `branches:` filter BEFORE the job runs, so a filter here drops the
  // event for a stacked PR and `eligible()` never gets to judge it — the PR receives no
  // automatic review at all, silently. The repository boundary belongs in the live authorization gate,
  // which checks that head and base are both in this repository; it cannot be expressed
  // as a branch-name filter.
  const trigger = /\n {2}pull_request:\n((?: {4}.*\n|\n)*)/u.exec(workflow);
  assert.ok(trigger, "the workflow must keep a pull_request trigger");
  assert.match(trigger[1], /types: \[opened\]/u);
  assert.doesNotMatch(trigger[1], /branches(-ignore)?:/u);
});

test("C-REVIEW-01 pushes and ready transitions do not repeat automatic review", () => {
  assert.doesNotMatch(workflow, /synchronize|ready_for_review|reopened/u);
  assert.doesNotMatch(workflow, /pull_request_target:/u);
});

test("C-REVIEW-03 only a new exact standard command requests review", () => {
  assert.match(workflow, /issue_comment:\n {4}types: \[created\]/u);
  assert.match(workflow, /github\.event\.comment\.body == '\/review'/u);
  assert.doesNotMatch(workflow, /workflow_dispatch:|\/elwood review/u);
});
