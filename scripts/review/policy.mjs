/** Maintainer-only eligibility and deterministic verdicts for the PR review workflow. Implements PRD §16. */
import { reportCounts } from "./report.mjs";

export function eligible(pr, repository, permission) {
  return (
    pr.state === "open" &&
    !pr.draft &&
    // Any base branch IN THIS REPOSITORY, not just `main`, so a stacked PR based on a
    // not-yet-merged parent is reviewed instead of silently skipped (§16). Requiring
    // `main` made stacked PRs ineligible with no error: CI ran, no review ever appeared.
    // The security boundary is same-repository head AND base plus maintainer permission,
    // none of which the base branch name contributes to.
    pr.base.repo?.full_name === repository &&
    pr.head.repo?.full_name === repository &&
    ["write", "maintain", "admin"].includes(permission)
  );
}

export function verdict(body, complete) {
  if (!complete) return "COMMENT";
  const actual = reportCounts(body);
  if (!actual || actual.blocker || actual.major) return "REQUEST_CHANGES";
  const reportLines = body.split(/\r?\n/u);
  if (reportLines[0] !== "# Review" || !/^Verdict:/u.test(reportLines[1] ?? ""))
    return "REQUEST_CHANGES";
  const lines = body.split(/\r?\n/u).filter((line) => /^verdict:/iu.test(line));
  if (lines.length !== 1) return "REQUEST_CHANGES";
  if (/^Verdict: clean, no notes$/iu.test(lines[0])) {
    return actual.minor === 0 && actual.nit === 0 ? "APPROVE" : "REQUEST_CHANGES";
  }
  const counts =
    /^Verdict: (?:ready|not ready) [-—] (\d+) blocker\(s\), (\d+) major\(s\), (\d+) minor\(s\), (\d+) nit\(s\)$/iu.exec(
      lines[0],
    );
  return counts &&
    ["blocker", "major", "minor", "nit"].every(
      (severity, index) => actual[severity] === Number(counts[index + 1]),
    )
    ? "APPROVE"
    : "REQUEST_CHANGES";
}
