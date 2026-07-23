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
- Node.js and npm for local development and tests
- Node-compatible APIs where required by native dependencies
- Claude Code `2.1.144+`
- Codex CLI `0.124.0+`

By default, an unparseable CLI version becomes a typed warning and startup
continues. Pass `strictVersionCheck: true` to fail closed.

## Install For Development

```sh
npm install
npm run check
```

`npm run check` runs the full quality gate:

- `tsc --noEmit`
- `biome check .`
- `scripts/check-lines.ts`
- `vitest run --coverage` with 100% line, function, statement, and branch coverage

Slow real-agent e2e tests are separate:

```sh
npm run test:e2e
```

`test:e2e` starts real local Claude/Codex CLI sessions when the matching CLI is
installed and authenticated. It can use network/model quota, so it is not part
of `npm run check`.

Source and test files under `src/`, `tests/`, and `scripts/` must stay at or
below 200 lines.

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

For the smallest real usage sample, run the minimal example. It starts Codex
headlessly, sends one message, logs structured activity, and exits:

```sh
npm run example:minimal
```

For a fuller sample with Claude/Codex selection, custom prompts, richer logging,
timeouts, and cleanup options, run `examples/full.ts`:

```sh
npm run example:full
npm run example:full -- --agent codex --cwd . --prompt "Summarize this repo in one paragraph."
```

The example package scripts use a small Node supervisor because `node-pty` owns
real PTYs more reliably there and the supervisor can kill the example process
tree on Ctrl-C. npm remains the project script runner. The examples import from
local source while the package is private; published consumers should import the
same symbols from `elwood`.

## Quick Start: Claude

```ts
import { startClaude } from "elwood";

const claude = await startClaude({
  cwd: "/path/to/project",
  disallowedTools: ["AskUserQuestion"],
  autotrust: true,
  persona: "You are a terse reviewer. Prefer diffs over prose.",
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
  readonly status: "starting" | "running" | "ready" | "blocked" | "stopped" | "exited" | "killed" | "torn_down";
  readonly warnings: readonly ElwoodWarningEvent[];
  readonly terminal: ElwoodTerminal;

  statusDecisions(): readonly ElwoodStatusDecision[];
  waitForStatus(match: (status: ElwoodSessionStatus) => boolean, timeoutMs?: number): Promise<ElwoodSessionStatus>;
  waitForActivity(match: (event: ElwoodActivityEvent) => boolean, timeoutMs?: number): Promise<ElwoodActivityEvent>;

  sendPrompt(prompt: string, options?: SendOptions): Promise<void>;
  sendMessage(message: string, options?: SendOptions): Promise<void>;
  sendGuidance(message: string, options?: SendOptions): Promise<void>;
  sendKeys(input: string | Uint8Array): Promise<void>;
  resize(size: { cols: number; rows: number }): Promise<void>;
  interrupt(options?: { readonly timeoutMs?: number }): Promise<void>;
  compact(options?: { readonly timeoutMs?: number }): Promise<void>;
  listModels(options?: { readonly timeoutMs?: number }): Promise<readonly AgentModelOption[]>;
  setModel(id: string, options?: { readonly timeoutMs?: number }): Promise<void>;
  stop(): Promise<void>;
  kill(): Promise<void>;
  teardown(): Promise<void>;
}
```

Use `sendMessage` for the adapter-neutral chat-loop operation. If the session is
ready, it writes immediately through the PTY. If the session is alive but busy,
Elwood queues it and submits it on the next `ready` transition.

`sendPrompt` uses bracketed paste so multi-line text is submitted as one prompt.
It does not wait for `ready`: the prompt bypasses readiness and dispatches as
soon as no other submission is in flight, like a human typing into the TUI. It
may overtake readiness-waiting messages, but never interleaves with an in-flight
paste/Enter sequence — that completes first.

Use `sendGuidance` when a coordinator needs to intervene in an active turn. It
queues safely before the session's first readiness and while a blocking dialog
is visible. After the session has been ready at least once, guidance sent while
`running` bypasses readiness and enters the TUI immediately. Guidance remains
serialized with queue-backed prompts, messages, and commands, and its promise
resolves only after the pasted text and submitting Enter have both been written.

### Attaching images

`sendPrompt`, `sendMessage`, and `sendGuidance` accept an optional `images` list
so a submission can carry image content alongside its text — the equivalent of
pasting or dragging an image into the CLI. It is an attached-content model, not
interleaving: images have no position within the text, but the list is ordered
(array order sets attachment/chip order). Elwood attaches them as part of the
same queued turn, before the text is submitted.

```ts
await session.sendMessage("What's wrong with this screenshot?", {
  images: [
    { path: "/abs/path/to/shot.png" },        // an existing image file
    { data: pngBytes, format: "png" },         // or in-memory bytes
  ],
});
```

