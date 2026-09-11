# Changelog

All notable **consumer-facing** changes to Elwood are recorded here: new or
changed public API, session/lifecycle behavior, activity/event shapes, and bug
fixes a host application would notice. Internal refactors, test-only changes,
and doc tweaks are omitted. The format follows
[Keep a Changelog](https://keepachangelog.com); this project is pre-1.0, so
everything lands under **Unreleased** until the first tagged release.

Observable behavior is specified in `PRD.md`; the conformance criteria that
back each entry are listed in PRD.md §14.

## [Unreleased]

First public release.

### Added

- Claude Code and Codex CLI adapters that run the real interactive CLI in a
  PTY, launched through the user's login shell, and observe it through a
  headless xterm.js model. macOS only; Claude Code 2.1.144+ and Codex CLI
  0.124.0+ with a `strictVersionCheck` option to fail closed on unparseable
  versions.
- `ClaudeSession` / `CodexSession` classes as the primary API: synchronous
  construction, lazy start on first use, `send(prompt)` returning the turn's
  assistant text, `stream(prompt)` yielding typed `text` / `thinking` /
  `tool_call` / `tool_result` events, and `close()`. Turns end on a
  deterministic transcript boundary, with no whole-turn timeout unless
  `timeoutMs` is passed. The eager `startClaude` / `startCodex` factories are
  deprecated but remain available.
- The full control surface on every session: `sendMessage`, `sendPrompt`,
  `sendGuidance`, `sendKeys` (string or raw `Uint8Array`), `resize`,
  `interrupt`, `compact`, `listModels`, `setModel`, `waitForStatus`,
  `waitForActivity`, `stop`, `kill`, and `teardown`, plus the exported
  `ElwoodAgentSession` type for code generic over either adapter.
- Typed hook handlers for Claude and Codex hook events, delivered over a
  local, token-protected IPC bridge with runtime validation. Handlers fail
  open; failures surface as `hookError`.
- A unified `activity` event stream (messages, reasoning, tool calls and
  results, web searches, hooks, warnings, lifecycle) with normalized
  `toolName` / `toolInput` / `toolOutput` / `turnId` fields, alongside `hook`,
  `hook:<Name>`, `warning`, `loop`, `status`, `terminal:data`,
  `terminal:exit`, and Codex-only `codex:transcript`.
- Raw `terminal:data` output for host-rendered terminals, with a 128 KB
  replay buffer for late subscribers and exactly-once `terminal:exit`.
- Persisted, resumable sessions: a minimal session record under
  `<cwd>/.elwood` or a caller `stateDir`, `resumeClaude` / `resumeCodex`, and
  `startOrResumeClaude` / `startOrResumeCodex`, which fall back to a fresh
  start only on `state_not_found`, `resume_unavailable`, or
  `adapter_mismatch`. Resume restores the persisted launch posture and
  reaches readiness in about one second.
- Recurring loops (`createLoop`, `listLoops`, `cancelLoop`, and the opt-in
  `parseLoopCommand` helper) with fixed or idle cadence, per-session limits,
  seven-day expiry, a redacted `loop` event, and a private sidecar that
  survives stop and resume.
- Image attachment on `send`, `stream`, and every send method via `images`
  (`{ path }` or `{ data, format }`), validated and bounded before submission
  and confirmed by the CLI's `[Image #N]` chip. Codex attachment drives the
  macOS clipboard under a process-wide lock.
- Model control: `listModels` / `setModel` through the adapter's `/model`
  picker without touching the user's saved defaults, `model` and
  `reasoningEffort` start options on both adapters, and the standalone
  `listClaudeModels` / `listCodexModels` probes.
- Claude login recovery: `claude_not_authenticated` at startup, a live
  `login_expired` warning mid-session, and `ClaudeSession.login()` to drive
  `/login` with a human-supplied authorization code.
- A `persona` start option delivered as the guaranteed first user message,
  and an optional best-effort `autoupdate` preflight that never fails a start
  when the installed CLI already meets the minimum version.
- Automatic answers for a narrow allowlist of startup prompts: workspace trust
  (opt-in `autotrust`), Codex hook-trust and update dialogs, and Claude's
  browser-tools onboarding. Any other dialog leaves the session `blocked`.
- The `elwood` executable: one headless turn with text, `--output json`, or
  `--output jsonl` protocols, `--stream`, `--verbose`, `--debug`, stdin and
  ordered `--image` input, `--timeout`, `--persona`, model and posture flags,
  `--keep` / `--resume` / `--ephemeral` continuation, signal-safe cleanup, and
  stable exit statuses (`0`, `1`, `2`, `124`, `130`).
- `--head` mode that mirrors the live agent TUI in the current terminal on
  stderr while keeping the final result on stdout, view-only, with terminal
  state restored on every outcome.
- `elwood config` with one strict global JSON file, typed keys, `ELWOOD_*`
  environment overrides, flag > environment > config > built-in precedence,
  `--no-defaults`, and `config effective` to explain resolved values and their
  sources without starting an agent.
- CLI agent auto-detection: with no `--agent`, `ELWOOD_AGENT`, or config
  `agent`, a new run tries `claude` then `codex` in the login shell and fails
  with `no_agent_found` (status 2) when neither resolves. Error records
  emitted before an agent was selected report `agent: null`.
- An agent-neutral "never ask for permissions" switch: `--high-trust` /
  `--no-high-trust`, `ELWOOD_HIGH_TRUST`, the `highTrust` config key, and
  `highTrust?: boolean` on both session classes and both resume functions. It
  expands to Claude `permissionMode: "bypassPermissions"` or Codex
  `sandbox: "danger-full-access"` with `approvalPolicy: "never"` before the
  posture is persisted and the process spawned. Combining it with an explicit
  per-agent posture is rejected: the CLI names both sources as a usage error and
  the library throws `claude_high_trust_conflict` / `codex_high_trust_conflict`.
  `config effective` reports `highTrust` and attributes the posture it decided
  to the high-trust source. Claude's one-time "running in Bypass Permissions
  mode" acceptance dialog is an allowlisted trust prompt answered under
  `autotrust` (`startup_prompt` label `bypass_permissions`).

### Changed

- Published as `@with-logic/elwood` under the MIT license.
- Warnings are live-only events. Nothing is persisted, replayed, or counted;
  there is no `session.warnings` property.
- The persisted session record holds only schema version, `elwoodSessionId`,
  adapter, `cwd`, and per-adapter resume state. Terminal size is not
  persisted; pass `initialSize` on resume.
- Codex `tool_call` activity reports the bare exec command as `toolInput`
  rather than the CLI's JavaScript harness wrapper.
- `ClaudeEventMap`, `ClaudeEventName`, and `ClaudeEventHandler` are the
  primary names for the Claude session event map; `ElwoodEventMap`,
  `ElwoodEventName`, and `ElwoodEventHandler` remain as deprecated aliases.
- An object-form Codex `PreToolUse` handler's `unknown` entry now receives only
  `mcp__*` / `unknown:*` tools; a `Bash` / `apply_patch` event with no per-tool
  handler yields no decision.
- The local dev apps are no longer compiled into `dist/`, and their `ws` and
  browser xterm dependencies moved to `devDependencies`, so consumers install
  only what the library uses.

### Fixed

- Trust, update, and model-switch dialogs on current Claude and Codex releases
  are recognized and answered; unrecognized dialogs block instead of guessing.
- Hook payloads are measured identically on both sides of the bridge, and
  multibyte characters split across socket chunks are decoded correctly.
- Cleanup is retryable: a failed `stop` / `kill` / `teardown` never latches,
  and post-exit `stop` / `kill` reject with the typed `termination_failed`
  rather than a bare `Error`.
- Headed CLI runs restore the invoking terminal's input and keyboard modes.
- `startOrResumeClaude` / `startOrResumeCodex` forward `reasoningEffort` (and
  every other resume option) on the resume path; a resumed session no longer
  silently loses the requested effort.
- A hook event other than `Stop` arriving after `Stop` (for example
  `Notification` or `FileChanged`) no longer clears the turn-completeness
  oracle, so late assistant text cannot leak into the next `send` / `stream`
  turn.
- Codex sessions no longer emit a false `transcript_records_dropped`
  (`unread_backlog`) warning on every turn after roughly 256 turns; each `Stop`
  now reads the transcript with a bounded per-pass scan.
- `terminal:data` replay never begins with U+FFFD; the 128 KB replay buffer
  trims on a UTF-8 code-point boundary.
- `compact()` no longer sends a stray Enter when the `/compact` write resolves
  after the compact timeout has already rejected.
- `send` / `stream` bind a turn to the first event that carries a `turnId`
  (Codex) rather than the first event of any kind.
- A transcript truncation or rotation discards the old file's buffered partial
  line instead of gluing it onto the new file's first record.
- A `PostToolUse` handler returning `{}` is accepted as "no decision" instead of
  failing open with a spurious `invalid_response` `hookError`.
- The per-hook `timeout` written into generated Claude settings and Codex
  overrides is now `hookTimeoutMs` rounded up plus five seconds, so the CLI
  never kills a hook before Elwood's fail-open reply arrives.
- `ClaudeSession.login()` no longer accumulates abort listeners and pending
  promises over a long polling flow.
- Codex `setModel` restores `config.toml` atomically (temp file plus rename,
  symlink written through, mode preserved); a crash can no longer leave the
  user's config empty. When no `config.toml` existed before the switch, the
  `codex_default_model_persisted` warning now says the picker created the file
  and Elwood left it in place.
- `setModel` reports "Could not locate the picker cursor." (still
  `model_automation_failed`) when rows parse but no cursor is rendered.
- Session records and the loop sidecar are read without following symlinks and
  are rejected as `state_corrupt` unless they are private (`0600`) regular
  files owned by the current user. Socket homes are keyed on the resolved
  `stateDir`, so relative spellings of one state directory share one home.
- A loop cancelled before its submission rejects with the typed
  `loop_submission_failed` error (with `details.loopId`) instead of a bare
  `Error`.
- A CLI version or update probe that times out or overflows now kills its whole
  process group, so a grandchild cannot outlive the bound or pin the event
  loop.
- Hook-bridge decisions larger than about 64 KiB are no longer truncated on
  macOS.
- The node-pty spawn helper's executable bit is checked before it is set, and a
  failed `chmod` is tolerated on read-only installs.
- `elwood` structured error records emitted before an agent was selected report
  `agent: null` instead of a hard-coded `"codex"`; auto-detection probes both
  agents concurrently; a login shell that cannot run the probe fails with
  `no_agent_found` naming the shell and errno; adapter-option conflicts with an
  auto-detected agent say so and suggest `--agent <other>`; config write
  failures name the path and errno; text-mode error diagnostics are suppressed
  only when stderr has closed, not stdout.
