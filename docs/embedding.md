# Embedding Elwood in a parent application

The canonical embedding is an Electron app: Elwood runs in the main process,
terminal output streams to a renderer xterm over IPC, and renderer keystrokes
flow back. The same shape applies to any host (web server, TUI multiplexer,
daemon).

## The loop

```ts
import { startOrResumeClaude, type ElwoodAgentSession } from "@with-logic/elwood";

const { session, resumed } = await startOrResumeClaude({
  cwd: workspacePath,
  stateDir: join(appStateDir, "sessions", mySessionId, "elwood"),
  elwoodSessionId: persisted?.elwoodSessionId,
  autotrust: true,
  hooks: { /* policy hooks */ },
});
if (!resumed) persist({ elwoodSessionId: session.elwoodSessionId });

// Main -> renderer: raw PTY bytes into a visual xterm.
session.on("terminal:data", (event) => window.webContents.send("pty", event.data));
// Renderer -> main: forward user keystrokes verbatim as bytes.
ipcMain.on("keys", (_event, bytes: Uint8Array) => void session.sendKeys(bytes));
// Keep the visual and headless terminals the same size.
ipcMain.on("resize", (_event, size) => void session.resize(size));
```

A late `terminal:data` subscriber first receives up to 128 KB of replayed
output as one chunk, so a freshly-opened renderer view paints recent history
immediately; write it into the xterm like any other chunk.

## Lifecycle

- **Relaunch:** persist `elwoodSessionId`, keep `stateDir` intact, and call
  `startOrResume*` at boot. It falls back to a fresh session only when no
  resumable session exists (`state_not_found` / `resume_unavailable` /
  `adapter_mismatch`) and reports which path ran.
- **Removal:** call `teardown()` — it removes Elwood-owned state (session
  record, loop sidecar, generated settings, bridge script, socket home) without touching the
  agent CLI's own user data.
- **Shutdown:** `stop()` for graceful, `kill()` for wedged sessions. Both are
  safe after the process already exited. Stop and unexpected exit preserve
  loop definitions for resume; kill clears them permanently.

Recurring loops are owned by Elwood and need no parent timer. Use
`createLoop`/`listLoops`/`cancelLoop`; resume restores unexpired definitions with
fresh clocks and no catch-up. Use the opt-in `parseLoopCommand` helper for a
shared `/loop` UX, since ordinary send methods keep slash-prefixed text literal.

`stateDir` can be arbitrarily deep: the hook bridge socket binds in a short
Elwood-owned temp home, not under `stateDir`, so macOS's ~104-byte socket path
cap does not constrain your state layout.

## Gotchas

- **CJS bundlers (Electron main).** Elwood constructs its `require` from
  `import.meta.url ?? __filename`, so bundling to CJS works without a
  `define` workaround. If you bundle, keep `node-pty` external — it is a
  native module.
- **Nested agent sessions.** Claude Code ≥ 2.1.201 does not persist
  conversations for instances launched from inside another Claude Code
  session (`CLAUDECODE`/`CLAUDE_CODE_*` in the environment). Hooks and turns
  work, but resume will find nothing. If your parent app can itself be
  launched from a Claude session (dev workflows, test runners), strip those
  variables from the child environment when you need resumable sessions —
  use the launch-only `env` option rather than changing the host's `process.env`.
  Strings override inherited values and `undefined` removes them. For example,
  `env: { CLAUDECODE: undefined, npm_config_prefix: undefined }`. To remove a
  family such as `CLAUDE_CODE_*` or `ELECTRON_*`, build a map of matching names
  with `undefined` values. The same map applies to preflight probes and the PTY;
  login profiles can subsequently modify it. Re-supply it on resume.
- **User keystrokes** should be forwarded with the `Uint8Array` overload of
  `sendKeys` for verbatim delivery; the string overload applies terminal
  input semantics (see [api.md](api.md)).
