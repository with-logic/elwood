# Elwood

Elwood is a TypeScript library and command-line tool for driving interactive
agentic coding CLIs through real terminal sessions. It starts tools like Claude
Code and Codex the way they are designed to run, inside an interactive PTY, and
lets a host application send prompts and key presses, render the live terminal,
and observe a typed event stream for hooks, tool calls, transcript activity,
warnings, and lifecycle state. The governing constraint is that the agent should
not know it is wrapped: the process stays interactive, runs in the user's normal
shell environment, and is controlled through the hooks and transcripts the CLI
already provides. The first supported adapters are Claude Code and Codex CLI.

`PRD.md` is the source of truth for observable behavior. If this README, the
tests, or the implementation disagree with the PRD, the PRD wins.

## Requirements

- macOS. Both adapters reject other platforms at startup with
  `unsupported_platform`.
- Node.js 24 or newer.
- Claude Code `2.1.144` or newer, and/or Codex CLI `0.124.0` or newer,
  installed and authenticated.

An unparseable CLI version becomes a `version_unparseable` warning and startup
continues. Pass `strictVersionCheck: true` to fail closed instead.

## Install

```sh
npm install @with-logic/elwood
```

The package installs an `elwood` executable for the headless CLI. To work from a
checkout instead, run `npm install && npm run build && npm link`.

## Quickstart: library

```ts
import { ClaudeSession } from "@with-logic/elwood";

// Construct synchronously; the session starts lazily on the first turn.
const session = new ClaudeSession({ cwd: "/path/to/project", autotrust: true });

// `send` returns the assistant's reply as a string; a follow-up keeps context.
const summary = await session.send("Summarize this repo's test strategy in two sentences.");
const risks = await session.send("Now list the biggest gaps you'd address first.");

// `stream` yields typed events as they happen.
for await (const event of session.stream("Run the test suite and report failures.")) {
  if (event.type === "text") process.stdout.write(event.text);
  // event.type is also "thinking" | "tool_call" | "tool_result"
}

await session.close();
```

`CodexSession` has the same shape. `autotrust: true` lets Elwood answer the
CLI's workspace trust prompt for `cwd` on your behalf; leave it off when a human
should make that decision. There is no default turn timeout; pass
`send(prompt, { timeoutMs })` (a `TurnOptions` field) to bound one turn.

## Quickstart: CLI

```sh
elwood "Summarize this repository"
git diff | elwood --agent claude "Review this diff for correctness"
elwood --output json "Run the tests and summarize failures" | jq -r .response
elwood --keep --output json "Remember that the release color is teal"
elwood --resume <sessionId> "What is the release color?"
```

When nothing selects an agent, Elwood tries `claude` and then `codex` in your
login shell and uses the first that resolves; if neither does, the run fails
with `no_agent_found`. See [docs/cli.md](docs/cli.md) for configuration,
output protocols, head mode, and continuation.

## Core concepts

**Sessions.** A session is one agent process in one PTY, identified by an
`elwoodSessionId`. `ClaudeSession` / `CodexSession` add `send`, `stream`, and
`close` on top of the full control surface (`sendMessage`, `sendPrompt`,
`sendGuidance`, `sendKeys`, `interrupt`, `compact`, `listModels`, `setModel`,
loops, `waitForStatus`, `stop`, `kill`, `teardown`). The eager `startClaude` /
`startCodex` factories are deprecated but still available.

**Hooks.** Claude and Codex hook events are delivered to typed handlers you pass
at start. Elwood runs a local bridge that the CLI's hook scripts call over IPC
with a per-session token. Handlers can allow, deny, block a stop, or add
context; they fail open on error.

**Activity stream.** The `activity` event is one adapter-neutral timeline:
assistant messages, reasoning, tool calls and results, web searches, hooks,
warnings, and lifecycle. Most host UIs render this and nothing else.

**Terminal stream.** `terminal:data` carries the raw PTY bytes so a host can
mirror the agent in its own xterm. A late subscriber first receives up to
128 KB of replayed history as one chunk. `sendKeys(Uint8Array)` forwards a
user's keystrokes verbatim.

