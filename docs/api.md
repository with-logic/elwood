# Low-level session API

Purpose: the full control surface under `ClaudeSession` / `CodexSession`, for
callers who need more than `send` and `stream`.

`ClaudeSession` and `CodexSession` are the primary API. Each delegates the
operational and lifecycle methods of the low-level session and exposes the raw
session object (for `elwoodSessionId`, `cwd`, `terminal`, `readScreen()`, and
`statusDecisions()`) as `session.session` after startup. The eager
`startClaude` / `startCodex` factories below are deprecated but remain
available; the examples use them to show every option in one place.

## Claude

```ts
import { startClaude } from "@with-logic/elwood"; // deprecated; prefer `new ClaudeSession(...)`

const claude = await startClaude({
  cwd: "/path/to/project",
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

Claude `user_message` activity can display the body of a supported native paste
and include `nativePrompt` with the delivered envelope. `promptProvenance`
reports `input: "pasted"` and `origin: "unknown"` for that case. The body retains
Claude's transformations, so callers may need their own original text when
exact bytes matter. See [native paste presentation](cli-behavior.md#claude-native-paste-presentation).

## Codex

Pass `{ sendId: "request-42" }` to `sendMessage`, `sendPrompt`, or
`sendGuidance` to correlate supported text sends with a matching Codex
`UserPromptSubmit` hook. Its `user_message` carries the original API text,
the exact `nativePrompt`, API paste provenance, and the caller ID. It
can omit these fields when composer ownership or the hook match is uncertain.
See [the event contract](../prd/05-api/5.4-events.md) for eligibility.

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

Both sessions satisfy the exported `ElwoodAgentSession` type. It covers shared
events, I/O, commands, loops, lifecycle, and dashboard stats. The interface below
shows common calls. [Dashboard stats](embedding.md#session-stats-snapshots)

`ready` marks input availability. The final reply can arrive later through
`activity`. When native transcript evidence identifies final reply text, the
`assistant_message` event carries `final: true`. The marker describes the reply
text. Track hook results and the turn lifecycle separately. Use `turnId` when
available to associate the message with its turn. If `final` is omitted,
finality is unknown.

Listen for `warning` with `code: "usage_limit_reached"` for explicit quota
rejections. The same observation appears in `activity` with kind `warning`,
label `usage_limit_reached`, and the full warning in `raw`. Check `agent` to
read each adapter's fields.

- `claude` carries Claude's message, `limitName`, `nativeLimitType`, and
  `resetsAtUnixSeconds` when available. Use `turnId` when present to associate
  the denial with a prompt.
- `codex` carries the native reason in both `nativeLimitType` and the warning's
  `raw` field. The warning's `message` is Elwood's description of that reason.
  `activity.raw` contains the full warning. The warning also carries optional
  `limitId` and `limitName`, plus separate `primaryResetsAtUnixSeconds` and
  `secondaryResetsAtUnixSeconds` when supplied. Codex snapshots omit the turn
  identity and which window rejected it.

```ts
interface ElwoodAgentSession {
  readonly elwoodSessionId: string;
  readonly cwd: string;
  readonly status: "starting" | "running" | "ready" | "blocked" | "stopped" | "exited" | "killed" | "torn_down";
  readonly terminal: ElwoodTerminal;

