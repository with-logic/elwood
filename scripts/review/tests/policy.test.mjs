/** Exercises the automated review's trust and approval boundaries. */
import assert from "node:assert/strict";
import test from "node:test";
import { eligible, verdict } from "../policy.mjs";

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

test("approval requires one exact clean verdict and a successful review run", () => {
  for (const line of [
    "Verdict: clean, no notes",
    "Verdict: not ready - 0 blocker(s), 0 major(s), 2 minor(s), 1 nit(s)",
  ]) {
    assert.equal(verdict(`# Review\n${line}\n`, true), "APPROVE");
    assert.equal(verdict(`# Review\n${line}\n`, false), "COMMENT");
  }
  for (const body of [
    "",
    "Verdict: clean-ish",
    "Verdict: clean, no notes\nVerdict: not ready - 1 blocker(s), 0 major(s), 0 minor(s), 0 nit(s)",
    "Verdict: not ready - 0 blocker(s), 3 major(s), 0 minor(s), 0 nit(s)",
    "Verdict: not ready - 10 blocker(s), 0 major(s), 0 minor(s), 0 nit(s)",
    "Verdict: not ready - incomplete review coverage (blocker)",
  ]) {
    assert.equal(verdict(body, true), "REQUEST_CHANGES");
  }
});

test("blocking finding headings override a contradictory approving verdict", () => {
  for (const line of [
    "Verdict: clean, no notes",
    "Verdict: not ready - 0 blocker(s), 0 major(s), 2 minor(s), 1 nit(s)",
  ]) {
    for (const heading of [
      "#### blocker: Exposed credential",
      "#### major: Authorization bypass",
      "  #### MAJOR: Authorization bypass",
      "#### **major**: Authorization bypass",
    ]) {
      const body = `# Review\n${line}\n\n## Findings By Dimension\n\n### review-security\n\n${heading}\n- Finding: A required security boundary is missing.\n`;
      assert.equal(verdict(body, true), "REQUEST_CHANGES", heading);
      assert.equal(verdict(body, false), "COMMENT", heading);
    }
  }
});

test("minor and nit finding headings still allow approval with zero blocking findings", () => {
  const body = `# Review
Verdict: not ready - 0 blocker(s), 0 major(s), 1 minor(s), 1 nit(s)

## Findings By Dimension

### review-clarity

#### minor: Explain the unusual branch
- Finding: The workaround needs a comment explaining the upstream bug.

#### nit: Fix a typo
- Finding: The comment misspells a word.
`;
  assert.equal(verdict(body, true), "APPROVE");
  assert.equal(verdict(body, false), "COMMENT");
});