**Status lifecycle.** `status` moves through `starting`, `ready`, `running`,
and `blocked` (a dialog needs a human) and ends in `stopped`, `exited`,
`killed`, or `torn_down`. Every real turn is a `running` to `ready` beat.

**State directory.** Elwood keeps a minimal session record under
`<cwd>/.elwood` by default, or under an explicit `stateDir`. It holds what
resume needs and nothing else.

## Hooks and policy

Handlers return `undefined` for "no decision". Claude:

```ts
const claude = new ClaudeSession({
  cwd,
  autotrust: true,
  hooks: {
    PreToolUse(event) {
      if (event.tool_name === "Bash" && event.tool_input.command.includes("rm -rf")) {
        return { permissionDecision: "deny", permissionDecisionReason: "Dangerous shell command." };
      }
      return undefined;
    },
    Stop(event) {
      if (event.last_assistant_message?.includes("tests are failing")) {
        return { decision: "block", reason: "Tests are still failing." };
      }
      return undefined;
    },
  },
});
```

Codex:

```ts
const codex = new CodexSession({
  cwd,
  autotrust: true,
  approvalPolicy: "never",
  hooks: {
    PermissionRequest(event) {
      if (event.tool_name === "Bash") return { behavior: "allow", message: "Approved by policy." };
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
```

Hooks fail open: a handler that throws, times out, returns an invalid result,
or receives invalid input is reported as a `hookError` event and the agent
proceeds as if no handler ran. Empty objects are invalid Codex results and fail
open the same way.

## Events

Subscribe with `session.on(eventName, handler)`; `on` returns an unsubscribe
function and may be called before the session starts.

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

| Event | Purpose |
|---|---|
| `activity` | Adapter-neutral live stream for messages, reasoning, tools, warnings, hooks, hook results, and lifecycle. |
| `hook` | Every parsed and validated adapter hook event. |
| `hook:<Name>` | Hook-specific handler registration with typed response guidance. |
| `hookError` | Handler timeout, thrown handler, invalid input, invalid response, or bridge error. Hooks fail open. |
| `warning` | Non-fatal environment issue, such as an unparseable version or a failed autoupdate. |
| `loop` | Redacted lifecycle for persisted recurring prompts. |
| `terminal:data` | Raw PTY output for a visual terminal renderer. |
| `terminal:exit` | PTY process exit, emitted exactly once. |
| `status` | Session status change. |
| `codex:transcript` | Codex-only best-effort transcript observations not covered by hooks. |

`activity` events carry normalized fields for timeline rendering:
`hookEventName`, `turnId`, `toolName`, `toolUseId`, `toolInput`, `toolOutput`,
`status`, `exitCode`, `failedOpen`, and `transcriptPath` when Elwood can derive
them. `raw` is available for deep inspection.

## Resume and teardown

Persist two things: the `elwoodSessionId` and the `stateDir` it lives in. At
boot, let Elwood decide whether to resume:

```ts
import { startOrResumeClaude } from "@with-logic/elwood";

const { session, resumed } = await startOrResumeClaude({
  cwd,
  stateDir,
  elwoodSessionId: persisted?.elwoodSessionId,
  autotrust: true,
});
if (!resumed) persist({ elwoodSessionId: session.elwoodSessionId });
```

`startOrResumeClaude` / `startOrResumeCodex` fall back to a fresh start only on
`state_not_found`, `resume_unavailable` (the CLI never reported a conversation
id), or `adapter_mismatch`, and rethrow anything else. Resume restores the
persisted launch posture (permission mode and tool rules for Claude, sandbox
and approval policy for Codex); `model`, hooks, and trust options are per call.

`teardown()` removes only Elwood-owned files: the session record, loop sidecar,
generated settings, bridge script, and socket home. It never touches the agent
CLI's own auth, transcripts, or settings. `stop()` is graceful; `kill()` is
immediate; both are safe after the process has already exited.

## Security and privacy

- Elwood answers only a narrow allowlist of prompts: workspace trust (opt-in via
  `autotrust`), Codex hook-trust and update dialogs, and Claude's browser-tools
  onboarding. Any other dialog leaves the session `blocked` for a human; the
  CLI fails such runs as `blocked_prompt`.
