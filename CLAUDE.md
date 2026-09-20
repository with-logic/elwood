# Elwood Contributor Guide

This file is the briefing for anyone, human or AI, working on Elwood. Read it
before making implementation changes.

Elwood is specified by the documents in `prd/` (start at `prd/README.md`).
The PRD is the contract; this document explains
how we implement it.

## Working Agreement: Specification Changes

If you are asked to make a change that is not specific to our implementation,
update `prd/` first.

Examples of what triggers a PRD update:

- A new user-visible command, flag, route, API, event, or output shape.
- A new error name or change to an exit/status code.
- A change to config, state, schema, persistence, or wire format.
- A change to defaults, limits, precedence rules, or security guarantees.
- A change that shifts any conformance criteria.

Examples of what does not need a PRD update:

- Internal refactors, file moves, or renamed internal functions.
- Test additions or helper tweaks.
- Dependency bumps that do not change behavior.
- Bug fixes that make behavior match the existing spec.
- Performance improvements within existing guarantees.

When in doubt: if an external observer or second implementation could notice the
change, update the PRD. After updating the PRD, update `src/` and `tests/` to
match. Do not leave a PRD change unimplemented across a commit.

## Runtime And Tooling

- Language: TypeScript, strict mode plus additional safety flags in
  `tsconfig.json`.
- Runtime: Node.js.
- Lint and format: Biome 2, configured in `biome.json`.
- Tests: Vitest, with 100% line, function, statement, and branch coverage
  required by the npm `test` script.
- File size: `npm run check:lines`, with every checked code file capped at 200
  lines.

## Organization Conventions

1. Keep files under 200 lines. Split early when a file starts collecting
   unrelated concerns; `npm run check:lines` enforces this for code files.
2. Group related files into directories instead of filename prefixes. Prefer
   `feature/index.ts`, `feature/render.ts`, and `feature/types.ts` over
   `feature-render.ts` and `feature-types.ts`.
3. Split static data from logic when tables, fixtures, or copy grow large.
4. Every source file opens with a docstring that says what the file does and
   which PRD section or conformance criterion it implements.
5. Use named exports only. Do not use default exports.
6. Keep public types `readonly` unless mutation is part of the contract.

## Testing Philosophy

Coverage is a hard requirement. `vitest run --coverage` exits non-zero when any
of line, function, statement, or branch coverage falls below 100%.

Write tests alongside code. If the code has a branch, write a test that takes
that branch. If a defensive branch genuinely cannot fire, delete it rather than
preserving dead code for coverage.

Prefer real behavior over broad mocks. Use real filesystems, parsers, and local
process boundaries unless a test seam exists for an expensive or platform-bound
dependency.

The full parallel suite is green and stays green. **Treat every failure as
real** — there is no known-flaky set to discount, and a habit of discounting
failures is how a genuine regression gets shipped. Before diagnosing one, check
two cheap things: that nothing else is loading the machine (these suites spawn
PTYs and processes, so a dozen concurrent runs will time each other out), and
that the branch is current, with `git merge-base --is-ancestor origin/main
origin/<branch>` — a branch behind `main` reproduces bugs `main` has already
fixed, and the symptom is identical to a new failure.

A gate that reports no test counts has not reported success. Exit 0 with no
summary means the run did not complete; concurrent runs sharing a coverage
directory do this. Read the numbers, not the exit code.

A bogus `--model` triggers a real rejection on both CLIs and is refused before
any model quota is consumed, which makes it a cheap, quota-independent way to
exercise failure paths end to end.

Conformance tests should name the matching criterion ID in the test title, for
example `C-EXAMPLE-01 describes the initial project contract`.

## Real CLI Behavior

Elwood drives the real Claude and Codex CLIs, which have undocumented,
version-coupled behaviors that a green unit suite at 100% coverage does not
catch. `docs/cli-behavior.md` records the ones we learned empirically — lazy
Codex hooks, resume readiness and the phantom-turn replay, the composer/dialog
caret collision, trust-prompt layout, paste sanitization, narrow-terminal footer
elision, and model-picker persistence. Read it before touching readiness,
turn-detection, trust, resume, or input paths, and add to it whenever the real
CLI teaches you something a unit test could not have.