  statusDecisions(): readonly ElwoodStatusDecision[];
  getStats(): Promise<SessionStats>;
  readScreen(options?: { readonly scrollback?: boolean | number }): Promise<ElwoodScreen>;
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
  listQuestions(): Promise<readonly ElwoodQuestionRequest[]>;
  answerQuestions(requestId: string, answers: readonly ElwoodQuestionAnswer[], options?: ElwoodQuestionAnswerOptions): Promise<void>;
  createLoop(request: ElwoodLoopRequest): Promise<ElwoodLoopSnapshot>;
  listLoops(): Promise<readonly ElwoodLoopSnapshot[]>;
  cancelLoop(loopId: string): Promise<void>;
  stop(): Promise<void>;
  kill(): Promise<void>;
  teardown(): Promise<void>;
}
```

## Reading the screen

`await session.readScreen()` returns what the terminal shows now as text. It
waits for received output to render first.

```ts
const screen = await session.readScreen({ scrollback: 200 });
screen.lines;      // the live rows, top to bottom, right-trimmed
screen.scrollback; // up to 200 rows above them, oldest first
screen.cursor;     // { x, y, visible } in cells; y indexes `lines`
screen.buffer;     // "normal" | "alternate"
screen.outputLost; // true once Elwood failed to draw received output
```

`lines` is always the live screen, even when your code scrolled
`session.terminal.xterm` back. `terminal.snapshot()` follows that scroll
position instead. For scrollback, the end of a session and privacy, see
[embedding.md](embedding.md#reading-the-screen-as-text).

## Sending input

Native agent questions have a separate control path: subscribe to `question`
events, recover pending requests with `listQuestions()`, and submit a complete
request with `answerQuestions()`. These controls work while an ergonomic turn is
waiting and do not create another user turn. See [questions.md](questions.md) for
the event, capability, validation and input-ownership contract.

Claude and Codex sessions expose workspace trust prompts through `listDialogs()`
and emit typed `dialog` events when verified requests appear or close. Each
request names the exact folder or repository root and lists the native choices
in display order. Both adapters accept verified choice IDs through
`answerDialog()`. The `ElwoodDialogEvent` type defaults to Codex. Pass
`ElwoodDialogEvent<"claude">` for Claude events. See [native dialog discovery](../prd/05-api/5.13-dialogs.md).
With `autotrust: false`, Claude callers can use `answerDialog(requestId, choiceId, options?)`.
The promise resolves when Claude confirms acceptance or when Claude exits after
`No, exit`. Invalid or unavailable requests and answers Claude cannot confirm
reject with the [Claude dialog answer errors](../prd/05-api/5.3-claude-session-api.md).
Codex answers require a verified prompt and automatic trust off (the default). They resolve on native
acceptance, Back, or Quit. See the [Codex answer contract](../prd/05-api/5.13-dialogs.md#codex-workspace-trust-answers).

`sendMessage` is the adapter-neutral chat-loop operation. If the session is
ready it writes through the PTY immediately. If the session is alive but busy,
Elwood queues it and submits it on the next `ready` transition.

`sendPrompt` uses bracketed paste so multi-line text is submitted as one
prompt. It does not wait for `ready`: it dispatches as soon as no other
submission is in flight, like a human typing into the TUI. It may overtake
readiness-waiting messages but never interleaves with an in-flight paste/Enter
sequence. After either adapter emits `initial_ready_backstop`, the write waits
for a configured composer or readiness hook.

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
calls coalesce into one interrupt sequence. Claude retries once 250 ms after the
first Escape write settles if the session remains `running`; becoming `ready`,
`blocked`, or terminal cancels that retry. Codex receives one Escape.

`compact` types the adapter's `/compact` command and resolves when the adapter
reports completion through its `PostCompact` hook.

`listModels` and `setModel` drive the adapter's `/model` picker through the
headless terminal. `listModels` returns rows (`id`, `label`, `description`,
`isCurrent`, `isDefault`) and leaves the model unchanged. A non-null `id` can be
passed unchanged as the launch `model` or to `setModel`; `label` is display text.
Claude's `Haiku 5.5` label has id `claude-haiku-5-5`, while `default` remains a
valid alias. Unrecognized labels retain their rows with `id: null`; skip those
rows when choosing a launch value. Codex-specific listings return `CodexModelOption`
rows with non-null string IDs. Legacy Claude display labels still
work with `setModel`. Explicit model choices are forwarded on Claude resume too.
`setModel` switches
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
