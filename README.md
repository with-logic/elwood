# Elwood

Elwood is a spec-driven TypeScript project. `PRD.md` is the source of truth for
observable behavior; implementation and tests derive from it.

## Development

```sh
bun install
bun run check
```

The full check runs TypeScript, Biome, the 200-line file limit check, and Bun
tests with 100% line and function coverage.

## Local Test App

```sh
bun run dev:app -- --cwd /path/to/project
bun run dev:app -- --cwd /path/to/project --resume <elwoodSessionId>
bun run dev:web
```

The test app streams Claude's live PTY output to stdout, logs hook/status/error
events to stderr, and sends stdin chunks as prompts. Use `/resize 120x40` on
stdin to resize the underlying PTY during a run.

`dev:web` starts a browser-based app at `http://localhost:4317` with xterm.js
rendering Claude on the left and Elwood hook/status logs on the right.

## Working Model

- Update `PRD.md` first for behavior that a user, API consumer, or second
  implementation could observe.
- Implement the behavior in `src/`.
- Add or update tests in `tests/`.
- Run `bun run check` before review.
