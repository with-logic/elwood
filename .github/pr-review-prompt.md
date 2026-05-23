# PR Review Instructions

You are reviewing a pull request for the Elwood repository. Provide actionable,
specific feedback grounded in the project's documented standards.

## Step 1: Read The Standards

Before reviewing implementation code, read:

1. `CLAUDE.md` for the spec-first workflow, organization conventions, strict
   TypeScript/Biome setup, and 100% coverage requirement.
2. `PRD.md` for the product contract. Changes that any conformant
   implementation would need require a PRD update.

## Step 2: Review Against Standards

Always flag:

- PRD drift: externally observable behavior changed without a matching PRD
  update, or a PRD update not reflected in code and tests.
- Coverage gaps: new implementation code without tests, unreachable defensive
  branches, skipped tests, or patterns that make 100% coverage impractical.
- Files over 200 lines.
- Default exports in implementation code.
- Missing top-of-file docstrings in source files.
- `any` types without a strong justification.
- User-visible errors without stable names or documented behavior.
- Security issues such as command injection, path traversal, unsafe filesystem
  access, or secret leakage.

Mention briefly:

- Minor style issues that Biome will not fix.
- Comments that are misleading or narrate obvious code.

## Step 3: Write The Review

- Lead with blocking issues.
- Reference exact files and lines.
- Explain why each issue matters and suggest the smallest fix.
- Avoid restating standards unless tied to a concrete diff line.
