<div align="center">
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="site/assets/landing/robot-mark-dark.webp" />
    <img src="site/assets/landing/robot-mark-light.webp" alt="" width="96" height="96" />
  </picture>
  <h1>Elwood</h1>
  <p><a href="https://elwood.bot">elwood.bot</a></p>
</div>

**Automate real Claude Code and Codex sessions in headless PTYs.**

Write scripts that control normal interactive Claude Code and Codex sessions,
which use your regular subscription rather than metered API billing. Elwood
starts the actual agent CLI in a hidden terminal and types into it the way you
would. The agent keeps its tools, hooks, configuration, and login.

```sh
npm install -g @with-logic/elwood
elwood "Explain this project's architecture."
```

```ts
import { ClaudeSession } from "@with-logic/elwood";

const session = new ClaudeSession({ cwd: "/path/to/project" });
console.log(await session.send("Explain this project."));
await session.close();
```

---

## Why Elwood

> **The agent should not know it is wrapped.**

Headless agent APIs give you a different product than the CLI your team
actually uses: different tools, different hooks, different billing. Elwood
drives the real interactive CLI instead. The process stays interactive, runs in
your normal shell environment, and is controlled through the hooks and
transcripts the CLI already provides.

- **Your subscription, not an API key.** It is the same interactive session you
  run by hand, so it bills the way that session already bills.
- **A small API over a real terminal.** `send()` returns a string. `stream()`
  yields typed events. The CLI keeps its own tools and history.
- **Typed activity, not screen scraping.** Assistant text, reasoning, tool
  calls and results, hooks, warnings, and lifecycle arrive as one event stream.
- **Two ways in.** A TypeScript library for applications, and an `elwood`
  command for shell scripts and pipelines.

[`prd/`](prd/README.md) is the source of truth for observable behavior. If this README, the
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

The package installs an `elwood` executable for the headless CLI. It ships a
prebuilt `dist/`, so a global install runs no build step and no install scripts
of its own. To work from a checkout instead, run
`npm install && npm run build && npm link`; the build is explicit because
`dist/` is not committed.

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

## Headless CLI

### Live terminal view

Add `--head` when you want to watch the real agent interface while retaining a
pipeline-friendly final result:

```sh
elwood --head "Run the test suite and fix the failure"
elwood --head --output json "Review this repository" >result.json
elwood --head --agent claude "Explain the architecture"
```

The display stays in the current terminal and receives the raw PTY byte stream on
stderr. It is a real VT/ANSI mirror, so full-screen layouts, cursor-addressed
updates, alternate-screen buffers, colors, spinners, and title changes render as
they do in the underlying Claude or Codex client. Stdout remains only the final
text or JSON protocol and can be redirected independently. Pending display work
is capped at 4 MiB or 1,024 frames; a terminal that remains backpressured fails
the run cleanly after draining accepted bytes instead of growing memory without
bound.

Head mode is deliberately view-only: while attached, ordinary keyboard, mouse,
paste, and terminal-response bytes are discarded; Ctrl-C still interrupts using
Elwood's normal first-interrupt/repeated-force-kill lifecycle. Terminal resizes
propagate to the agent. Elwood restores raw/cooked input state, mouse and paste
modes, attributes, cursor visibility, and the main screen before printing the
final result. Both stdin and stderr must be terminals, and `--head` cannot be
combined with `--stream`, `--verbose`, `--debug`, or `--output jsonl`.

### Continuation and cleanup

New runs are ephemeral unless `--keep` is supplied. A kept text run reports its
session ID on stderr; JSON and JSONL include it in the terminal record:

```sh
first=$(elwood --keep --output json "Remember that the release color is teal")
id=$(printf '%s' "$first" | jq -r .sessionId)
elwood --resume "$id" "What is the release color?"
elwood --resume "$id" --ephemeral "Finish this conversation"
```

