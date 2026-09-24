## 7A. Codex Hook Bridge And Policy

### 7A.1 Required hook coverage

Elwood MUST configure a hook bridge for every documented Codex hook event,
including at minimum:

- `SessionStart`
- `SubagentStart`
- `PreToolUse`
- `PermissionRequest`
- `PostToolUse`
- `PreCompact`
- `PostCompact`
- `UserPromptSubmit`
- `SubagentStop`
- `Stop`

### 7A.2 Typed hook responses

Elwood MUST model Codex hook inputs and outputs as discriminated TypeScript
unions.

- `hook_event_name` narrows the event payload.
- For tool events, `tool_name` narrows known tool inputs for `Bash` and
  `apply_patch`; MCP tools use their raw `mcp__*` names, and other future raw
  Codex tool names are normalized to `unknown:<raw-name>` before dispatch so
  known-tool narrowing remains reliable while preserving a safe generic input
  path.
- `PreToolUse` may deny, allow, allow a rewritten input, or add context
  according to Codex's current supported response shapes. Typed `updatedInput`
  rewrites MUST be authored through a tool-keyed handler such as
  `PreToolUse.Bash` or `PreToolUse.apply_patch`; the event-name
  `PreToolUse(event)` handler form may return permission decisions or context,
  but must not expose `updatedInput`.
- `PermissionRequest` may allow or deny only. Future-only fields such as
  updated input, updated permissions, and interrupts must be unrepresentable.
  Serialized output must put `behavior` and optional `message` inside the
  event-specific `decision` object with `hookEventName`.
- `Stop` and `SubagentStop` may block completion with a continuation reason and
  optional additional context, or return `continue: false` with a stop reason
  and optional additional context.
- `PostToolUse`, `UserPromptSubmit`, `SubagentStart`, `PreCompact`, and
  `PostCompact` are observe-only in Elwood's Codex API until Codex documents a
  stable response contract for those hooks.
- Observe-only or unsupported response states must be rejected by the type system
  and runtime validation. Parent handlers must return `undefined` for no
  decision; an empty object is invalid and must fail open with `hookError`.
- Tool-keyed lookup, for both the exact tool name and the `unknown` fallback, MUST
  consider only OWN properties of the handler map. A tool name that merely matches an
  inherited member resolves to no handler, so a CLI-supplied name cannot reach a
  function the caller never registered for it.

The validated Codex hook event, including nested tool input, is frozen before
parent observation or handler routing. A handler response is detached before
validation, so later mutation of the handler-owned value cannot change it.
Elwood fixes the validated wire reply and Stop blocking decision before result
activity observers run. Observer mutation cannot change policy input, the native
reply, or Stop readiness. Invalid response data fails open with `hookError`
(C-HOOK-23).

Observational hook, activity, hook-error, transcript, and lifecycle listener
failures must not replace Codex hook decisions or skip turn bookkeeping. Each
hook invocation reports at most one bounded, content-free `hook_observer_failed`
warning for its first failed phase. Returned native observer Promise rejections
are consumed without delaying the hook reply; warning delivery failures do not
recurse (C-HOOK-22). The same boundary covers bridge error notifications.
The one-shot initial-ready transition retains its separate C-API-42 fallback
warning and queue-release guarantee for synchronous listener throws. Returned
status/activity observer Promise rejections share the enclosing hook boundary
when readiness fires within `SessionStart`; standalone resume-composer or deadline
readiness instead reports `initial_ready_observer_failed`. Neither delays
readiness or the hook reply.

Decision note: Codex `PreToolUse` and `PermissionRequest` both produce
event-specific JSON under `hookSpecificOutput`, but they do not use the same
inner shape. `PreToolUse` uses fields such as `permissionDecision` directly
beside `hookEventName`; `PermissionRequest` nests `{ behavior, message? }` under
`decision`. Elwood mirrors the current Codex hook protocol instead of normalizing
these shapes on the wire.

### 7A.3 Readiness

For Codex, `Stop` is the canonical signal that a turn completed. If a `Stop`
handler returns a continuation/blocking decision, Elwood must not mark the
session ready. Before an unblocked Codex `Stop` marks the session ready, Elwood
should read the committed live transcript data with one bounded per-pass scan
(the same bounded read the poll timer performs, never the terminal-drain budget
reserved for PTY exit) so parent applications receive transcript-derived turn
activity before the ready transition whenever Codex has already written it.

### 7A.4 Non-Hook Transcript Activity

Current Codex hooks do not cover every TUI-visible activity. Reasoning/status
updates and non-shell/non-MCP tools such as web search can appear in Codex's TUI
and transcript without triggering `PreToolUse` or `PostToolUse`.

Elwood must document this limitation and provide a live-only transcript
observation event. The event may summarize transcript item kind, label, and text,
and may include the raw item for immediate in-memory rendering. Elwood must not
persist raw transcript items or derived prompt/tool content in Elwood state.

The finalized-Stop input boundary in §6.3 also applies to Codex: late registered
Stop-handler and initial hook/activity-observer continuations cannot admit new
queue-backed input to the same session after the result is finalized.