- `--high-trust` (library `highTrust: true`) is the agent-neutral "never ask"
  switch: Claude `bypassPermissions`, or Codex `danger-full-access` with
  approval policy `never`. It removes the agent's own guardrails, so point it
  only at work you would let run unattended. Combining it with an explicit
  per-agent posture is a usage error rather than a silent override.
- `autotrust` changes the security posture of the launched agent. Point it only
  at directories you already trust. The standalone `listClaudeModels` /
  `listCodexModels` probes always start with `autotrust: true`.
- The persisted session record holds schema version, `elwoodSessionId`,
  adapter, `cwd`, and per-adapter resume state. Loop definitions are the only
  persisted prompt text, in an owner-only `0600` sidecar.
- Prompts, terminal output, hook payloads, hook responses, transcripts,
  warnings, bridge tokens, and socket paths are never persisted. Tokens are
  minted fresh on every start and never trusted from disk.
- Hook bridge traffic stays on local IPC with a per-session token and an 8 MiB
  request cap.
- Elwood does not modify the user's global agent configuration. Claude gets
  session-scoped `--settings`; Codex gets session-scoped `-c` overrides, and
  Elwood restores `config.toml` after `setModel`.
- Codex image attachment goes through the macOS clipboard; the injected image
  is briefly the clipboard's contents. See [docs/images.md](docs/images.md).
- `ClaudeSession.login()` drives `/login` with a human-supplied code and
  validates the URL and code it handles, but should only run at a genuine login
  prompt. See [docs/login-recovery.md](docs/login-recovery.md).
- CLI output excludes ANSI frames, hook payloads, screen contents, credentials,
  and stack traces. Head mode renders agent-controlled escape sequences
  verbatim, so use it only with agents and workspaces you trust.

## Limitations

- macOS only.
- Codex transcript observation is best-effort because not every TUI-visible
  activity is exposed as a hook.
- Codex subagent transcripts are not observed. A Codex `SubagentStop` still
  carries `agent_transcript_path`, so a host that wants those records reads the
  file itself. Claude subagent transcripts are observed.
- Model picker automation (`listModels` / `setModel`) is pinned to current CLI
  picker layouts; drift surfaces as `model_automation_failed`.
- The `/login` recovery flow needs a human to supply the authorization code.
- Screen matchers (trust prompts, update dialogs, login banners) are
  version-coupled to the CLIs; `docs/cli-behavior.md` records what has been
  verified against which versions.

## Documentation

- [docs/cli.md](docs/cli.md): the `elwood` command, configuration, head mode,
  continuation, and trust.
- [docs/cli-output.md](docs/cli-output.md): text, JSON, and JSONL output
  fields, exit codes, and shell recipes.
- [docs/api.md](docs/api.md): the low-level session API, send semantics,
  commands, and model listing.
- [docs/lifecycle.md](docs/lifecycle.md): event delivery guarantees, terminal
  size, and persisting/resuming.
- [docs/embedding.md](docs/embedding.md): wiring a session into a host
  application (Electron and similar).
- [docs/loops.md](docs/loops.md): recurring prompts and `/loop` parsing.
- [docs/images.md](docs/images.md): attaching images to a turn.
- [docs/login-recovery.md](docs/login-recovery.md): detecting and recovering an
  expired Claude login.
- [docs/design-notes.md](docs/design-notes.md): design decisions and the
  state, privacy, and safety model.
- [docs/cli-behavior.md](docs/cli-behavior.md): empirically verified real-CLI
  behavior that unit tests cannot catch.
- [docs/codex/](docs/codex/): short sourced notes on the Codex CLI, config,
  and hooks.
- [examples/README.md](examples/README.md): runnable minimal, streaming, and
  low-level examples.
- [PRD.md](PRD.md): the behavior specification and conformance criteria.
- [CHANGELOG.md](CHANGELOG.md): consumer-facing changes.

## License

MIT. See [LICENSE](LICENSE).

## Contributing

Setup, the merge gate, the e2e suite, the dev apps, and the repository map are
in [CONTRIBUTING.md](CONTRIBUTING.md). Report vulnerabilities privately as
described in [SECURITY.md](SECURITY.md).
