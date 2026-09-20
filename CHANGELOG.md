# Changelog

All notable **consumer-facing** changes to Elwood are recorded here: new or
changed public API, session/lifecycle behavior, activity/event shapes, and bug
fixes a host application would notice. Internal refactors, test-only changes,
and doc tweaks are omitted. The format follows
[Keep a Changelog](https://keepachangelog.com); this project is pre-1.0, so
everything lands under **Unreleased** until the first tagged release.

Observable behavior is specified in `prd/`; the conformance criteria that
back each entry are listed in `prd/14-conformance.md`.

## [Unreleased]

- Codex transcript listeners can stop a session without moving pending transcript
  activity past terminal exit, duplicating exit, or re-signaling an already-exited
  PTY during the final flush. Transcript diagnostics preserve the same ordering.
- Preserve Claude `StopFailure` hooks with missing or changed diagnostic fields. Those
  fields are now typed as optional `unknown`, matching ingress. Browser logs show a
  bounded rejection reason instead of unrelated assistant text or a blank summary.

- Route Codex tool-keyed hooks from own properties only. A `PreToolUse` map is a
  plain object, so a tool name matching an inherited member (anything on
  `Object.prototype`, or a key on a caller-supplied prototype) used to resolve to a
  function the caller never registered for that tool and run it against the hook
  event. Both the exact-name and `unknown` lookups now require an own property,
  matching Claude routing.
- Hold the cross-process update lease for an aborted updater's surviving process
  group. An update probe that was aborted without confirming its process group had
  exited used to release the lease anyway, so another Elwood host could start a
  competing installer while the first updater's descendants were still running.
- Bound the cleanup of an aborted version, capability, or update probe to one
  extra second: retry process-group termination, fall back to the direct child,
  and keep an unresolved group on an asynchronous reaper that never extends host
  shutdown or retains captured output. A process group is signaled only while its
  leader is unreaped, so a reissued group id is never killed. An update probe whose
  group stays unconfirmed now reports that group in its typed error details.
- Serialize `listModels`/`setModel` through the session input queue: a model
  operation owns the queue until its picker flow settles, so overlapping model
  calls, queued commands, and messages can no longer be typed into a picker while
  the operation that opened it is running. `compact`'s delayed recovery Enter is
  cancelled once a later operation takes the composer, rather than queued behind it.
- A Codex `setModel` interrupted by session termination waits for the CLI process
  to exit before restoring `config.toml`, bounded at five seconds so a process that
  never reports an exit cannot hold the shared config lock. Session status alone
  (`stopped`, `killed`, `torn_down`) no longer releases the restore, since teardown
  records those even when its signal did not take. The wait now applies whether the
  switch succeeded or failed: the question is whether the dying CLI can still write
  `config.toml`, not whether Elwood's automation worked.
- A Codex `setModel` still waiting for the process-wide `config.toml` lock rejects
  with `session_not_running` as soon as its own session closes, instead of staying
  pending until the session ahead of it finishes its transaction and exit wait. A
  cancelled call never runs its switch when the lock frees.
- Stop non-trust startup automation from writing into a trust gate that arrived while
  the previous screen was still rendering. The Codex update skip (including its retries)
  and the Claude browser-tools decline now observe all received PTY output and re-check
  the settled frame before writing, the guarantee queued caller input already had. A
  withheld write is silent and stays retryable; the trust responder is unaffected and
  still answers trust gates itself.
- Hold queued input on an unrecognized gate behind a recognized native header
  prefix (`Do you`, `Is this`, `Trust the`, ... — PRD §5.4 lists them): a reworded
  question with selectable options and a frame-ending native footer, and no
  conversation above, now blocks for a human with the attention label
  `<agent>-unknown_gate-prompt` under every `autotrust` value and is never answered
  automatically; previously readiness could type the queued message and Enter
  into it. Gates outside that grammar (other leading words, other footers) are
  still not held. Dialogs that already block keep their existing labels.
- Bound Codex in-TUI update skipping to one attempt per appearance of the update
  screen: an exhausted retry no longer restarts on the next frame of the same
  screen, and a stale attempt's late completion cannot start an overlapping retry
  loop or report success or a write failure for the newer screen. A skip write
  rejected after the update screen already cleared no longer fails a healthy
  headless run as `blocked_prompt`. A reappearing update screen is still skipped again.
- Emit the `attention` activity for a blocking prompt that painted while the
  session was still `starting`. Such a session already became `blocked`, but
  without the human-decision event, so a headless `elwood` run never reported
  `blocked_prompt`.
- A failed `listModels`/`setModel` now cancels the model dialog it left open
  before releasing queued input, and holds queued messages, commands, and `/login`
  while a dialog it could not cancel stays visible. Picker text quoted in a reply
  is never cancelled, so cleanup cannot interrupt a running turn.
- `setModel` no longer resolves on the partially painted frame that precedes
  Claude's cache warning (it reported success without confirming the switch), and
  queued input stays held while a Claude switch dialog is still painting.
- Model-picker cleanup also covers a dialog that paints up to a second after the
  failure (a late picker, Codex's reasoning level, Claude's cache warning). A model
  operation now rejects without writing when model picker text is already visible.
- `compact`'s recovery Enter can no longer be typed into a model picker opened by
  a concurrent `listModels`/`setModel` (where Enter saves the highlighted model as
  the default): it now waits for the picker operation to release the input queue.
- Snapshot image bytes and relative paths when facade methods are called, including
  turns queued behind another response or waiting for session startup. Facade copies
  count against the same 200 MiB per-session ceiling as sends on the raw `session`.
- Reject FIFO state/config files without hanging.
- Runtime cleanup drains received terminal output before disposing the renderer —
  for up to one second, including output that arrives while it drains — so the
  final `terminal:data` tail is delivered (possibly after `terminal:exit`) instead
  of dropped. `--head` now mirrors through cleanup, so the agent's final frames
  (for example its last words before an unexpected exit) are no longer cut off.
- Bind automatic trust approvals to the active dialog and revalidate every write,
  preventing quoted transcript headers or unknown intervening titles from
  authorizing unrelated permissions. Cancel stale trust attempts quietly while
  keeping readiness and queued input gated until the native dialog clears. Retry
  early numbered trust writes that the CLI has not yet consumed. Bound both
  navigation styles to the session and current dialog generation; unsupported or
  exhausted trust automation becomes a recoverable block after five seconds.
  Image attachment is held by the same trust gate as text input.
- Require a trust dialog's native explanatory copy before any automatic approval:
  a bare allowlisted header with affirmative options is held, never typed into,
  and becomes answerable only once its native body paints (recoverable `blocked`
  after five seconds otherwise). Skill, plugin, and MCP gates are unchanged.
- Release the cross-process update lease atomically. A second Elwood process polling
  at the instant the owner released could recover the half-removed lease as stale
  and run a duplicate `autoupdate` right after the first.
- Publish the cross-process update lease atomically. An Elwood process killed
  while claiming the lease could leave a partial owner record that made every
  later `autoupdate` on that machine skip its update until the cache was removed
  by hand.
- Queued input now renders and observes all PTY output already received before
  each write, so a trust or permission dialog that was received but not yet
  rendered still holds the paste, its Enter, and recovery Enters. The compact
  recovery Enter follows the same rule and is cancelled once a later queued
  operation dispatches. On the terminal handle, `settled()` now also covers output
  received while waiting (it still never rejects), and the new read-only
  `renderFailed` property reports a failed render, after which queued input stays
  withheld.
- Keep text CLI output limited to agent responses by default. Use
  `--show-session-id` to print the retained session ID on stderr, or find it
  with `elwood sessions`. Session retention and JSON/JSONL records are unchanged.
- Batch terminal rendering, improving throughput across parallel sessions:
  adjacent PTY chunks share one render and one `terminal:data` event (at most
  64 KiB, flushed within 4 ms), so event chunk boundaries and intermediate frames
  are no longer guaranteed. Direct terminal disposal settles pending writes
  immediately. Real PTY reads pause when unrendered output reaches 1 MiB and resume
  below 512 KiB, so a runaway producer cannot grow the render backlog without bound;
  a paused PTY resumes as soon as its child exits, so a draining backlog cannot
  strand unread tail output.
- Recognize only native Codex warning banners, keeping quoted private prompt text
  out of warning events by requiring the current native welcome region.
- Validate all concrete Claude tool input fields and typed hook fields, constrain
  permission rewrites to tool-specific handlers, and accept nullable Codex descriptions.
- Bound the wait for another Elwood process's `autoupdate` to 60 seconds. A
  contender that is still waiting then skips its update and continues with the
  installed CLI, reporting `agent_update_failed` with `errorCode: "update_active"`
  instead of waiting indefinitely; the active owner's lease is never evicted.
- Match Claude task identifiers and plan permission objects to the native hook
  schemas so valid task and plan inputs reach their handlers.
- Contain clipboard pipe failures during Codex image attachment, and retain the
  clipboard lock until the restore process exits.

## [0.1.3] - 2026-09-14

- Keep live session warnings quiet in text and JSON CLI output, including model
  discovery; enable them with `--verbose` or `--debug`. JSONL warning events and
  fatal errors remain available as before.

- List both Claude and Codex catalogs in bare `elwood models`, with agent
  associations, partial failure diagnostics, and one shared timeout budget.
  Explicit `--agent` keeps the single-agent output contract.

- Preserve new CLI sessions by default so they can be listed and resumed; use
  `--ephemeral` to remove new or resumed Elwood state after the run.

## [0.1.2] - 2026-09-13

- Preserve the inherited PATH when an interactive login shell exits successfully
  without returning the PATH probe.

- Keep permission dialogs blocking across cursor movement and hold slash-command
  input and recovery Enter while a decision is pending; cancel expired picker submissions.
- Reject planted state-directory and generated-file links before permission changes or writes.
- Forward `highTrust` on start-or-resume, wait for model-discovery readiness,
  and resolve session listings independently of agent-specific environment defaults.
- Align foreground interactive launches with login-shell agent detection.
- Correct trust and IPC-persistence documentation, include linked package references,
  and revalidate mutable website sprites using fresh URLs for previously cached clients.

## [0.1.1]

First usable public release.

0.1.0 was published from a checkout that sat 18 commits behind `main`. It
shipped without the `resume`, `sessions`, `interactive` and `models`
subcommands, without `--high-trust`, without agent auto-detection, and with a
stale README. Nothing was wrong with 0.1.0's own code; it was simply built from
the wrong commit. 0.1.1 is the same work published from `main`, and is the
version to install.

### Added

- **The `elwood` CLI now explains and cleanly overrides its effective behavior.**
  `--no-stream` and `--no-verbose` reverse inherited boolean defaults,
  `--no-defaults` bypasses saved config and `ELWOOD_*` run settings, and
  `elwood config effective` reports validated launch/output values with their
  provenance without starting an agent. Routine warnings now reach stderr for
  text and JSON runs, `--verbose` is a concise elapsed progress view, and
  `--debug` retains full sanitized event detail. JSONL records include elapsed
  timing plus tool-call correlation IDs when available. Help, validation errors,
  resume/persona/ephemeral wording, and the new scripting guide now make defaults,
  recovery actions, and lifecycle effects explicit. (§5.8/§12A,
  C-API-48/C-CLI-02/03/08/10/11/14/19/20)
- **The `elwood` CLI can now mirror the live agent TUI in the current terminal.**
  `--head` sends the agent's ordered raw VT/ANSI stream to terminal stderr while
  preserving the final text or JSON result on stdout, including cursor-addressed
  redraws, alternate screens, colors, spinners, and OSC title changes. It follows
  terminal resizes, restores terminal modes on every handled outcome, and treats
  Ctrl-C like the existing interrupt lifecycle. The display is intentionally
  view-only and cannot be combined with `--stream`, `--verbose`, or JSONL.
  Pending terminal writes are bounded by bytes and frame count, so a stalled
  terminal becomes a clean run failure instead of an unbounded memory queue.
  An argument-free `elwood` invocation now prints help instead of waiting for a
  prompt. (§12A.1/§12A.6, C-CLI-02/C-CLI-18)
- **The `elwood` CLI gained `sessions`, `resume`, `interactive`, and `models`
  commands.** `elwood sessions` lists Elwood-owned session records (id, agent,
  workspace, `createdAt`/`lastUsedAt`, `resumable`, socket-presence `live`) as an
  aligned table or one `{"type":"sessions"}` JSON document without starting an
  agent. `elwood resume <id> [prompt...]` is a parse-time rewrite of
  `run --resume <id>`. `elwood interactive [id]` runs the real `claude`/`codex`
  TUI in the foreground with Elwood's resolved agent, model, effort, workspace,
  and posture passed as the agent's own flags — no PTY, automation, observation,
  or state — resuming a stored session's own conversation when given an id.
  `elwood models` starts the agent briefly, reads its model picker through the
  public `listModels` operation, tears the session down, and prints a table or a
  `{"type":"models"}` document of `AgentModelOption` rows. The adapters' launch
  flag mapping now lives in shared `claudeLaunchArguments`/`codexLaunchArguments`
  builders so interactive and headless launches cannot drift. (§12A.7–§12A.10,
  C-CLI-23 through C-CLI-26)

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
- The published package runs no install scripts. `dist/` is built before publish
  (`prepublishOnly`) and shipped in the tarball, so `npm install -g
  @with-logic/elwood` needs no build step and raises no npm allow-scripts
  prompt for Elwood itself. Working from a checkout now requires an explicit
  `npm run build` before `npm link`.
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

- **Headed runs no longer suspend themselves or leave the invoking terminal unusable.**
  Interactive version and capability probes now run in an isolated process session,
  preventing their shell-managed commands from stealing the real terminal's foreground
  process group. `--head` can therefore restore cooked input and display modes before
  returning to an interactive shell, without a cleanup-time `SIGTTOU` stop or leaked
  terminal-protocol replies. Its defensive restore now also pops the Kitty keyboard
  enhancement mode used by current agent TUIs, so subsequent shell keystrokes remain
  ordinary text instead of encoded key-event sequences. (§12A.6, C-CLI-18)
- **Codex's startup update dialog no longer wedges headed or headless runs.**
  Codex 0.153.x can paint its numbered update menu before its input loop accepts
  the first safe Skip hotkey. Elwood now retries that hotkey for a bounded interval
  only after revalidating the complete current update dialog, and the CLI no longer
  mistakes the responder-owned dialog's replayed blocking edge for a human prompt.
  A persistent or unanswerable update dialog now fails and cleans up boundedly even
  without `--timeout`; no retry can escape into the composer or another dialog.
  (§5.5/§12A.2, C-CODEX-12/C-CLI-05)
- **Headless turns now survive real-CLI startup, resume, and teardown races.**
  Codex 0.153.3 can accept the 10-second fallback paste into its cold-start
  placeholder, swallow it during a later boot repaint, and appear to finish an
  empty turn; ergonomic turns now require positive submission evidence, replay
  an unaccepted prompt at most twice, and fail explicitly instead of reporting
  false success. A resumed Claude turn no longer treats its stale composer as
  an immediate end before real work paints. The headless owner also ignores
  transient attention from trust prompts it is already authorized to answer,
  and macOS teardown retries the short-lived post-exit `EPERM` process-group
  window instead of surfacing `cleanup_failed`. (§5.3/§5.8/§12A, C-API-48,
  C-TURN-03, C-CLI-05/09)
- **Claude model switches now complete through model/effort cache warnings.**
  Claude 2.1.258 may interpose `Switch model?` or `Change effort level?` after
  Elwood applies a session-only picker choice; Elwood previously treated that
  dialog as successful picker closure and returned while the session was still
  waiting. Elwood now recognizes numbered and unnumbered variants, navigates
  from the rendered cursor to the affirmative action, confirms the built-in
  cache warning, and waits for the idle composer before resolving `setModel`.
  Recognition is scoped to the bottom-most live dialog and revalidated before
  Enter, so transcript text cannot spoof a cache warning or composer. Hook-requested
  `PreModelSwitch` confirmations remain blocking and human-controlled. (§5.3,
  C-API-24/C-ATTN-04)
- **Concurrent Codex starts no longer race global npm updates.** Codex's live
  update dialog is now input-blocking until its rendered frame clears, so queued
  persona/caller input cannot press Enter on the default "Update now" action when
  a prompt layout is partial or drifts. Elwood still skips every recognized safe
  option automatically. Separately, `autoupdate` now holds an atomic per-user,
  per-adapter cross-process lease around the global updater; another Elwood host
  waits asynchronously, skips its duplicate install, and validates the resulting
  binary. The lease uses a stable account cache across differing `TMPDIR` values,
  records its owner/generation so live or successor updates cannot be evicted,
  and recovers dead owners safely. Failed partial installs also invalidate version
  and capability caches before validation. Coal Harbor and other consumers need
  no API or configuration changes. (§5.5/§9.2, C-CODEX-12/C-PERF-04/C-LIFE-09)
- **Claude's current cursor-style workspace trust prompt is auto-approved again.**
  Claude 2.1.252 replaced the older numbered, affirmative-first layout with an
  unnumbered menu that defaults to `No, exit`; the responder recognized its header
  but found no numbered affirmative, wrote nothing, and the readiness fallback
  could report `ready` over the still-visible gate. Elwood now supports both
  layouts, navigates cursor menus to the affirmative before Enter, keeps their
  entire option region out of header recognition, and verifies the real trust
  screen clears before readiness. The gate remains independent of Claude's
  `bypassPermissions` / `--dangerously-skip-permissions` policy. (§5.1/§5.3,
  C-CLAUDE-10/C-CLAUDE-14/C-E2E-09)
- **Modern Codex final replies now carry their text on `assistant_message`
  activity.** Codex 0.149.1 writes replies as assistant `message` response items
  with `phase: "final_answer"` and `content[].output_text`; Elwood previously
  expected a plain string (or a legacy `agent_message` duplicate), so consumers
  received a textless event and could silently discard the reply. Elwood now
  extracts the full final-answer text—including `@mentions`—while keeping
  commentary and user/developer transcript records out of assistant activity.
  (§5.4/§7A.4, C-API-12/C-CODEX-16)
- **Claude's `Not logged in · Run /login` sign-out is now detected mid-session.**
  A ready Claude session that gets logged out mid-run renders `Not logged in`
  (paired with a `run /login` hint) — a different wording than the `Login expired`
  / `Session expired` / `OAuth token revoked` banners Elwood already recognized.
  That form previously went undetected mid-session, so no `login_expired` warning
  fired. It now surfaces the same content-free `login_expired` warning (+ `warning`
  activity), leaving the session alive to recover via `session.login()`. (§5.3/§5.7,
  C-CLAUDE-17/18)
- **Codex's in-TUI update prompt is now re-skipped on the restart loop.** Elwood
  always skips Codex's interactive "update available" prompt (it never selects
  "Update now"; the real update is the `autoupdate` preflight). The skip was latched
  once per session, so if Codex restarted and the SAME update screen reappeared — the
  update did not take — the session got stuck looping on it. The skip is now
  edge-triggered: it re-arms when the update screen leaves the frame and re-skips the
  reappearance. (§5.5, C-CODEX-12)
- **Autoupdate is now best-effort and never fails a start on its own.** When
  `autoupdate: true` and `claude update` / `codex update` fails (a flaky network,
  a partial native-installer download, contention during a fleet launch), Elwood no
  longer rejects `startClaude`/`startCodex` with `claude_update_failed` /
  `codex_update_failed`. If the INSTALLED CLI still meets the minimum version, the
  session starts from it and Elwood emits a live `agent_update_failed` warning (safe
  diagnostics only: installed version, an allowlisted error code, bounded stderr).
  Startup fails only when the installed version is actually below the minimum. The
  warning is zero-burden — a consumer that does not subscribe to `warning` is
  unaffected and the session still reaches `ready`. (§9.2, C-LIFE-11)
- **A failed shared update no longer poisons the process.** A once-per-process
  update/probe cache that rejected was retained and replayed, so one failed
  `claude update` could reject every concurrent roster start AND every later start
  until the process restarted. Cached probes (autoupdate, version read, capability
  detection) now never retain a rejected result: concurrent callers share one attempt
  and a later caller re-attempts rather than inheriting the failure. (§9.2,
  C-LIFE-09/11)

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
