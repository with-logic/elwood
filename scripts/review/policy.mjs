/** Maintainer-only eligibility and deterministic verdicts for the PR review workflow. */
export function eligible(pr, repository, permission) {
  return (
    pr.state === "open" &&
    !pr.draft &&
    pr.base.ref === "main" &&
    pr.head.repo?.full_name === repository &&
    ["write", "maintain", "admin"].includes(permission)
  );
}

export function verdict(body, complete) {
  if (!complete) return "COMMENT";
  // Finding headings must agree with a verdict claiming zero blockers and majors.
  const blockingFinding = /^ {0,3}####[\t ]+(?:\*\*)?(?:blocker|major)\b/imu;
  if (blockingFinding.test(body)) return "REQUEST_CHANGES";
  const lines = body.split(/\r?\n/u).filter((line) => /^verdict:/iu.test(line));
  if (lines.length !== 1) return "REQUEST_CHANGES";
  const clean = /^Verdict: clean, no notes$/iu;
  const counts =
    /^Verdict: not ready [-—] 0 blocker\(s\), 0 major\(s\), \d+ minor\(s\), \d+ nit\(s\)$/iu;
  return clean.test(lines[0]) || counts.test(lines[0]) ? "APPROVE" : "REQUEST_CHANGES";
}
