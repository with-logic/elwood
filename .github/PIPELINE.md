# Maintainer PR reviews

Elwood is public for use and forking under the MIT license. It does not accept
outside pull requests. GitHub's `pull_request_creation_policy` is set to
`collaborators_only`: only users with write, maintain, or admin access can open
PRs. Issues remain available for feedback; security reports follow `SECURITY.md`.

## Review pipeline

`workflows/claude.yml` replaces the former Claude Action with Slog's eleven-lens
OpenCode review approach, compared with Slog `origin/main` at `432a10c`.
The workflow runs automatically on PR creation or transition out of draft,
only until its first automated report. Pushes do not trigger another review.
To review again, a maintainer posts exactly `/elwood review` as a new PR comment
or dispatches **AI Review** with a PR number. Both explicit paths are repeatable
without a round limit, including after approval. Dispatch normally uses `main`;
maintainers may select their same-repository workflow branch for validation.

1. Check the live PR and its author's repository permission. Only ready PRs
   whose head and base are both in this repository qualify; the base may be any
   branch, so a stacked PR targeting a not-yet-merged parent is reviewed rather
   than silently skipped. GitHub's Dependabot is also allowed on
   same-repository branches. Public associations such as MEMBER do not grant
   eligibility. Forks are excluded.
2. Run all eleven vendored `review-*` skills as independent OpenCode processes,
   then synthesize their findings into `REVIEW.md`. OpenCode emits structured
   events; only the final completed assistant answer enters report validation,
   keeping progress narration out of the evidence. The named roster in
   `scripts/review/lenses.txt` must match the eleven skill directories exactly;
   missing or failed reports prevent approval. Empty failures
   are attempted at most three times; each process has a 25-minute CI cap
   (15 minutes for local defaults), with a 40-minute overall review deadline. Each report is limited to 65,536 bytes;
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
   reports qualify and use a `ready` verdict. All eleven dimension sections and coverage entries must exist,
   each finding must have its required
   fields, and the verdict counts must match the findings. The canonical verdict
   must be the second line, immediately after `# Review`. Other completed
   verdicts request changes unless the PR is already approved at publication;
   in that case, findings are comments that preserve the approval. Partial failed
   reviews are comments. No report means no review. Reports include the run link
   and `/elwood review` command. Failed or canceled
   authorized runs publish a notice if the reviewed PR is still current and
   eligible. The report remains available as a seven-day run artifact.

There are eleven dimensions: architecture/conventions, clarity, concurrency,
database/persistence, error handling, naming, observability, performance,
security, testing, and type safety. Elwood's database lens covers its filesystem
state, atomic updates, schema validation, and resume guarantees.

Explicit requests verify the requester's current write, maintain, or admin
permission separately from the PR author's eligibility. Bot comments, public
comments, edited comments, issue comments, and embedded commands do not qualify.
The authorized caller holds one concurrency group across the reusable
`review-run.yml` workflow, covering both model execution and publication.
Rejected comments cannot cancel an active review. A newer authorized request
may replace an active run, including its publisher.
Reviews never merge PRs or bypass required CI, signed commits, or branch
protections. Approval requirements remain enabled.

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
still reads complete review history: truncating it could hide a prior automated
report and repeat the automatic review.
Comments and reviews from users without current maintainer permission are
excluded.
If this fetch fails, review continues without discussion context.
The resulting snapshot is supplied directly to every lens and synthesis call.
The runner logs whether that context was supplied or unavailable.
Diffs, discussion, and lens reports are framed as text and delivered through
stdin. OpenCode's file-attachment reader truncates long lines and large files;
stdin preserves the complete inputs within the harness's byte budgets.
Only the final posting job receives
`pull-requests: write`, and it receives no provider key. Public comments cannot
trigger review execution. There is no general mention
handler and no `pull_request_target` execution of PR code. The PR comment trigger
becomes available after this workflow reaches the default branch.

Maintainers with write access remain trusted to change workflows. The harness
rejects changed environment-file paths (including deleted and renamed files)
before creating the review diff, then precomputes it with external diff
helpers and text conversion disabled,
rejects diffs above 262,144 bytes without truncation, and supplies it to each lens.
Before model execution, a non-following workspace walk rejects symlinks that
resolve outside the workspace or to environment files, including directory
aliases; unresolved links and loops are rejected. Model processes receive a runtime OpenCode configuration
that denies tools by default and allows only workspace read and glob.
Grep, skill execution, shell, web fetch/search, external-directory access, LSP,
edits, and delegation are denied. Lens instructions are read directly as files. Environment files remain excluded from reads except `*.env.example`.
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
on a separate process group with best-effort descendant cleanup. If the OS denies
a group signal, the directly owned child still gets a kill attempt, but descendants
may remain alive. Fixed cleanup diagnostics reach the workflow log through a supervisor-only
channel that model subprocesses do not inherit; model stderr stays private; a broken diagnostic sink cannot replace the process outcome. Invalid numeric settings
use their defaults; leading zeroes are interpreted as decimal.
