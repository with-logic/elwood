/** Exercises the automated review's trust and approval boundaries. */
import assert from "node:assert/strict";
import test from "node:test";
import { eligible, verdict } from "../policy.mjs";
import { findingFixture, reportFixture } from "./report-fixture.mjs";

const pr = {
  state: "open",
  draft: false,
  head: { repo: { full_name: "with-logic/elwood" } },
  base: { ref: "main", repo: { full_name: "with-logic/elwood" } },
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
    { base: { ref: "main", repo: { full_name: "stranger/elwood" } } },
    { base: { ref: "main", repo: null } },
  ]) {
    assert.equal(eligible({ ...pr, ...patch }, "with-logic/elwood", "admin"), false);
  }
});

test("C-REVIEW-05 a stacked PR based on a not-yet-merged branch is eligible", () => {
  // Regression: requiring `base.ref === "main"` made every stacked PR silently
  // ineligible — CI ran and no review was ever posted, with no error to notice.
  for (const ref of ["steve-log-1234", "fix/parent-branch", "release/2.0"]) {
    const stacked = { ...pr, base: { ref, repo: { full_name: "with-logic/elwood" } } };
    assert.equal(eligible(stacked, "with-logic/elwood", "write"), true);
  }
  // The boundary that replaced the branch-name check: the base must still be in THIS
  // repository. `main` never validated `base.repo` at all, so this also closes a gap.
  for (const repo of [{ full_name: "stranger/elwood" }, null, undefined]) {
    const foreign = { ...pr, base: { ref: "main", repo } };
    assert.equal(eligible(foreign, "with-logic/elwood", "admin"), false);
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
    minor.replace("Verdict: not ready", "Verdict: ready"),
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
    minor.replace("## Reviewer Coverage", "#### critical: Hidden concern\n\n## Reviewer Coverage"),
    minor.replace("- Fix cost: One line.", "- Fix cost: One line.\n#### Unknown malformed concern"),
    `${minor}\n#### critical: Hidden after coverage`,
    clean.replace("### review-security", "### review-clarity"),
    clean.replace("- review-security: completed", ""),
    clean.replace("- review-security: completed", "- review-security: missing"),
    `${clean}- review-security: completed\n`,
    clean.replace("No findings.", "I did not finish"),
    `${clean.replace("Verdict: clean, no notes\n", "")}\nVerdict: clean, no notes\n`,
    `${clean.replace("Verdict: clean, no notes\n", "")}\n\`\`\`\nVerdict: clean, no notes\n\`\`\`\n`,
    clean.replace("# Review", "# Wrong report"),
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