Resume uses the exact stored agent and workspace; conflicting `--agent` and any
`--cwd` are rejected. Resumed sessions stay preserved after success or failure unless
`--ephemeral` requests teardown. Ephemeral teardown removes Elwood's session
record and loop definitions; it does not undo workspace changes or delete
conversation history owned by Claude or Codex. CLI state defaults to absolute
`$XDG_STATE_HOME/elwood` or `~/.local/state/elwood`; its private records contain
resume metadata, not ordinary prompts or output.

Before launching, `elwood config effective [run options]` prints the resolved
settings and where each came from. The JSON includes `head` and, for Claude,
the effective `permissionMode`, `allowedTools`, `disallowedTools`, and `tools`;
resume inspection reports persisted tool rules with stored-session provenance.

Exit status is `0` for success or a closed consumer, `1` for agent/runtime or
cleanup failure, `2` for usage/configuration failure, `124` for timeout, and
`130` for interruption. The first Ctrl-C requests a clean interrupt; a repeated
Ctrl-C force-kills before cleanup.

`--persona` runs an actual extra agent turn before the requested turn. Elwood
discards that setup turn's answer, but any tools it invokes or files it changes
remain. It is therefore supported only for new sessions, never `--resume`.

### Sessions, resume, and interactive mode

`elwood sessions` lists the Elwood-owned session records in the effective state
directory without starting an agent, and `elwood resume <id>` is the subcommand
form of `--resume <id>`:

```sh
elwood sessions
elwood sessions --state-dir ./state --output json | jq -r '.sessions[] | .id'
elwood resume "$id" "What is the release color?"
git diff | elwood resume "$id" --ephemeral "Does this diff match what we agreed?"
```

