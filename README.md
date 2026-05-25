# Elwood

Elwood is a spec-driven TypeScript library for wrapping interactive agentic CLI
tools in real PTY sessions. `PRD.md` is the source of truth for observable
behavior; implementation and tests derive from it.

## Development

```sh
bun install
bun run check
```

The full check runs TypeScript, Biome, the 200-line file limit check, and Bun
tests with 100% line and function coverage.

## Supported CLI Baselines

Elwood currently validates against Claude Code `2.1.144` or newer and Codex CLI
`0.124.0` or newer. By default an unparseable CLI version warns and continues;
pass `strictVersionCheck: true` to fail closed when the version cannot be
parsed.

## Local Test App

```sh
bun run dev:app -- --cwd /path/to/project
bun run dev:app -- --agent codex --cwd /path/to/project
bun run dev:app -- --cwd /path/to/project --resume <elwoodSessionId>
bun run dev:web
```

The terminal test app streams the selected agent's live PTY output to stdout,
logs hook/status/error events to stderr, and sends stdin chunks as prompts. Use
`/resize 120x40` on stdin to resize the underlying PTY during a run. Supported
agents are `claude` and `codex`; Claude remains the default.

`dev:web` starts a browser-based app at `http://localhost:4317` with xterm.js
rendering the selected agent on the left and Elwood hook/status logs on the
right.

## Unified Agent Loop

Claude and Codex expose the same basic control shape for parent apps that want
to send messages and render a live event log.

```ts
import { startCodex } from "elwood";

const session = await startCodex({ cwd: process.cwd() });

session.on("activity", (event) => {
  console.log(event.agent, event.kind, event.label, event.text ?? "");
});

await session.sendMessage("Search the web and summarize what changed.");
```

Use adapter-specific hook handlers when the parent app needs to approve, deny,
block, or otherwise control a specific agent hook. Use `activity` for the common
live observation stream.

## Working Model

- Update `PRD.md` first for behavior that a user, API consumer, or second
  implementation could observe.
- Implement the behavior in `src/`.
- Add or update tests in `tests/`.
- Run `bun run check` before review.
