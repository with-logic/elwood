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
  Elwood's own e2e suite does exactly this.
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