`ImageInput` is either `{ path }` (an image file) or `{ data, format }` where
`format` is `"png" | "jpeg" | "gif" | "webp"`. Inputs are validated and bounded
before anything reaches the composer — at most 16 images, ≤25 MiB per image and
≤50 MiB total; an unsupported format or an unreadable path (or a count/size past
those limits) rejects the call with `invalid_image`. Byte inputs are written to a
short-lived temp file, removed once the submission is attached.

Attachment is confirmed, never assumed: each image waits for the CLI's
`[Image #N]` chip, and if it is not confirmed within ~10 s (or the clipboard
can't be read/written) the call rejects with `image_attach_failed` and no text is
submitted. If the session terminates mid-attach the call rejects with
`session_not_running`, like any queued operation. An attach rejection leaves
queue readiness unchanged — it never wedges the queue.

Each CLI ingests images through its own native path, so behavior differs:

- **Claude** reads a pasted absolute image path itself. Elwood bracketed-pastes
  each path (the same delivery a terminal produces on drag-and-drop), Claude
  encodes the file, and an `[Image #N]` chip appears. This works on every
  platform.
- **Codex** ingests an interactive image only from the OS clipboard (Ctrl+V).
  Elwood snapshots your clipboard once, writes each image onto the macOS
  pasteboard, sends Ctrl+V, waits for the `[Image #N]` chip, and then restores
  your prior clipboard — the whole transaction under a process-wide lock so
  concurrent Codex sessions can't cross-attach. Because it drives the macOS
  clipboard, **Codex image attachment is macOS-only** — `images` on a non-macOS
  Codex session rejects with `unsupported_platform` and submits nothing.
  Restoring the clipboard is best-effort (text contents), and there is a brief
  window during the attach where the injected image is the clipboard's contents.

`sendKeys` is the immediate escape hatch. Strings flow through the headless
xterm input path; `Uint8Array` writes raw bytes to the PTY. It intentionally
bypasses the control queue, so an interrupt can interleave with a pending
paste/Enter sequence.

`interrupt` cancels the in-flight turn — the programmatic Escape keypress. Once
the session has reached initial readiness, it bypasses the control queue and
writes Escape immediately when the session is `running` or `blocked`, then
resolves once the session is `ready` again (or rejects with `interrupt_failed`
after `timeoutMs`, default 10s). With no turn in flight — an idle `ready`
session or the pre-readiness startup window — it resolves without touching the
terminal. Concurrent calls coalesce into a single Escape. On a session that has
already terminated it rejects with `session_not_running`, like the other input
and command methods (`sendPrompt`, `sendMessage`, `sendGuidance`, `sendKeys`,
`resize`, `compact`, `listModels`, `setModel`). After exit, `stop`/`kill` do not
re-signal the PTY (node-pty does not replay exit and the pid may be recycled),
but they are not no-ops: they still confirm or retry the leader's process-group
reap and may reject with `termination_failed` if a survivor cannot be reaped.
`teardown` is idempotent and likewise retries a previously failed reap.

`compact` types the adapter's `/compact` command and resolves when the adapter
reports completion through its `PostCompact` hook.

`listModels` and `setModel` drive the adapter's own `/model` picker through the
headless terminal. `listModels` returns typed rows (`id`, `label`,
`description`, `isCurrent`, `isDefault`) and leaves the model unchanged;
`setModel` switches the session's model and leaves the user's saved defaults
untouched on both adapters. Claude applies session-only; the Codex CLI
persists picker selections into the user's config.toml on its own, so Elwood
restores the prior default via compare-and-swap afterwards — if the file
changed in other ways during the switch, Elwood leaves it alone and emits a
`codex_default_model_persisted` warning instead of clobbering it.

### Recovering an expired Claude login

If Claude's login lapses, the CLI stops responding and only shows
"Login expired · Please run /login". Elwood surfaces this so you never get a
silently-wedged session:

- At **startup**, a login-expired banner rejects `startClaude` with
  `claude_not_authenticated` (the session is torn down, not reported usable).
- **Mid-session** — login expiring while the session is live — Elwood emits a
  typed, content-free `login_expired` warning (and `warning` activity) carrying
  a `recoveryCommand` of `/login`, and leaves the session **alive** so you can
  recover in place.

`ClaudeSession.login(options)` drives the interactive `/login` flow to recover
without restarting the session. Because the default account login ends with a
human copying an authorization code from a browser, `login` cannot complete
fully unattended — it brackets the human step:

```ts
// Keep the event listener SYNCHRONOUS (TypedEmitter ignores returned promises,
// so an `async` listener's rejection would be unhandled). Launch recovery from a
// separate function with its own catch.
session.on("warning", (w) => {
  if (w.code === "login_expired") void recoverLogin();
});

async function recoverLogin() {
  try {
    await session.login({
      onAuthUrl: (url) => openInBrowser(url), // optional: the browser sign-in URL
      provideCode: () => promptHumanForCode(), // required: the code from the browser
      // method defaults to "claudeai"; timeoutMs defaults to 300000
    });
  } catch (err) {
    // login_failed / login_timeout / session_not_running — decide whether to
    // retry, tear down, or alert a human. Never rethrow into the event loop.
    reportLoginFailure(err);
  }
}
```

`login` runs as an exclusive transaction: it serializes with every other
control operation, so nothing interleaves with its picker keys, the secret code,
or its Enters, and it never sends keystrokes into a blocking dialog. It submits
`/login`, selects the login `method` if the CLI shows its method picker, reports
a validated authorization URL (only `https:` on an approved Anthropic host) via
`onAuthUrl`, and — when the CLI asks for a code — calls `provideCode`, validates
the returned code (rejecting empty/oversized/control-bearing values), and
submits it followed by exactly one library-controlled Enter. Screen stages are
recognized only when they NEWLY appear after the `/login` submission, so stale
on-screen text can't drive the flow. It resolves only after the CLI reports
success **and** the session reaches a fresh `ready` state (proving renewed
usability, not just a banner), and rejects with `login_failed` (an explicit
failure, an invalid code, or a failing `provideCode`), `login_timeout`, or
`session_not_running`. A flow that self-completes without prompting for a code
never calls `provideCode`.

**Security considerations.** `login` layers several defenses so an untrusted
screen cannot hijack the flow: the transaction holds the control queue
exclusively (nothing else writes during it), the human code and scraped URL are
validated (the URL must be `https:` on an exactly-approved Anthropic host with no
credentials), stage markers are scoped to the screen's active tail and required
new versus a pre-`/login` baseline, login keystrokes hold while a blocking dialog
is on screen, and the code prompt is re-checked as still-current immediately
before the code is written. Two residual limitations remain by design:

- A single frame that renders BOTH a genuine approved-host `claude.ai` OAuth URL
  AND a paste-code prompt in the active region — i.e. attacker-controlled output
  that manages to reproduce a real Anthropic OAuth URL during an active login —
  can still advance the flow. This is a narrow, contrived case (it requires
  forging a host-valid OAuth URL, not merely a phrase); coherent per-frame dialog
  identity on a text-only TUI is not attempted. Only run `login` when the session
  is genuinely at Claude's `/login` prompt, not while untrusted tool/model output
  is streaming into the terminal.
- The `/login` screen matchers are version-coupled to the Claude CLI and are
  covered by unit tests against real captured CLI strings, not by a live-CLI e2e:
  driving `/login` against a real authenticated session would mutate the
  developer's auth and cannot run unattended in CI.

To enumerate available models **without** holding a session — for example to
populate a UI selector — use the standalone `listClaudeModels`/`listCodexModels`
functions. Each starts a throwaway session (from an Elwood-owned temp state
directory it removes afterward, even if startup fails), lists its models, and
tears it down. The probe only opens and cancels the picker, so it never applies
a selection and leaves the user's saved **model default** untouched (Codex's own
boot-time config bookkeeping is outside Elwood's control):

```ts
import { listClaudeModels, listCodexModels } from "elwood";

const claudeModels = await listClaudeModels({ cwd: "/path/to/project" });
const codexModels = await listCodexModels({ cwd: "/path/to/project" });
// [{ id: "haiku", label: "Haiku", isDefault: false, isCurrent: false, ... }, ...]
```

They accept the launch-relevant options (`cwd`, `stateDir`, `autoupdate`,
`hookTimeoutMs`, `strictVersionCheck`, and a `timeoutMs` for the picker
automation). A start failure surfaces the adapter's normal typed error; a
picker failure rejects with `model_automation_failed` (if tearing the probe
down then also fails, that secondary failure is attached to the error's
`cause` so a leaked probe is never invisible).

> **Trust note.** To reach a listable state without a human at the keyboard,
> the probe starts its throwaway session with `autotrust: true` for the given
> `cwd` — so it answers the workspace/skill/plugin/MCP trust prompts for that
> directory automatically. This crosses the same trust boundary a normal
> `autotrust: true` start does; it is a deliberate, documented exception for
> the probe (which only opens and cancels the picker and never runs a turn).
> Point these functions at a directory you already trust.

Both adapters also accept a `persona` start option: an instruction message that
Elwood delivers as the session's guaranteed first user message once the agent
becomes ready, ahead of anything else you queue. It is never persisted and is
not re-sent on resume. `startClaude` additionally accepts `model`, forwarded to
Claude's `--model` launch flag (Codex has had `model` from the start).

Code generic over "any agent session" should use the exported
`ElwoodAgentSession` type — a structural supertype both session types satisfy,
covering the shared events (`terminal:data`, `terminal:exit`, `status`,
`activity`, `warning`, `hookError`), io, commands, and lifecycle.

### sendKeys: string vs bytes

The two overloads take different paths. A **string** flows through the
headless xterm input pipeline, which applies terminal input semantics before
the bytes reach the PTY. A **`Uint8Array`** is written to the PTY verbatim.
For forwarding a user's real keystrokes from your own terminal UI, send bytes:
what the user's keyboard produced is exactly what the agent receives, with no
reinterpretation. Use strings for programmatic input where you are composing
escape sequences yourself.

### Persisting and resuming

To resume a session across parent-app restarts, persist exactly two things:
the `elwoodSessionId` and the `stateDir` it lives in (keep that directory
intact). Everything else Elwood needs is in the session record. Notes:

- Resume **defaults the launch posture from the persisted record**. ONLY these
  posture fields are restored: `permissionMode`, allowed/disallowed tools, and
  `tools` (Claude), and `sandbox` and `approvalPolicy` (Codex) — so tool/privilege
  restrictions cannot silently loosen. Explicit resume options override the
  persisted posture field by field, and the effective posture is re-persisted.
  Everything else is **per-call and does not carry across resume** — you must
  re-specify it each time. That includes `model`, the hook handlers, and the
  startup/trust/update options `autotrust`, `autoupdate`, `hookTimeoutMs`, and
  `strictVersionCheck`. Do not assume startup or trust behavior persists.
- `resume*` rejects with `resume_unavailable` when the agent CLI never
  reported its internal conversation id (for Claude, a conversation is only
  resumable after at least one completed turn), `state_not_found` when no
  record exists, and `adapter_mismatch` when the id belongs to the other
  adapter.
- Prefer `startOrResumeClaude` / `startOrResumeCodex`: they run the
  try-resume-else-start dance for you, falling back **only** on those three
  error names, rethrowing everything else (e.g. `state_corrupt`), and
  returning `{ session, resumed }` so you can re-persist a fresh id after a
  fallback.

### Event delivery guarantees

- `terminal:exit` is emitted exactly once per session process exit.
- A handler never fires after its unsubscribe function returns.
- A late `terminal:data` subscriber first receives the replay buffer as a
  single coalesced chunk, then live chunks, with no gap and no duplicates.
  The replay buffer is bounded at **128 KB** (oldest data dropped), so a very
  chatty session replays only the most recent screen history — pair it with
  `session.terminal.snapshot()` if you need current-screen ground truth.
- Lifecycle is idempotent where it can be: `stop()`/`kill()` after exit do not
  re-signal the PTY and preserve the exit status, but they still confirm or retry
  the process-group reap and may reject with `termination_failed`; `teardown()`
  is safe to call twice. Input/command methods after any terminal status reject
  with `session_not_running` (they never throw synchronously).
- `status` transitions mark every real turn boundary: `running` when a turn
  starts and `ready` when it ends — including turns ended by an Escape
  interrupt, which fires no completion hook. Turn state is derived from the
  rendered TUI (each adapter's documented working indicator plus its
  composer), so consumers can clear "agent is working" UI on the `ready`
  status beat without hook assumptions.

The default terminal size is 189×48 — deliberately wide so full-width TUI
layouts render without artificial wrapping in headless use. Visual embedders
should always pass and maintain their real xterm size instead.

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
`hookEventName`, `turnId`, `toolName`, `toolUseId`, `toolInput`, `toolOutput`,
`status`, `exitCode`, `failedOpen`, and `transcriptPath` when Elwood can derive
them (`toolInput`/`toolOutput` are the tool's serialized args/output on
`tool_call`/`tool_result` activity). `raw` remains
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
4. Run `npm run check`.

Repository standards:

- 100% line, function, statement, and branch coverage.
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
| `src/core/` | Adapter-neutral session machinery: control-operation queue, status-evidence and rendered-state detection helpers, compact, model picker automation, persona, warnings. |
| `src/runtime/` | Shared session base class, startup checks, teardown, and test seams. |
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
  hook-trust and update prompts, Claude/Codex workspace trust prompts (opt-in
  via `autotrust`), and Claude's browser-tools onboarding prompt, and reports
  typed warnings where possible.
- Model picker automation (`listModels`/`setModel`) is pinned to the picker
  layouts of current CLI releases; layout drift surfaces as a typed
  `model_automation_failed` error rather than silent misbehavior.
