# Contributing

Thanks for helping with Elwood. This project is spec-first: `prd/` is the
contract for observable behavior, and `CLAUDE.md` (also linked as `AGENTS.md`)
is the implementation guide for anyone, human or AI, changing code. Read both
before opening a pull request.

## Requirements

- macOS (the only supported platform for v0.1; the unit suite also runs on
  Linux).
- Node.js 24 or newer. `.node-version` pins the major version for version
  managers.
- For end-to-end tests: an installed and authenticated Claude Code and/or
  Codex CLI.

## Setup and checks

```sh
npm install
npm run check
```

`npm run check` is the merge gate. It runs, in order:

1. `npm run build` (emits `dist/`, which the CLI tests and `npm link` need),
2. `tsc --noEmit`,
3. `biome check .`,
4. `scripts/check-lines.ts` (every code file at or below 200 lines),
5. `vitest run --coverage` with 100% line, branch, function, and statement
   coverage.

Useful narrower commands:

```sh
npm run typecheck
npm run lint            # or npm run lint:fix
npx vitest run tests/unit/some-file.test.ts
npm run test:e2e        # real Claude/Codex sessions; uses model quota
```

The e2e suite skips any test whose agent CLI is not installed. It starts real
sessions in temporary directories and answers workspace trust prompts for those
directories automatically.

## Making a change

1. If the change is observable by a user, an API consumer, or a second
   implementation (commands, flags, events, output shapes, config, state,
   errors, defaults, limits, security guarantees, conformance criteria), update
   `prd/` first.
2. Implement the smallest matching slice in `src/`.
3. Add or update tests in `tests/`. Conformance tests name their criterion in
   the title, for example `C-CLI-03 resume rejects --cwd`.
4. If the change is consumer-facing, add a bullet to `CHANGELOG.md` under
   `## [Unreleased]`.
5. If the real Claude or Codex CLI taught you something a unit test could not,
   record it in `docs/cli-behavior.md`.
6. Run `npm run check`.

## Pull requests

- Keep pull requests small and focused on one change.
- Do not include secrets, access tokens, credentials, or private data in
  issues, tests, logs, screenshots, or fixtures.
- Describe what changed and why. If the change touches readiness, turn
  detection, trust prompts, resume, or input paths, say how you verified it
  against the real CLI.

## Local test apps

Two maintainer tools exercise the library interactively:

```sh
# Terminal smoke app, Claude by default.
npm run dev:app -- --cwd /path/to/project
npm run dev:app -- --agent codex --cwd /path/to/project
npm run dev:app -- --cwd /path/to/project --resume <elwoodSessionId>

# Browser debugger on http://localhost:4317 with an xterm.js mirror and a
# structured event inspector.
npm run dev:web
```

They live under `src/app/` and are not part of the published package.

## Repository map

| Path | Purpose |
|---|---|
| `prd/` | Source of truth for behavior and conformance criteria (one file per section). |
| `src/index.ts` | Public package exports. |
| `src/core/` | Adapter-neutral session machinery: control queue, status detection, turns, loops, images, warnings. |
| `src/runtime/` | Shared session base class, startup checks, teardown, and test seams. |
| `src/claude/`, `src/codex/` | The two adapters: launch, hooks, transcripts, validation. |
| `src/cli/` | The `elwood` executable. |
| `src/state/` | Session records and private sidecar files. |
| `src/bridge/` | Local hook bridge server and generated bridge script. |
| `src/terminal/`, `src/pty/` | Headless xterm.js model and node-pty adapter. |
| `src/app/` | Local terminal and browser dev apps (not published). |
| `tests/` | Unit, conformance, and e2e suites. |
| `docs/` | Guides and the record of empirically learned CLI behavior. |