## Lint And Type Rigor

Biome is the source of truth for formatting and linting. `npm run lint` checks
both.

TypeScript is configured beyond `strict: true` with flags such as:

- `exactOptionalPropertyTypes`
- `noUncheckedIndexedAccess`
- `noPropertyAccessFromIndexSignature`
- `noImplicitReturns`
- `noUnusedLocals`
- `noUnusedParameters`

If a new call site's types do not line up, fix the types or the design. Do not
paper over mismatches with `any`.

## Bugs Are Fixed, Not Filed

When you find a defect, fix it. Do not record it for later, and do not open a
GitHub issue for it — this project does not use issues as a backlog. If a fix
does not belong in the change you are working on, it becomes its own small PR,
not a note.

The only legitimate "not now" is real sequencing: the file is being rewritten by
another in-flight PR. That is a handoff with an owner and a landing place, never
an entry in a list.

## Pull Request Reviews

A review with zero blockers and zero majors is approval. After approval, address
that review's remaining minors and nits once, then merge when the required checks
pass. Do not request another review after that final cleanup.

Honor an earlier approval of substantially the same change. Dependency integration
and final cleanup do not erase it. Never dismiss an approval or restart review
because a later iteration is available.

Allow at most four review attempts for a scope that has not been approved. If it
still needs work after four attempts, stop that review loop and split or
substantially rescope the change before seeking further review. These limits do
not change the required technical checks.

**A finding may be declined only when it is wrong.** The single test is: is it
true?

- **Not true** — the reviewer misread the code, missed a guard that already
  handles the case, assumed a caller that does not exist, or described an
  unreachable path. Decline it and post the code or measurement that proves it.
  A demonstrated rebuttal is a good outcome.
- **True** — fix it in the appropriate scoped change, within the approval and
  review-attempt rules above.

"True, but not closable by the approach I chose" is not a decline. It means the
approach has to change.

Never rebut a finding on plausibility alone. Reproduce it, and A/B against
`origin/main` — not against your own HEAD, which already contains earlier
fixes and will make a good regression test look powerless.

### Size, and the split-then-rebase loop

Prefer changes under roughly 200 lines. Treat 500 changed lines as a strong soft
cap, not an absolute limit: keep a coherent fix together when splitting would
make its behavior incomplete. Split unrelated concerns before adding review
rounds.

Size never decides *whether* a true finding gets fixed — only *where*:

1. Fix it in its own small PR against `origin/main`.
2. Get that PR approved and merged.
3. Rebase the original onto the new `origin/main`.
4. For work without an approval, request review only within the four-attempt
   limit. For approved work, finish the last minors/nits once and merge after
   required checks; do not request another review.

Each pass leaves the original PR **smaller**. Absorbing fix after fix in place
does the opposite, and is how a change becomes unapprovable: one PR reached
+1782/−115 across 42 files and six rounds without approval that way, because no
single round could cover it all. One finding — or one tightly-coupled pair that
shares a test set — per PR.

Rebase promptly when a dependency lands. A stale base reproduces bugs that
`main` has already fixed, and those look exactly like new failures.

### Verifying a fix

Before trusting a new regression test, break the source deliberately: remove the
fix, confirm the test goes **red**, restore it, confirm **green**. A test that
passes either way proves nothing, and this codebase produces them readily —
several were caught only by this check, having bypassed the component under
test or used a single event where the behavior being tested could not apply.

## Common Workflow

1. Update `prd/` for spec-visible behavior.
2. Implement the smallest matching slice in `src/`.
3. Add conformance tests in `tests/`.
4. If the change is consumer-facing (public API, session/lifecycle behavior,
   activity/event shape, or a bug fix a parent app would notice), add a bullet to
   `CHANGELOG.md` under `## [Unreleased]`. Skip internal refactors and test-only
   changes — the changelog is what downstream consumers skim.
5. Run `npm run check`.
