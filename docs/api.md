# Low-level session API

Purpose: the full control surface under `ClaudeSession` / `CodexSession`, for
callers who need more than `send` and `stream`.

`ClaudeSession` and `CodexSession` are the primary API. Each delegates the
operational and lifecycle methods of the low-level session and exposes the raw
session object (for `elwoodSessionId`, `cwd`, `terminal`, and
`statusDecisions()`) as `session.session` after startup. The eager
`startClaude` / `startCodex` factories below are deprecated but remain
available; the examples use them to show every option in one place.

## Claude

```ts
import { startClaude } from "@with-logic/elwood"; // deprecated; prefer `new ClaudeSession(...)`

const claude = await startClaude({
  cwd: "/path/to/project",
  disallowedTools: ["AskUserQuestion"],
  autotrust: true,
  persona: "You are a terse reviewer. Prefer diffs over prose.",
  hooks: {
    PreToolUse(event) {
      if (event.tool_name === "Bash" && event.tool_input.command.includes("rm -rf")) {
        return { permissionDecision: "deny", permissionDecisionReason: "Dangerous shell command." };
      }
      return undefined;
    },
  },
});

await claude.sendMessage("Implement the next PRD slice.");
```

Claude launches through the user's interactive login shell with generated
session-scoped settings passed via `--settings`. Elwood does not mutate
`.claude/settings.local.json`. `startClaude` also accepts `model`, forwarded
to Claude's `--model` flag, and `reasoningEffort`, forwarded to `--effort`.

## Codex

```ts
import { startCodex } from "@with-logic/elwood"; // deprecated; prefer `new CodexSession(...)`

const codex = await startCodex({
  cwd: "/path/to/project",
  model: "gpt-5.3-codex",
  approvalPolicy: "never",
  autotrust: true,
  hooks: {
    PermissionRequest(event) {
      if (event.tool_name === "Bash") return { behavior: "allow", message: "Approved by policy." };
      return { behavior: "deny", message: "Only Bash is allowed in this mode." };
    },
  },
});

codex.on("codex:transcript", (event) => {
  console.log(event.summary.kind, event.summary.label, event.summary.text ?? "");
});
```

Codex uses session-scoped `-c` overrides for hooks. Elwood reserves
`features.hooks=true` and `hookTrust="trust-all"` because the library is not
useful if the bridge hooks do not run. If Codex still shows a hook-review
prompt, Elwood answers it through the PTY. `reasoningEffort` is forwarded as
`-c model_reasoning_effort=<value>` and validated against Codex's enum before
spawn.

## Common surface

Both sessions satisfy the exported `ElwoodAgentSession` type. Code generic over
"any agent session" should use it; it covers the shared events, io, commands,
loops, and lifecycle. The sketch below is illustrative, not the exact
declaration:

```ts
interface ElwoodAgentSession {
  readonly elwoodSessionId: string;
  readonly cwd: string;
  readonly status: "starting" | "running" | "ready" | "blocked" | "stopped" | "exited" | "killed" | "torn_down";
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
  createLoop(request: ElwoodLoopRequest): Promise<ElwoodLoopSnapshot>;
  listLoops(): Promise<readonly ElwoodLoopSnapshot[]>;
  cancelLoop(loopId: string): Promise<void>;
  stop(): Promise<void>;
  kill(): Promise<void>;
  teardown(): Promise<void>;
}
```

## Sending input

`sendMessage` is the adapter-neutral chat-loop operation. If the session is
ready it writes through the PTY immediately. If the session is alive but busy,
Elwood queues it and submits it on the next `ready` transition.

`sendPrompt` uses bracketed paste so multi-line text is submitted as one
prompt. It does not wait for `ready`: it dispatches as soon as no other
submission is in flight, like a human typing into the TUI. It may overtake
readiness-waiting messages but never interleaves with an in-flight paste/Enter
sequence.

`sendGuidance` is for a coordinator intervening in an active turn. It queues
before the session's first readiness and while a blocking dialog is visible.
After the session has been ready once, guidance sent while `running` bypasses
readiness and enters the TUI immediately. It stays serialized with other queued
operations, and its promise resolves after the text and its Enter are written.

`sendKeys` is the immediate escape hatch and bypasses the control queue. A
string flows through the headless xterm input pipeline, which applies terminal
input semantics. A `Uint8Array` is written to the PTY verbatim; use bytes to
forward a user's real keystrokes from your own terminal UI.

All three send methods accept `images` (see [images.md](images.md)). Slash
prefixed text is sent literally; see [loops.md](loops.md) for `/loop`.

## Commands

`interrupt` cancels the in-flight turn with a programmatic Escape. Once the
session has reached initial readiness it writes Escape immediately when the
session is `running` or `blocked`, then resolves once the session is `ready`
again, or rejects with `interrupt_failed` after `timeoutMs` (default 10 s).
With no turn in flight it resolves without touching the terminal. Concurrent
calls coalesce into one Escape.

`compact` types the adapter's `/compact` command and resolves when the adapter
reports completion through its `PostCompact` hook.

`listModels` and `setModel` drive the adapter's `/model` picker through the
headless terminal. `listModels` returns rows (`id`, `label`, `description`,
`isCurrent`, `isDefault`) and leaves the model unchanged. `setModel` switches
the session's model and leaves the user's saved defaults untouched: Claude
applies session-only; Codex persists picker selections into the user's
`config.toml` on its own, so Elwood restores the prior default afterwards via
compare-and-swap and emits `codex_default_model_persisted` instead of
clobbering a file that changed in other ways. Layout drift in either picker
surfaces as `model_automation_failed`.

To enumerate models without holding a session, use the standalone
`listClaudeModels` / `listCodexModels` functions. Each starts a throwaway
session from an Elwood-owned temp state directory, lists, and tears it down
(removing the directory even if startup fails). The probe only opens and
cancels the picker, so it never applies a selection:

```ts
import { listClaudeModels, listCodexModels } from "@with-logic/elwood";

const claudeModels = await listClaudeModels({ cwd: "/path/to/project" });
const codexModels = await listCodexModels({ cwd: "/path/to/project" });
```

They accept `cwd`, `stateDir`, `autoupdate`, `hookTimeoutMs`,
`strictVersionCheck`, and a `timeoutMs` for the picker automation. A start
failure surfaces the adapter's normal typed error; a picker failure rejects
with `model_automation_failed` (a secondary teardown failure is attached as
`cause`). Trust note: the probe starts with `autotrust: true` for the given
`cwd`, so it answers that directory's workspace, skill, plugin, and MCP trust
prompts automatically. Point these functions at a directory you already trust.

Both adapters accept a `persona` start option: an instruction delivered as the
session's guaranteed first user message once the agent is ready, ahead of
anything else queued. It is never persisted and not re-sent on resume.

Input and command methods on a terminated session reject with
`session_not_running`; they never throw synchronously.

Event delivery guarantees, the default terminal size, and persisting/resuming
are in [lifecycle.md](lifecycle.md).
