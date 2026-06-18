# Elwood

**A TypeScript library for controlling interactive agentic coding CLIs through real terminal sessions.**

Elwood starts tools like Claude Code and Codex exactly where they are designed to
run: inside an interactive PTY. Parent apps can send prompts and key presses,
render the live terminal stream, and observe a typed event stream for hooks,
tool calls, transcript activity, warnings, and lifecycle state.

The important constraint: the agent should not know it is wrapped. Elwood keeps
the process interactive, uses the user's normal shell environment, and treats
hooks/transcripts as the control and observability layer.

```ts
import { startCodex } from "elwood";

const session = await startCodex({ cwd: "/path/to/project" });

session.on("activity", (event) => {
  console.log(event.agent, event.kind, event.label, event.text ?? "");
});

await session.sendMessage("Inspect this repo and summarize the test strategy.");
```

`PRD.md` is the source of truth for observable behavior. If README, tests, or
implementation disagree with the PRD, the PRD wins.

---

## Why Elwood

Agentic CLIs are usually rich terminal apps. They use full-screen TUIs,
keyboard shortcuts, permission prompts, hook protocols, transcript files, and
tool-specific state. That makes simple `spawn()` wrappers brittle.

Elwood provides the adapter layer a parent app needs:

- **Real terminal execution.** Agents run in a PTY, not print mode, SDK mode, or
  a pipe-only subprocess.
- **Headless terminal model.** PTY output is rendered through headless xterm.js
  before Elwood inspects TUI state or startup prompts.
- **Typed hooks.** Claude and Codex hooks are exposed as strongly typed
  TypeScript handlers with runtime validation and fail-open behavior.
- **Unified activity stream.** Parent apps can subscribe to `activity` for the
  common "send message, watch what happened, send another message" loop.
- **Embeddable terminal stream.** Parent apps can render the same PTY output in
  their own xterm.js view when a user wants to see the underlying agent.
- **Session metadata.** Elwood stores the minimum metadata needed to resume or
  tear down an Elwood session without persisting prompts, terminal output, hook
  payloads, or transcript content.

The first supported adapters are Claude Code and Codex CLI. The API is designed
so additional agentic CLIs can join the same control model later.

## Status

Elwood is currently a local TypeScript library in active development. The package
is still `private: true` and `version: 0.0.0`; publishing and distribution are
not finalized yet.

Supported runtime target:

- macOS only for v0.1
- Bun for local development and tests
- Node-compatible APIs where required by native dependencies
- Claude Code `2.1.144+`
- Codex CLI `0.124.0+`

By default, an unparseable CLI version becomes a typed warning and startup
continues. Pass `strictVersionCheck: true` to fail closed.

## Install For Development

```sh
bun install
bun run check
```

`bun run check` runs the full quality gate:

- `tsc --noEmit`
- `biome check .`
- `scripts/check-lines.ts`
- `bun test` with 100% line and function coverage

Slow real-agent e2e tests are separate:

```sh
bun run test:e2e
```

`test:e2e` starts real local Claude/Codex CLI sessions when the matching CLI is
installed and authenticated. It can use network/model quota, so it is not part
of `bun run check`.

Source and test files under `src/`, `tests/`, and `scripts/` must stay at or
below 200 lines.

## Try It Locally

Elwood includes two local test apps.

```sh
# Terminal smoke app, Claude by default.
bun run dev:app -- --cwd /path/to/project

# Terminal smoke app with Codex.
bun run dev:app -- --agent codex --cwd /path/to/project

# Resume from Elwood metadata.
bun run dev:app -- --cwd /path/to/project --resume <elwoodSessionId>

# Browser debugger with xterm.js terminal mirror and structured event inspector.
bun run dev:web
```

`dev:web` serves `http://localhost:4317`. It shows the live terminal on the left
and a structured event timeline on the right. Use it to inspect hooks,
activities, warnings, startup automation, status changes, and raw event payloads.

The script is still invoked through Bun, but the browser dev server process runs
under Node so `node-pty` can own a real interactive PTY reliably.

## Quick Start: Claude

