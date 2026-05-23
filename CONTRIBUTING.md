# Contributing

This project uses a spec-first workflow.

## Before You Open a PR

- Keep PRs small and focused.
- Do not include secrets, access tokens, credentials, or private data in issues,
  tests, logs, screenshots, or fixtures.
- Read [CLAUDE.md](./CLAUDE.md) before changing implementation code.

## Spec-Visible Changes

Update `PRD.md` first if your change affects anything a user, API consumer, or
second implementation could observe, such as:

- Commands, flags, routes, APIs, events, or output shapes.
- Config, state, storage, schema, or persistence behavior.
- Error names, status codes, exit codes, or recovery behavior.
- Defaults, limits, precedence rules, permissions, or security guarantees.
- Conformance criteria.

After the PRD update, make the matching code and test changes in the same PR.

## Development Setup

```sh
bun install
bun run check
```

`bun run check` runs typecheck, Biome, the 200-line file limit check, and the
full test suite with 100% line and function coverage.
