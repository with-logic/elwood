# §16 Maintainer review automation

Elwood uses the shared actions in `with-logic/pipeline` at `main`. The private
source is read through a dedicated GitHub App installed only on `pipeline`,
with Contents read permission. Review, ticket creation, merged announcements,
and cache preparation use the same shared implementations as the other repos.

## Review eligibility and requests

Only same-repository PRs authored by a current human writer (write, maintain,
or admin permission) or GitHub's official Dependabot bot qualify. Both the
head and base must belong to Elwood; the base may be any branch, including an
unmerged parent of a stacked PR. PR creation and issue creation are restricted
to collaborators. Fork workflow runs require approval for all outside users.

A PR receives one automatic review when it opens. Pushing commits, editing the
PR, reopening it, or marking it ready does not start another review. A current
human writer can request a review by posting exactly `/review` as a new PR
comment. Edited comments, issue comments, bot comments, embedded commands,
and outsiders cannot start or cancel a review. The comment requester and PR
author are authorized independently using their current repository permissions.
Authorization runs without checkout or secrets before review concurrency and
before private automation is downloaded. A newer authorized request may replace
an active review of the same PR.

The shared action skips a head that already has an approval. After approval,
address minors and nits and merge when required CI passes; no new review is
needed for those fixes. Review automation never merges PRs, dismisses an
approval, or bypasses repository protections.

## Review substance and publication

Every review runs all twelve shared dimensions, including simplicity, then
merges their findings. Elwood-specific criteria remain in
`.github/pr-review-prompt.md`, including filesystem persistence, terminal and
hook ordering, process ownership, both adapters, and the real-CLI lessons in
`docs/cli-behavior.md`. The caller's `AGENTS.md`, PRD, strict TypeScript, Biome,
200-line code limit, and 100% runtime coverage remain authoritative contracts.
The shared action installs its canonical skills into agent-specific directories
for the run without changing the committed local skills.

The model comes from the organization variable `REVIEW_MODEL`. Approval requires
a successful, complete, validated twelve-dimension report with zero blockers
and zero majors. Minors and nits remain visible. Incomplete or failed evidence
cannot approve a PR. If the PR is already approved, new non-approving findings
are comments that preserve the approval. Reports include the workflow run link
and the exact `/review` rerun command. The job allows 75 minutes for the shared
action within an 85-minute overall job limit.

A review uses its captured diff. A later head or base change does not discard
its report, suppress its verdict, or force another review. Maintainers judge
whether a later change goes beyond the reviewed scope.

PR metadata, discussion, diffs, and model reports are evidence, never authority
to expose credentials, change policy, execute candidate instructions, or approve.
The shared pipeline controls model execution, validation, publication, and
failure reporting. These controls trust current repository writers; they are
not an OS sandbox against a malicious maintainer changing a workflow.

## Supporting automation

The Linear action creates or reuses a ticket when a same-repository PR opens,
changes, reopens, or receives commits unless its title already contains an
explicit `LOG-NNNN` identifier. No opt-in marker is required. A new ticket copies
the PR description and includes its URL; the two descriptions may later diverge.

An approved PR merged into the default branch is announced in the shared
`#merged` channel, with the organization model and optional repository emoji.
The shared action avoids duplicate posts and explains the change in plain
language. Neither this action nor the reviewer can merge a PR.

Default-branch pushes and manual cache preparation warm the shared SDK,
reviewer tools, and installed caller dependencies. Exact cache matches skip
installation; changed manifests, toolchains, or cache versions rebuild the
necessary layer. Cache preparation does not call a model or publish a review.