```ts
import { startClaude } from "elwood";

const claude = await startClaude({
  cwd: "/path/to/project",
  disallowedTools: ["AskUserQuestion"],
  autotrust: true,
  hooks: {
    PreToolUse(event) {
      if (event.tool_name === "Bash" && event.tool_input.command.includes("rm -rf")) {
        return {
          permissionDecision: "deny",
          permissionDecisionReason: "Dangerous shell command.",
        };
      }
      return undefined;
    },
    Stop(event) {
      if (event.last_assistant_message?.includes("tests are failing")) {
        return {
          decision: "block",
          reason: "Tests are still failing.",
          additionalContext: "Run the test suite and fix failures before stopping.",
        };
      }
      return undefined;
    },
  },
});

await claude.sendMessage("Implement the next PRD slice.");
```

Claude launches through the user's interactive login shell with generated
session-scoped settings passed via `--settings`. Elwood does not mutate
`.claude/settings.local.json` by default. `autotrust: true` lets embedded apps
answer Claude's workspace trust prompt through the PTY; leave it false when a
human should make that security decision.

## Quick Start: Codex

```ts
import { startCodex } from "elwood";

const codex = await startCodex({
  cwd: "/path/to/project",
  model: "gpt-5.3-codex",
  approvalPolicy: "never",
  autotrust: true,
  hooks: {
    PermissionRequest(event) {
      if (event.tool_name === "Bash") {
        return { behavior: "allow", message: "Approved by parent app policy." };
      }
      return { behavior: "deny", message: "Only Bash is allowed in this mode." };
    },
    Stop(event) {
      if (event.last_assistant_message?.includes("TODO")) {
        return { decision: "block", reason: "Do not stop with TODOs remaining." };
      }
      return undefined;
    },
  },
});

codex.on("codex:transcript", (event) => {
  console.log(event.summary.kind, event.summary.label, event.summary.text ?? "");
});

await codex.sendMessage("Search the web and compare the latest options.");
```

Codex uses session-scoped `-c` overrides for hooks. Elwood reserves
`features.hooks=true` and `hookTrust="trust-all"` because Elwood is not useful if
the bridge hooks do not run. If Codex still shows a hook-review prompt, Elwood
answers it through the PTY. `autotrust: true` lets embedded apps answer Codex's
directory trust prompt through the PTY; leave it false when a human should make
that security decision.

## Common Session API

Claude and Codex sessions intentionally share the same core control surface:

```ts
interface ElwoodLikeSession {
  readonly elwoodSessionId: string;
  readonly cwd: string;
  readonly status: "starting" | "running" | "ready" | "stopped" | "exited" | "killed" | "torn_down";
  readonly warnings: readonly ElwoodWarningEvent[];
  readonly terminal: ElwoodTerminal;

  sendPrompt(prompt: string): Promise<void>;
  sendMessage(message: string): Promise<void>;
  sendKeys(input: string | Uint8Array): Promise<void>;
  resize(size: { cols: number; rows: number }): Promise<void>;
  stop(): Promise<void>;
  kill(): Promise<void>;
  teardown(): Promise<void>;
}
```

Use `sendMessage` for the adapter-neutral chat-loop operation. In v0.1 it is a
strict alias for `sendPrompt`.

`sendPrompt` uses bracketed paste so multi-line text is submitted as one prompt.
It does not wait for `ready`; sending while the agent is busy writes to the
terminal immediately, like a human typing into the TUI.

`sendKeys` is the escape hatch. Strings flow through the headless xterm input
path. `Uint8Array` writes raw bytes to the PTY.

## Events

Subscribe with `session.on(eventName, handler)`. The most useful event for
parent apps is `activity`:

```ts
session.on("activity", (event) => {
  switch (event.kind) {
    case "assistant_message":
    case "reasoning":
    case "tool_call":
    case "tool_result":
    case "web_search":
      renderTimelineItem(event);
      break;
  }
});
```

Core event families:

| Event | Purpose |
|---|---|
| `activity` | Adapter-neutral live stream for messages, reasoning, tools, warnings, hooks, hook results, and lifecycle. |
| `hook` | Every parsed and validated adapter hook event. |
| `hook:<Name>` | Hook-specific handler registration with typed response guidance. |
| `hookError` | Handler timeout, thrown handler, invalid input, invalid response, or bridge error. Hooks fail open. |
| `warning` | Non-fatal environment issue, such as unparseable versions or Codex MCP startup warnings. |
| `terminal:data` | Raw PTY output for a visual terminal renderer. |
| `terminal:exit` | PTY process exit. |
| `status` | Session status change. |
| `codex:transcript` | Codex-only best-effort transcript observations for TUI-visible activity not covered by hooks. |