- **Interrupting a turn** (a stop button, the user's Escape) should call
  `interrupt()` rather than forwarding a raw Escape byte: it no-ops safely
  when no turn is running and resolves once the session is `ready` again.
- **Model switching** via `setModel` preserves the user's saved defaults on
  both adapters: Claude applies session-only, and Elwood restores Codex's
  config.toml after the CLI persists its picker selection (watch for the
  `codex_default_model_persisted` warning in the rare concurrent-edit case).
- **Enumerating models without a session** — to populate a model selector
  before the user starts a session — use `listClaudeModels`/`listCodexModels`.
  They spin up a throwaway session, list, and always tear it down, so they cost
  a few seconds each; cache the result in the parent app if you call them often.
  Display `label` and pass a non-null `id` unchanged to launch or `setModel`;
  `id: null` means the row has no recognized launch selector. Refresh cached
  catalogs after CLI updates. Claude's `default` is a valid selector.
- **Codex speed** is a separate launch and resume setting, `serviceTier`.
  `codexServiceTierChoices` lists the accepted values: `default`, `fast`, and
  `ultrafast`. For the selected model, use `codexServiceTiers.values` on its
  `listCodexModels` row to show tiers advertised by the native catalog.
  An absent field means the catalog evidence is unavailable. Treat the
  catalog timestamp and values as hints because eligibility can change with
  the active account and provider. Omit `serviceTier` to inherit settings,
  or pass `"default"` for Standard. To change it between turns, stop and
  resume the session with the selected value.

## Dashboard statistics

Subscribe to `activity` before sending a turn and read the session's `status`
to show whether the main agent is running. Stats arrive with the existing
transcript and hook events.

| Field | What to show | How to update |
| --- | --- | --- |
| `tokenUsage` with `scope: "thread"` | Codex cumulative totals, last request, and context window | Replace the previous snapshot for `transcriptPath`. Totals may include history after resume. |
| `tokenUsage` with `scope: "response"` | Claude response tokens, including cache reads and writes | Upsert by `transcriptPath` and `responseId`, then sum `counts.totalTokens`. Cache reads and writes are components of `counts.inputTokens`. |
| `rateLimits` | Codex quota remaining, window duration, and reset time | Keep this observation scoped to its session. A later transcript write can repeat cached quota. |
| `subagent` | Observed active subagents for either harness | Add the ID to a per-session set on `started`, delete on `stopped`, and use the set size. Clear it on `terminal:exit`. |

An absent field means the harness has supplied no matching evidence. Codex
quota snapshots may get stale while idle. Claude quota is unavailable through
these records. Subagent counts are best effort, especially after resume when
existing workers may have started before subscription.

### Session stats snapshots

`await session.getStats()` reads from memory. It returns the session status,
latest token observation, `activeSubagentCount`, and quota observed in that
session's Codex transcript. Quota is `fresh`, `stale`, or `unavailable`.
Use the ISO timestamp `observedAt` to calculate the age. Final observations remain
readable after closure. A stats read leaves an unstarted lazy session untouched.

### Account usage before launch

Call `readAccountUsage()` to check the current Claude and Codex accounts without
starting a model turn. Each account supplies its own reported windows. Select
the same percentage field for every row, and show the window label and reset time.
Use `windowMinutes` to align known durations across providers.

For a dashboard, create one `createAccountUsageReader(accounts?)` and reuse
the returned function. It shares pending reads and caches each account for up
to five minutes or an earlier reset. Use `readAccountUsage()` for an immediate
refresh. For the current Claude sign-in, Elwood checks the effective native
settings before omitting `ANTHROPIC_API_KEY`. Direct sign-ins can expose
subscription windows. Gateway sign-ins and CLIs that cannot report effective
settings keep their key. The reading describes the account used for the quota
check. An interactive session can use a different credential. Older Claude
versions can supply account limits through a headless
`/usage` read when the structured request is unsupported. This fallback requires
`--safe-mode` support and, after credential filtering, a standard Claude
environment with only the profile selectors among Claude and Anthropic
environment settings.

```ts
import { readAccountUsage } from "@with-logic/elwood";

const accounts = await readAccountUsage();
for (const { agent, label, status, windows } of accounts) {
  if (status === "unavailable") console.log(agent, label, "Unavailable");
  for (const window of windows) {
    console.log(agent, label, window.label, window.remainingPercent, "% left", window.resetsAt ?? "");
  }
}
```

To check several sign-ins, pass an array such as
`[{ agent: "codex", label: "Work", configDir: "/Users/me/.codex-work" }]`.
A label names the CLI profile you supply. The CLI resolves its own credentials.
Use `usedPercent` for a used-first display. Refresh by calling the API again.

## Reading the screen as text

Call `await session.readScreen()` to show or inspect what a session displays
without feeding `terminal:data` through your own emulator. It returns the live
rows as `lines`, the terminal size, the cursor in cells, the active buffer, and
`outputLost`, which turns true if Elwood ever failed to draw output it received.
On `ClaudeSession` and `CodexSession`, call it on `session.session` after start.

- The text can contain anything the agent displayed, including account and
  workspace details. Treat it like the terminal itself. Elwood keeps it in
  memory only and never writes it to disk or to `elwood` CLI output.
- Pass `{ scrollback: true }` or a row count for the rows above the live
  screen. Claude Code 2.1.332 and Codex 0.171.0 and 0.172.0 draw on the
  alternate screen by default, so that list is empty and `lines` holds only
  the last screenful of a long reply. `outputLost` stays false then. Read
  earlier output from `activity` events. Claude starts on the normal screen
  instead after a fullscreen Claude launch on the same machine died within 10
  seconds of its first frame. Set `CLAUDE_CODE_NO_FLICKER` to `1` or `0` in
  `env` to pin its alternate or normal screen.
- The cursor's `x` is a terminal column. It differs from a string index on a
  row with wide characters.
- A read can land in the middle of a repaint. Poll after `status` changes
  rather than on a tight timer, and stop once the session has ended: the
  final screen never changes.
- The call waits for output to pause and has no timeout, so race it against
  your own timer if a session might print without a break.
- After the session ends, including after `stop()` resolves, the call
  returns the final screen from memory: the frame the terminal held when it
  was disposed. After a normal stop that is the terminal once the CLI quit,
  so it may show the CLI's exit rather than the last conversation:
  after `stop()`, Claude Code 2.1.332 leaves only its resume command on the
  normal screen under its fullscreen renderer, or that command below its last
  frame on the normal screen, and Codex 0.171.0 leaves its last frame. Read the screen
  before you stop a session if you need the conversation.

For a pixel-faithful terminal view, keep rendering the raw `terminal:data`
stream.

## Turns and startup input

`ready` describes terminal availability. Startup and dialog repaints can produce
status changes without a user turn, and committed assistant text can arrive after
`ready`. Use `UserPromptSubmit` hooks to observe submissions, including textless prompts.
`user_message` ordinarily carries the native prompt. For a matched Claude or
Codex low-level API send, `text` is the original API string, `nativePrompt` is
the exact submit-hook text, and `sendId` carries the valid caller ID when
supplied. A supported standalone Claude paste with unknown API origin reports
the native body as `text` and the exact envelope as `nativePrompt`. That includes
envelopes submitted through Claude’s ergonomic methods.
See [native paste presentation](cli-behavior.md#claude-native-paste-presentation).

Claude activity can be correlated using its native `turnId` when present. Keep accepting matching
assistant messages after a status transition; a status edge is not a transcript
flush barrier. Older Claude records without native prompt identity can remain
untagged. Claude's synthetic interrupted-resume placeholder is omitted from
normalized assistant activity.

From the 10-second readiness deadline, a startup screen Elwood does not recognize makes
the session `blocked` with `claude-unrecognized-startup` or `codex-unrecognized-startup`
attention, and an `unrecognized_startup` activity labelled `initial_ready_deadline`
carries the screen's bounded text. Answer it with `sendKeys`, or stop the session;
queued input is released once a verified composer follows. On Claude and Codex,
`initial_ready_backstop` warns that startup evidence is still missing after 60 seconds:
readiness and queued text remain held. If no recognized dialog or other recognized
startup hold, such as trust automation or Codex's repaint after an update skip, is
active, the matching `unrecognized_startup` activity carries bounded live screen text
for display. Elwood replaces `sk-` API-key-shaped tokens in either text, including a key
wrapped across rows, with `sk-[REDACTED]`. Only these activities are redacted:
`terminal:data`, `terminal.snapshot()` and `readScreen()` show the screen as drawn.
Otherwise the text can include whatever the agent showed, such as account or
workspace details or other credentials.
Recognized update menus are safely skipped or reported as `blocked` with
`codex-update-prompt` attention. Elwood never chooses `Update now` in the TUI.

Call `answerQuestions()` as soon as its request is raised. Claude answers wait
until 1.5 seconds after the first complete matching native dialog paint, then
recheck the dialog; the answer timeout includes this wait. Raw `sendKeys` remains
immediate, so callers driving a newly painted trust/question dialog themselves
must allow its input handler to settle.

## Scaling concurrent sessions

See [performance.md](performance.md) for the fifty-session workload, measured
CPU improvement, and the existing `terminal.xterm.options.scrollback` history
budget. Headless history and the browser terminal's history are separate;
choose both budgets and avoid polling fresh snapshots for hidden sessions.
