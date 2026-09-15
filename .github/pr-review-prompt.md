# PR Review Instructions

You are reviewing a pull request for Elwood. Give specific, actionable feedback
grounded in the project's documented standards.

## Step 1: Read the standards

1. `CLAUDE.md` (also `AGENTS.md`) for the spec-first workflow, file
   organization, strict TypeScript and Biome setup, and the 100% coverage gate.
2. `prd/` for the behavior contract. Any change a second implementation
   would have to make requires a PRD update.
3. `CONTRIBUTING.md` for the merge gate (`npm run check`) and the e2e suite.
4. `docs/cli-behavior.md` if the diff touches readiness, turn detection, trust
   prompts, resume, or input paths. Those areas are verified against the real
   CLIs, not only by unit tests.

## Step 2: Review against the standards

Always flag:

- PRD drift: observable behavior changed without a matching PRD update, or a
  PRD update not reflected in code and tests.
- Coverage gaps: new code without tests, unreachable defensive branches,
  skipped tests, or patterns that make 100% coverage impractical.
- Files over 200 lines, default exports, or missing top-of-file docstrings.
- `any` without a strong justification.
- User-visible errors without stable names or documented behavior.
- Missing `CHANGELOG.md` entries for consumer-facing changes.
- Security issues: command injection, path traversal, unsafe filesystem
  access, secret leakage, or a prompt answered that should have blocked.

Mention briefly: minor style issues Biome will not fix, and comments that are
misleading or narrate obvious code.

## Step 3: Write the review

- Lead with blocking issues.
- Reference exact files and lines.
- Explain why each issue matters and suggest the smallest fix.
- Do not restate standards unless tied to a concrete diff line.

The review workflow's explicit trust boundary is documented in
`.github/PIPELINE.md`: current repository writers are trusted to change workflows,
while public PRs are disabled. Models do not receive a GitHub write token, and
model tool permissions are not an OS sandbox. Evaluate security findings against
those guarantees; still report a concrete credential leak or permission bypass.
