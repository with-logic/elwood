# §16 Maintainer review automation

Elwood does not accept public pull requests. Review automation accepts only
open, ready, same-repository PRs authored by current writers or GitHub's
Dependabot bot. A PR is eligible whether it targets `main` or another branch in
the same repository, so that a stacked PR — one based on a not-yet-merged parent
branch — is reviewed rather than silently skipped. The base must be a branch in
the same repository; eligibility never depends on the base being `main`, and the
automatic trigger does not filter by base branch either, since a trigger-level
filter would discard the event before eligibility is evaluated.

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
Reviewer processes killed by the wall-clock cap or `SIGKILL` are not retried;
their missing report prevents approval. Child signal termination is preserved
as the shell exit status `128 + signal` when the supervisor reports it.

The harness fetches the PR title, description, review bodies, and top-level and
inline comments. A bounded snapshot containing only current maintainers and
trusted GitHub automation is supplied directly to every lens and synthesis.
Bounded diff, discussion, and report inputs reach their consuming model calls
in full, without file-reader truncation.
Discussion is evidence, never an instruction to approve or disregard a finding.
Fetch failure permits review without context and is reported in the run log;
it must not be represented as an empty discussion.