The table (or the `sessions` array in JSON) reports each session's id, agent,
workspace, `createdAt`/`lastUsedAt` timestamps, whether it is `resumable`
(the agent's own conversation id is stored), and `live` — whether a launch's
bridge socket file is currently present. `live` is a cheap file-presence
signal: a socket left behind by a force-killed owner reads as live until that
session is next started or torn down. Unreadable records are skipped with a
stderr warning, and an empty state directory is a normal empty result.
`resume <id>` follows every `--resume` rule: stored agent and workspace, no
`--cwd`, no `--keep`, no persona, and piped stdin composes the same way.

`elwood interactive [id]` opens the real `claude` or `codex` TUI in the current
terminal — no hidden PTY, no automation, no observation, no Elwood state — with
Elwood's resolved agent, model, reasoning effort, workspace, and posture passed
as the agent's own flags. It exits with the agent's exit status and needs a
terminal on stdin and stdout:

```sh
elwood interactive                      # the configured agent, its own defaults
elwood interactive --agent claude --model opus --claude-permission-mode plan
elwood interactive "$id"                # the stored conversation, workspace, and posture
```

Built-in headless posture defaults (Claude `dontAsk`, Codex `workspace-write`
and `never`) are not applied unless a flag, environment variable, config key,
or stored record selected them, so an unconfigured launch is the agent's own
default experience. A session kept by a headless run does store its headless
posture; pass `--claude-permission-mode default` (or the Codex flags) to get the
agent's prompts back when resuming one interactively. Because the agent owns
the resumed conversation, a later `elwood resume <id>` sees what you said. The
command rejects `--output json|jsonl`, `--stream`, `--verbose`, `--debug`,
`--head`, `--timeout`, `--persona`, `--image`, `--keep`, `--ephemeral`, and
`--resume`.

### Listing models

`elwood models` starts the selected agent briefly, opens and cancels its own
model picker, tears the session down, and prints the rows. Text marks the
current model with `*` and the default with `(default)`; JSON is one
`{"schemaVersion":1,"type":"models",...}` document of `AgentModelOption` rows:

```sh
elwood models
elwood models --agent claude --output json | jq -r '.models[] | select(.isCurrent) | .id'
```

Starting the agent is unavoidable because the picker is the only source of the
list. The command honors `--agent`, `--cwd`, `--model`, `--reasoning-effort`,
`--timeout`, `--state-dir`, trust, and posture flags, leaves no Elwood state
behind, and maps failures (timeout, interruption, blocked prompts) to the usual
statuses and error documents.

### Trust and security

Headless mode is non-interactive. With the default `--trust`, Elwood answers only
its allowlisted workspace-directory and extension trust dialogs (plus the
Elwood-owned Codex hook trust needed for operation). `--no-trust` disables the
workspace/extension approvals. Any other recognized dialog fails safely as
`blocked_prompt` instead of hanging or guessing.

Piped text and image paths are prompt input with the same authority as text typed
by the caller. Do not combine untrusted input with broad filesystem permissions.
Global config is never loaded from the repository being opened.

Head mode renders agent-controlled terminal escape sequences verbatim, just as
running the selected interactive CLI directly would. Use it only with agents and
workspaces you trust to control the current terminal display.

## Try It Locally

Elwood includes two local test apps.

```sh
# Terminal smoke app, Claude by default.
npm run dev:app -- --cwd /path/to/project

# Terminal smoke app with Codex.
npm run dev:app -- --agent codex --cwd /path/to/project

# Resume from Elwood metadata.
npm run dev:app -- --cwd /path/to/project --resume <elwoodSessionId>

# Browser debugger with xterm.js terminal mirror and structured event inspector.
npm run dev:web
```

`dev:web` serves `http://localhost:4317`. It shows the live terminal on the left
and a structured event timeline on the right. Use it to inspect hooks,
activities, warnings, startup automation, status changes, and raw event payloads.

The script is still invoked through npm, but the browser dev server process runs
under Node so `node-pty` can own a real interactive PTY reliably.

## Runnable Examples

For the smallest real usage sample, run the minimal example. It constructs a
`CodexSession`, which starts Codex lazily on the first `send`, then makes two
ergonomic `send` calls — an initial prompt and a follow-up that refers back to it —
printing each assistant response, and closes the session:

```sh
npm run example:minimal
```

For a fuller sample with Claude/Codex selection, custom prompts, richer logging,
timeouts, and cleanup options, run `examples/full.ts`:

```sh
npm run example:full
npm run example:full -- --agent codex --cwd . --prompt "Summarize this repo in one paragraph."
```

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
- [prd/](prd/README.md): the behavior specification and conformance criteria.
- [CHANGELOG.md](CHANGELOG.md): consumer-facing changes.
- [site/](site/): the landing page and the generated documentation site.

## The website

[`site/`](site/) is the landing page and the generated documentation site,
deployed to Vercel from this repository and served at [elwood.bot](https://elwood.bot). It is a static site with no framework
and no build step: HTML, CSS, ES modules, and the robot's sprite sheets.

```sh
cd site && python3 -m http.server 8766 --bind 127.0.0.1
```

The documentation page is generated from Markdown sources in
[`site/docs/guide/`](site/docs/guide/) and reads the CLI's help text out of
`src/cli/help.ts`, so the published flag reference cannot drift from the code:

```sh
cd site
uv run scripts/build_docs.py        # regenerate guide/, llms.txt, llms-full.txt
python3 scripts/check_doc_examples.py   # typecheck every documented example
node --test tests/*.test.mjs        # the landing page's own tests
```

## License

MIT. See [LICENSE](LICENSE).

## Contributing

Setup, the merge gate, the e2e suite, the dev apps, and the repository map are
in [CONTRIBUTING.md](CONTRIBUTING.md). Report vulnerabilities privately as
described in [SECURITY.md](SECURITY.md).

---

<div align="center">
  Prompted with ❤️ by <a href="https://logic.inc">Logic, Inc</a> in Seattle, WA
  <img src="site/assets/landing/space-needle.svg" alt="" width="13" height="13" />
</div>
