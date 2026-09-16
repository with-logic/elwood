/** Exercises the automated review's trust and approval boundaries. */
import assert from "node:assert/strict";
import test from "node:test";
import { eligible, verdict } from "../policy.mjs";
import { findingFixture, reportFixture } from "./report-fixture.mjs";

const pr = {
  state: "open",
  draft: false,
  head: { repo: { full_name: "with-logic/elwood" } },
  base: { ref: "main" },
};

test("only open, ready maintainer PRs from the same repository are eligible", () => {
  assert.equal(eligible(pr, "with-logic/elwood", "write"), true);
  for (const permission of ["read", "triage", "none", undefined]) {
    assert.equal(eligible(pr, "with-logic/elwood", permission), false);
  }
  for (const patch of [
    { state: "closed" },
    { draft: true },
    { head: { repo: { full_name: "stranger/elwood" } } },
    { head: { repo: null } },
    { base: { ref: "other" } },
  ]) {
    assert.equal(eligible({ ...pr, ...patch }, "with-logic/elwood", "admin"), false);
  }
});

test("approval requires complete consistent evidence and a successful review run", () => {
  const clean = reportFixture();
  const minor = reportFixture(
    { "review-clarity": findingFixture() },
    "Verdict: not ready - 0 blocker(s), 0 major(s), 1 minor(s), 0 nit(s)",
  );
  for (const body of [
    clean,
    minor,
    minor.replace(
      "review-clarity: completed",
      "review-clarity: 1 retained finding; shared findings deduplicated",
    ),
  ]) {
    assert.equal(verdict(body, true), "APPROVE");
    assert.equal(verdict(body, false), "COMMENT");
  }
  for (const body of [
    "",
    "# Review\nVerdict: clean, no notes\n",
    clean.replace("### review-security", "### review-unrelated"),
    clean.replace("### review-security", "### review-clarity"),
    clean.replace("- review-security: completed", ""),
    clean.replace("- review-security: completed", "- review-security: missing"),
    `${clean}- review-security: completed\n`,
    clean.replace("No findings.", "I did not finish"),
    `${clean}\nVerdict: clean, no notes`,
    clean + findingFixture("blocker"),
    findingFixture("major") + clean,
    minor.replace("1 minor(s)", "0 minor(s)"),
    reportFixture({ "review-security": findingFixture("blocker") }),
    reportFixture({ "review-security": findingFixture("major") }),
    reportFixture({ "review-clarity": findingFixture() }),
    reportFixture({ "review-clarity": "#### minor: Missing evidence" }),
  ])
    assert.equal(verdict(body, true), "REQUEST_CHANGES", body);
});
