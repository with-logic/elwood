# Shared repository automation

Elwood uses the private `with-logic/pipeline` source at `main` for code review,
Linear tickets, merged announcements, and cache preparation. Changes to the
shared implementation take effect on the next run. Elwood's library CI, site CI,
and release workflow keep their existing checks and publishing behavior.

## Trust boundary

PR creation and issue creation are limited to collaborators. All outside fork
workflow runs require approval. Review automation independently verifies the live
PR: head and base must both belong to this repository, and its author must be a
current human writer or GitHub's official Dependabot bot. Public association
labels are not authorization.

The review workflow checks this without checkout or secrets. A manual request
also checks the comment's current human writer separately. Only an authorized
request reaches the review concurrency group, so an outsider cannot cancel an
active review. Repository writers remain trusted to change workflows; model
permissions are not an OS sandbox against a malicious maintainer.

## Review

[`workflows/code-review.yml`](workflows/code-review.yml) reviews once when a PR
opens. It has no base-branch filter, so stacked PRs qualify. Pushes, ready
transitions, edits, and reopenings do not repeat review. A maintainer can post
exactly `/review` as a new PR comment. The comment trigger is available after
the workflow reaches the default branch.

The shared action runs twelve independent review lenses, validates their
reports, and merges the findings. An approved head is skipped. A complete
successful report with zero blockers and majors can approve; minors and nits
remain visible and may be fixed without another review. Existing approvals
are preserved. Review does not merge PRs or bypass CI and branch protection.
A later head or base change does not discard the captured report or its verdict.

Elwood's specialized lens criteria are preserved in
[`pr-review-prompt.md`](pr-review-prompt.md): private filesystem state, atomic
writes, resume compatibility, PTY lifecycle and hook ordering, typed warnings,
both adapters, and real-CLI evidence. `AGENTS.md`, `prd/`, and
`docs/cli-behavior.md` remain the caller contracts. The shared action installs
canonical skills in its temporary checkout, without changing the committed
local skills.

The review uses Node 24, matching `.node-version`, and `vars.REVIEW_MODEL`.
Default-branch pushes and manual runs of
[`workflows/warm-review-caches.yml`](workflows/warm-review-caches.yml) populate
exact shared SDK, OpenCode, ripgrep, and installed npm dependency caches. An
exact hit skips installation; changed manifests or toolchains rebuild only the
needed layer. Cache preparation makes no model calls or review posts.

## Linear and merged announcements

[`workflows/linear-ticket.yml`](workflows/linear-ticket.yml) creates or reuses a
Linear ticket on PR creation, edits, reopenings, and pushes when the title has
no explicit `LOG-NNNN` identifier. No opt-in marker is required. A new ticket
copies the PR description and includes its URL. Later edits need not stay in
sync. Runs for the same PR queue without canceling ticket creation.

[`workflows/pr-announcement.yml`](workflows/pr-announcement.yml) explains an
approved PR after it merges into the default branch. The shared action prevents
duplicate announcements and uses `vars.MERGED_CHANNEL_ID`,
`vars.NOTICE_MODEL`, and optional `vars.MERGED_REPOSITORY_EMOJI` for `#merged`.
No local Slack interaction is needed to operate these workflows.

## Credentials and permissions

The private source reader is a dedicated GitHub App installed only on
`with-logic/pipeline`, with Contents read permission. Its client ID is
`vars.PIPELINE_SOURCE_APP_CLIENT_ID`; its private key is
`secrets.PIPELINE_SOURCE_APP_PRIVATE_KEY`. The official token action issues a
short-lived token only to download the shared actions. Checkout does not persist
that token. A shared preparation helper adjusts nested action paths in the
downloaded copy so local composites resolve their shared runtime correctly.

Organization secrets `OPENAI_API_KEY`, `LINEAR_API_KEY`, and `SLACK_BOT_TOKEN`
provide only the respective service credentials. The source App key and provider
keys must exist in both Actions and Dependabot secret stores; Dependabot runs
read the latter. Model and channel variables are shared organization variables.
Public caches contain public tool and dependency files, never credentials or
private application packages. No private npm token is passed to these jobs.

Workflow defaults allow only Contents read. The review additionally receives
Pull requests write and Issues write to publish its result and manual-request
status. Linear receives Pull requests write to update the title. None receives
Contents write or merge authority. GitHub's setting allowing Actions to create
and approve pull requests must be enabled. No job uses `pull_request_target`.

## Local verification

The checked-in `scripts/review/`, `opencode.json`, and `.claude/skills/` remain
available as a separate eleven-lens local harness. They no longer implement
hosted review or its request/publication policy. Their deterministic regression
suite remains in CI alongside checks of the active shared workflow triggers:

```sh
node --test scripts/review/tests/*.test.mjs
python3 -m unittest discover -s scripts/review/tests -p '*_test.py' -v
```

These tests use local fixtures and fake OpenCode output; they make no model
calls. The shared implementation owns hosted reviewer regression coverage.
Real local `bash scripts/review/run.sh origin/main` uses provider quota and
is not part of these checks. It uses `REVIEW_MODEL`, with an optional explicit
`ELWOOD_REVIEW_MODEL` override and a GPT-6.1 Sol fallback for local use.
