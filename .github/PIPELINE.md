# Maintainer PR reviews

Elwood is public for use and forking under the MIT license. It does not accept
outside pull requests. GitHub's `pull_request_creation_policy` is set to
`collaborators_only`: only users with write, maintain, or admin access can open
PRs. Issues remain available for feedback; security reports follow `SECURITY.md`.

## Review pipeline

`workflows/claude.yml` replaces the former Claude Action with Slog's eleven-lens
OpenCode review approach. The workflow runs on PR creation, reopening, new
commits, and transition out of draft. Maintainers can also dispatch **AI Review**
on `main` with a PR number.

1. Check the live PR and its author's repository permission. Only ready PRs
   from this repository into `main` qualify. GitHub's Dependabot is also allowed
   on same-repository branches. Public associations such as MEMBER do not grant
   eligibility. Forks are excluded.
2. Run all eleven vendored `review-*` skills as independent OpenCode processes,
   then synthesize their findings into `REVIEW.md`. The named roster in
   `scripts/review/lenses.txt` must match the eleven skill directories exactly;
   missing or failed reports prevent approval. Empty failures
   retry at most three times; each process has a 15-minute cap and the whole
   review has a 40-minute deadline. Each report is limited to 65,536 bytes;
   synthesis accepts at most 262,144 bytes of reports. Exceeding either limit
   prevents approval, without silently truncating findings. Failure logs contain
   phase, lens, failure category, exit status, and timing metadata rather than
   raw model output.
3. Transfer the report to a separate posting job. That job rechecks eligibility
   and both commit SHAs. A changed head or base discards the result. After posting,
   it checks again and dismisses its own actionable review if the PR changed
   during publication; a failed dismissal fails the job visibly. GitHub offers
   no atomic compare-and-post API.
4. Submit an approval only when the review job succeeded and the report is
   complete and consistent, with zero blockers and zero majors. Minor-only
   reports qualify. All eleven dimension sections and coverage entries must exist,
   each finding must have its required
   fields, and the verdict counts must match the findings. Other completed
   verdicts request changes; partial failed reviews are comments. No report
   means no review. The report remains available as a seven-day run artifact.

There are eleven dimensions: architecture/conventions, clarity, concurrency,
database/persistence, error handling, naming, observability, performance,
security, testing, and type safety. Elwood's database lens covers its filesystem
state, atomic updates, schema validation, and resume guarantees.

A current-commit automated approval skips duplicate work. Approvals dismissed
after a new push do not count as failed rounds. Four non-approving
rounds stop automation with a failed eligibility check and require a maintainer
review. Reviews never merge PRs or bypass the required CI checks, signed commits,
or branch protections. Approval requirements remain enabled.

## Credentials and permissions

The only provider secret is `OPENAI_API_KEY`, configured in both the Actions and
Dependabot secret stores. Dependabot-triggered runs read only the latter.
The default model and pinned CLI
match the Slog setup: `openai/gpt-5.6-luna` and OpenCode `1.18.16`.
The repository setting **Allow GitHub Actions to create and approve pull requests**
must be enabled; default workflow permissions stay read-only.

The review job has read-only GitHub permissions, does not persist checkout
credentials, and does not pass a GitHub token into model processes. A separate
step fetches PR discussion for context, keeping only current maintainers and
GitHub's Actions/Dependabot bots, including inline review threads.
Records retain source, time, URL, and reply identity and are ordered by time.
Optional discussion context retains at most the last three pages per source
(up to four requests including page discovery) and 65,536 serialized bytes.
Older records are omitted whole, with an explicit `truncated` flag. The gate
still reads complete review history: truncating it could hide a previous approval
or a failed round.
Comments and reviews from users without current maintainer permission are
excluded.
If this fetch fails, review continues without discussion context.
Only the final posting job receives
`pull-requests: write`, and it receives no provider key. There is no public
comment/mention trigger and no `pull_request_target` execution of PR code.

Maintainers with write access remain trusted to change workflows. The harness
precomputes a diff with external diff helpers and text conversion disabled and
attaches it to each lens. Model processes receive a runtime OpenCode configuration
that denies tools by default and allows only workspace read, glob, grep, and skill.
Shell, web fetch/search, external-directory access, LSP, edits, and delegation are
denied. Environment files remain excluded from reads except `*.env.example`.
There is no `--auto` tool approval. Models perform static review; required CI owns
executed checks. These are model tool restrictions, not an OS sandbox.
These controls exclude public contributors; they do not isolate malicious repository administrators.

## Local verification

```sh
node --test scripts/review/tests/*.test.mjs
python3 -m unittest discover -s scripts/review/tests -p '*_test.py' -v
```

Both commands also run in required CI. The runner tests use real temporary Git
repositories and a deterministic OpenCode substitute; they make no model calls.
To run a real local review, install OpenCode and ripgrep, export `OPENAI_API_KEY`,
and run `bash scripts/review/run.sh origin/main`. This overwrites local `REVIEW.md`
and uses provider quota. Optional `ELWOOD_REVIEW_MODEL`,
`ELWOOD_REVIEW_PROCESS_TIMEOUT_SECONDS` (each lens or synthesis process),
`ELWOOD_REVIEW_DEADLINE_SECONDS` (whole run), and `ELWOOD_REVIEW_LENS_ATTEMPTS`
(attempts per lens) configure that local run. Python 3 enforces each process cap
on a separate process group, including its descendants. Invalid numeric settings
use their defaults; leading zeroes are interpreted as decimal.
