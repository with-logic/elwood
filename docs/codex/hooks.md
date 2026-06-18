# Codex Hooks Notes

Sources researched:

- https://developers.openai.com/codex/hooks
- https://github.com/openai/codex/tree/main/docs
- local `codex features list` output

## Events

The current documented Codex hook events relevant to Elwood are:

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

`SessionStart`, `PreToolUse`, `PermissionRequest`, `PostToolUse`,
`UserPromptSubmit`, `SubagentStart`, `SubagentStop`, and `Stop` include a Codex
permission mode field. Turn-scoped hooks include `turn_id`.

## Matchers

Hook matchers are regex strings. Tool hooks match `tool_name`; compaction hooks
match `manual` or `auto`; `SessionStart` matches the source such as startup or
resume; subagent hooks match agent type. `UserPromptSubmit` and `Stop` currently
ignore matchers.

For file edits, Codex reports the canonical tool name `apply_patch`, while
matchers may also use `Edit` or `Write`.

Tool hooks currently cover `Bash`, `apply_patch`, and MCP tool calls. They do
not cover every TUI-visible activity. In particular, Codex docs state that web
search and other non-shell/non-MCP tool calls do not trigger `PreToolUse` or
`PostToolUse` today. Reasoning/status lines shown in the TUI are also not hook
events.

Elwood therefore treats hooks as the control/approval path and uses live-only
transcript observation as a secondary rendering path for parent apps that need
to display reasoning phases, web search calls, assistant messages, and other
Codex-visible activity.

## Response Model

No output with exit code `0` means no decision and Codex continues.

Codex accepts event-specific JSON output. Important shapes for Elwood:

- `PreToolUse` can deny a supported tool call with `permissionDecision: "deny"`
  and a reason, add additional context, or allow a rewritten tool input.
- `PermissionRequest` can decide `allow` or `deny` with `{ hookSpecificOutput:
  { hookEventName, decision: { behavior, message? } } }`. It must not return
  updated input or permission edits.
- `Stop` and `SubagentStop` can return `decision: "block"` with a reason to ask
  Codex to continue instead of marking the turn done.
- `PostToolUse`, `UserPromptSubmit`, `SubagentStart`, `PreCompact`, and
  `PostCompact` are observe-only in Elwood until Codex documents a stable
  response contract for them.

Elwood should fail open when parent handlers are missing, time out, throw, or
return an invalid response for the event.

Handlers should return `undefined` for no decision. Empty objects are invalid so
accidentally empty responses surface as `hookError` and fail open.
