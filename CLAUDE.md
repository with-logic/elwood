# Elwood Contributor Guide

This file is the briefing for anyone, human or AI, working on Elwood. Read it
before making implementation changes.

Elwood is specified by `PRD.md`. The PRD is the contract; this document explains
how we implement it.

## Working Agreement: Specification Changes

If you are asked to make a change that is not specific to our implementation,
update `PRD.md` first.

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

Conformance tests should name the matching criterion ID in the test title, for
example `C-EXAMPLE-01 describes the initial project contract`.

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
- `useUnknownInCatchVariables`

If a new call site's types do not line up, fix the types or the design. Do not
paper over mismatches with `any`.

## Common Workflow

1. Update `PRD.md` for spec-visible behavior.
2. Implement the smallest matching slice in `src/`.
3. Add conformance tests in `tests/`.
4. Run `npm run check`.
