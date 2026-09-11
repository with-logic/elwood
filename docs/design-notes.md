# Design notes

Purpose: the reasoning behind decisions that reviewers and integrators ask
about, plus what Elwood does and does not persist.

## Decisions

- **The agent must not know it is wrapped.** Agents run in a real PTY, not
  print mode, SDK mode, or a pipe-only subprocess, launched through the user's
  interactive login shell so PATH and environment match a human's terminal.
  Hooks and transcripts are the control and observability layer.
- **Headless terminal model.** PTY output is rendered through headless
  xterm.js before Elwood inspects TUI state, so prompt detection works on the
  rendered screen rather than on raw escape sequences.
- **Claude tool flags.** Elwood passes the camelCase `--allowedTools` /
  `--disallowedTools` flags with one comma-separated value; current
  `claude --help` documents comma or space-separated lists.
- **Claude settings.** Session-scoped settings are passed with `--settings`.
  Elwood does not mutate `.claude/settings.local.json`.
- **Codex hook enablement.** Elwood reserves `features.hooks=true` and
  `hookTrust="trust-all"` because the library is not useful unless hooks run.
- **Workspace trust.** `autotrust` is an explicit opt-in because answering
  Claude or Codex workspace trust prompts changes the security posture of the
  launched agent. The gate is independent of Claude's permission mode.
- **Codex `PermissionRequest`.** The wire response nests `{ behavior, message? }`
  under `hookSpecificOutput.decision`; `PreToolUse` uses direct event-specific
  fields. Elwood mirrors Codex's protocol rather than normalizing the shape.
- **Hooks fail open.** A handler timeout, thrown handler, invalid input, or
  invalid response is reported as `hookError` and the agent proceeds, so a
  parent-app bug cannot deadlock the wrapped agent.
- **Raw bytes.** `sendKeys(Uint8Array)` writes bytes to the PTY instead of
  decoding them as UTF-8, so forwarded user keystrokes arrive verbatim.
- **Readiness comes from signals, not files.** Observe `session.status`, the
  `status` event, or `waitForStatus`. The persisted record exists only to
  enable resume and is not part of the readiness contract.
- **Turn boundaries are deterministic.** An ergonomic turn ends when the
  transcript catches up to the `Stop` hook's expected final text, with a
  bounded quiet-window fallback for pure-tool turns. There is no whole-turn
  timeout by default; `timeoutMs` is opt-in and armed only after submission.
- **Lifecycle.** `stop()` waits for a bounded graceful exit and escalates to
  force termination; `kill()` starts with force termination. Failed cleanup
  never latches: a later call retries.
- **Version checks.** An unparseable CLI version becomes a `version_unparseable`
  warning and startup continues; `strictVersionCheck: true` fails closed. A
  failed `autoupdate` is non-fatal when the installed CLI meets the minimum
  (`agent_update_failed` warning).

## State, privacy, and safety

Elwood is deliberately live-first.

- The persisted session record is minimal: schema version, `elwoodSessionId`,
  adapter kind, `cwd`, and per-adapter resume state (the CLI's conversation id
  plus launch posture). Nothing else is written. Sessions live under
  `<cwd>/.elwood` by default; pass `stateDir` for a caller-managed location.
- Explicit loop definitions live in a separate versioned, owner-only `0600`
  sidecar with the loop message and cadence metadata, but no live timer, due
  state, or submission state. That message is the sole persisted prompt.
- Session status, timestamps, warnings, terminal size, the hook bridge token,
  the socket path, and runtime file paths are not persisted. Status and
  warnings are live-only events. Runtime paths are derived on demand; the
  socket home is a deterministic fingerprint of the session identity in a
  short Elwood-owned temp home (so a deep `stateDir` never hits the macOS
  socket path cap), while the bridge token and socket file are minted fresh on
  every start and never trusted from disk.
- Ordinary prompts, PTY output, hook payloads, hook responses, Codex
  transcript items, and derived prompt or tool content are never persisted.
- Hook bridge messages travel over local IPC with per-session tokens; requests
  are capped at 8 MiB on both sides.
- Malformed state records fail with typed `state_corrupt` errors. State
  directories are created `0700` and files `0600`.
- `teardown()` removes only Elwood-owned files: the session record, loop
  sidecar, generated settings, bridge script, and socket home. It never
  touches agent-owned auth, transcripts, or user settings.
