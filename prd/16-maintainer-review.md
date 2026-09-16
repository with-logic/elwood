# §16 Maintainer review automation

Elwood does not accept public pull requests. Review automation accepts only
open, ready, same-repository PRs into `main` authored by current writers or
GitHub's Dependabot bot.

A PR receives one automatic review when opened ready, or when first marked
ready. Once an automated report exists, later PR events do not repeat it.
Pushing commits does not start another review.

A current maintainer with write, maintain, or admin permission can request
another review by posting exactly `/elwood review` as a new PR comment, or by
dispatching the review workflow with a PR number. Explicit requests are
repeatable, including for an already-approved commit; there is no round limit.
Public comments, bot comments, edited comments, issue comments, and quoted or
embedded commands cannot trigger model execution or cancel an active review.
Authorization precedes review concurrency handling. A newer authorized request
may replace an active review of the same PR.

Every run evaluates the current PR head and base. Automatic approval requires
all eleven review dimensions, consistent validated evidence, no blocker or
major findings, and revalidation of eligibility and both commits at publication.
Review automation never merges a PR or bypasses repository protections.
If the PR is already approved when publication checks its review decision,
new findings that would request changes are posted as a comment, preserving
that approval. Reports link to the workflow run and the rerun command. Failed
or canceled authorized runs report their outcome on the still-current PR.
The workflow allows 25 minutes per reviewer process within a 40-minute overall
review deadline.