`activity` events include normalized fields for common timeline rendering:
`hookEventName`, `turnId`, `toolName`, `toolUseId`, `status`, `exitCode`,
`failedOpen`, and `transcriptPath` when Elwood can derive them. `raw` remains
available for deep inspection, but typical UI timelines should not need it.

Hook handlers should return `undefined` for "no decision". Empty objects are
invalid for Codex hook results and fail open with `hookError`.

## Resume And Teardown

Elwood stores per-session metadata under `<cwd>/.elwood` by default. Pass
`stateDir` to use a caller-managed location.

```ts
const session = await startClaude({ cwd });
persistInYourApp(session.elwoodSessionId);

const resumed = await resumeClaude({
  cwd,
  elwoodSessionId: loadFromYourApp(),
});
```

Resume uses Elwood metadata plus the underlying agent's own resume mechanism.
If the parent app resumes from a different process working directory, pass the
original `cwd` or the same explicit `stateDir`; id-only resume discovers the
project-local state store from the current process working directory.
If Elwood never observed the adapter's internal session id, resume fails with
`resume_unavailable` instead of silently starting a fresh conversation.

`teardown()` removes Elwood-owned session files. It must not remove agent-owned
auth, global transcripts, user settings, or project settings.

## State, Privacy, And Safety

Elwood is deliberately live-first:

- It persists session metadata, adapter kind, resume ids, warnings, paths, and
  terminal size.
- It does not persist prompts, PTY output, hook payloads, hook responses, Codex
  transcript items, or derived prompt/tool content.
- Hook bridge messages are routed over local IPC with per-session tokens.
- Hook handling fails open by default so a parent-app bug does not deadlock the
  wrapped agent.
- Malformed state records fail with typed `state_corrupt` errors.

## Design Decisions That Reviewers Ask About

- **Claude tool flags:** Elwood uses documented camelCase
  `--allowedTools` / `--disallowedTools`. Current `claude --help` also shows
  kebab-case aliases, but the bundled docs and older references use camelCase.
- **Claude tool list encoding:** Elwood passes one comma-separated value because
  current `claude --help` documents comma or space-separated lists.
- **Codex hook enablement:** Elwood reserves `features.hooks=true` and
  `hookTrust="trust-all"` because the library is not useful unless hooks run.
- **Workspace trust:** `autotrust` is an explicit opt-in because answering
  Claude/Codex workspace trust prompts changes the security posture of the
  launched agent.
- **Codex `PermissionRequest`:** The wire response nests `{ behavior, message? }`
  under `hookSpecificOutput.decision`; `PreToolUse` uses direct event-specific
  fields. Elwood mirrors Codex's protocol rather than normalizing the wire shape.
- **Raw bytes:** `sendKeys(Uint8Array)` writes bytes to the PTY instead of
  decoding them as UTF-8.
- **Lifecycle:** `stop()` waits for a bounded graceful exit and escalates to
  force termination; `kill()` starts with force termination.

## Project Workflow

Elwood follows a spec-driven workflow:

1. Update `PRD.md` first for observable behavior.
2. Implement the behavior in `src/`.
3. Add or update tests in `tests/`.
4. Run `bun run check`.

Repository standards:

- 100% line and function coverage.
- Strict TypeScript.
- Biome linting/formatting.
- 200-line maximum for code/test/script files.
- Every source file starts with a top-of-file docstring.
- `AGENTS.md` is symlinked to `CLAUDE.md` so agent instructions stay single-source.

## Useful Files

| Path | Purpose |
|---|---|
| `PRD.md` | Source of truth for product/API behavior and conformance criteria. |
| `src/index.ts` | Public package exports. |
| `src/claude/` | Claude adapter, hooks, settings, validation, and session runtime. |
| `src/codex/` | Codex adapter, hooks, transcript watcher, validation, and session runtime. |
| `src/terminal/headless.ts` | Headless xterm.js model and PTY attachment. |
| `src/bridge/` | Local hook bridge server and generated bridge script. |
| `src/app/` | Local terminal and browser dev apps. |
| `docs/claude/` | Local Claude documentation snapshots used during implementation. |
| `docs/codex/` | Local Codex documentation notes used during implementation. |

## Current Limitations

- macOS-only support for v0.1.
- Packaging/publishing is not finalized.
- Codex transcript observation is best-effort because not every TUI-visible
  activity is exposed as a hook.
- Startup prompt automation is intentionally narrow: Elwood answers known Codex
  hook-trust and update prompts, and reports typed warnings where possible.
