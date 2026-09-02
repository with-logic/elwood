# Changelog

All notable **consumer-facing** changes to Elwood are recorded here — new or
changed public API, session/lifecycle behavior, activity/event shapes, and bug
fixes a parent app would notice. Internal refactors, test-only changes, and doc
tweaks are omitted. The format follows [Keep a Changelog](https://keepachangelog.com);
this project is pre-1.0, so everything lands under **Unreleased** until the first
tagged release.

Conformance criteria (`C-API-*`, `C-CODEX-*`, `C-TURN-*`, …) reference `PRD.md`.

## [Unreleased]

### Fixed

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

### Added

- **`reasoningEffort` is now a first-class start/resume option on both adapters.**
  `startClaude`/`resumeClaude` accept `reasoningEffort?: ClaudeReasoningEffort`
  (`low`/`medium`/`high`/`xhigh`/`max`), forwarded to Claude's `--effort` flag;
  `startCodex`/`resumeCodex` accept `reasoningEffort?: CodexReasoningEffort`
  (`none`/`minimal`/`low`/`medium`/`high`/`xhigh`/`max`), forwarded as the reserved
  `-c model_reasoning_effort=<value>` override (applied after caller `configOverrides`
  so it wins a duplicate). The two enums differ per CLI; Elwood validates the value
  against the adapter's enum BEFORE spawn and rejects an out-of-enum value with the
  typed `claude_invalid_reasoning_effort` / `codex_invalid_reasoning_effort` error
  (Codex otherwise fails server-side only at the first turn). Effort is independent of
  `model`, applies to the launched session only, and is NOT persisted — a resume must
  re-supply it, exactly like `model`. Both enums are exported. (§5.1/§5.5, §5.2/§5.6,
  C-CLAUDE-20, C-CODEX-21)
- **`ClaudeSession` / `CodexSession` classes are now the primary API.** One class per
  adapter exposes BOTH the ergonomic `send`/`stream` convenience AND the full control
  surface (`sendMessage`, `sendPrompt`, `sendGuidance`, `sendKeys`, `resize`,
  `interrupt`, `compact`, `listModels`, `setModel`, `on`/`off`, `waitForStatus`,
  `waitForActivity`, `stop`/`kill`/`teardown`, Claude's `login`), and every method is
  lazy-start-aware. Construct synchronously (`cwd` defaults to `process.cwd()`, so
  `new ClaudeSession()` is valid); the underlying session starts lazily on first use
  (or an explicit `start()`). `on`/`off` may be called before start (buffered, attached
  on start). `await session.send(prompt)` returns the turn's assistant text as a string
  (every `assistant_message`, `\n\n`-joined; no thinking/tool text).
  `for await (const ev of session.stream(prompt))` yields simplified typed events —
  `{type:"text"|"thinking"|"tool_call"|"tool_result"}` — as they arrive. `send` is
  `stream` drained for text; turns are serialized; `close()` stops the session (safe in
  a `finally`). The turn boundary is DETERMINISTIC: it ends the instant the transcript
  catches up to the `Stop` hook's expected final text (a completeness oracle, not a
  timer), with a bounded quiet-window fallback for pure-tool turns. There is no
  whole-turn timeout by default — a turn may run for hours — with an opt-in `timeoutMs`
  ceiling and a tight post-`ready` `catchUpMs` cap (default 10s) that fails fast if the
  transcript never catches up. Buffered turn state is bounded (rolling oracle window;
  unconsumed events capped by both count and total UTF-8 bytes) so an hours-long or
  verbose turn cannot exhaust the host; the opt-in `timeoutMs` is armed only after submission,
  so it never rejects a prompt that then submits. (§5.8, C-API-47…53)

### Deprecated

- **`startClaude` / `startCodex` are deprecated** in favor of the `ClaudeSession` /
  `CodexSession` classes (which lazily wrap the same session). They remain functional
  and internally used; migrate to `new ClaudeSession(options)`. The low-level session
  interface type is now exported as `ClaudeSessionApi` / `CodexSessionApi` (the class
  owns the `ClaudeSession` / `CodexSession` name).

### Changed

- **A `terminal:data` subscriber added after startup is now registered BEFORE its
  buffered output is replayed.** A subscriber handler that throws while processing the
  replayed startup buffer stays subscribed for future terminal data instead of being
  silently dropped. Behavior is unchanged for non-throwing handlers.
- **Warnings are now live-only; the `session.warnings` property is removed.** A
  warning is emitted once, when observed, as a `warning` event plus its `activity`
  — it is never persisted, never replayed to a late subscriber, never deduplicated
  across time, and never accumulated into a running count. Consumers must collect
  warnings off the `warning` event (a late subscriber no longer sees a replayed
  snapshot). Transcript drop / read-error warnings lose their `droppedCount` /
  `droppedBytes` / `errorCount` fields (a content-free live warning keeping its
  `cause` / `lastErrorCode` label); drops are coalesced per scan pass — many
  malformed records in one bounded scan surface at most one warning per
  `(path, cause)` rather than one per record. The `initial_ready_fallback` warning
  loses its `reason` field. This closes the
  false-unread-on-resume reports at the source: a resumed session no longer replays
  a prior session's stale warnings as if they were live. (C-API-14, C-CLAUDE-15,
  C-API-42)

- **`session.json` is now minimal.** The persisted session record holds only what
  resume genuinely needs: schema version, `elwoodSessionId`, adapter, `cwd`, and
  per-adapter resume state (the CLI's conversation id + launch posture). Session
  status, timestamps, warnings, caller metadata, terminal size, the hook-bridge
  token, the socket path, and Elwood-owned runtime file paths are no longer written.
  Runtime paths are derived on demand from `(stateDir, id, adapter)`; the socket
  home is a deterministic fingerprint of that same identity (stable across a
  session's launches, distinct for a shared explicit id in another state dir),
  while the bridge token and the socket file inside the home are minted fresh on
  every start/resume and never trusted from disk. Behavior for callers is unchanged except that a resumed session no
  longer restores a persisted terminal size — pass `initialSize` on resume to set
  geometry (it otherwise falls back to the default). (§8.2)

- **Resumed sessions reach readiness in ~1s instead of ~10s.** On resume, Codex does
  not re-fire its `SessionStart` hook, so readiness previously fell through to the 10s
  starvation deadline; Claude's `InstructionsLoaded` *does* re-fire on resume. A
  resumed session now marks ready on whichever arrives first — the readiness hook or
  the first rendered composer frame (the input loop is live on resume, unlike the
  cold-start placeholder, so the composer is a safe signal there). A blocking dialog
  on that first frame does **not** mark ready (its caret is byte-identical to the
  composer marker), so readiness waits for the dialog to clear. Cold-start behavior
  is unchanged. (C-API-28)

- **Codex exec tool calls now surface the *bare* command, not the JS harness.**
  The modern Codex `exec` tool wraps its command in a JavaScript snippet
  (`const r = await tools.exec_command({"cmd":"echo hi",…}); text(r.output);`).
  A `tool_call` activity's `toolInput` is now the unwrapped command (`echo hi`; a
  `command` array is space-joined), with the `workdir`/`yield_time_ms`/… harness
  fields stripped. The classic `shell`/`exec_command` JSON `arguments` form is
  unwrapped the same way; an unparseable wrapper falls back to the raw string.
  Consumers can drop any client-side unwrapping. (C-CODEX-19)

- **`sendPrompt`, `sendMessage`, and `sendGuidance` all serialize on the same control
  queue — but with different readiness policies (per §5.3), not "all held until
  ready".** `sendMessage` waits for the next `ready` transition before it submits;
  `sendPrompt` writes immediately without waiting for turn readiness (it still
  serializes against other queued ops); `sendGuidance` queues like `sendMessage`
  before first readiness and while blocked, but during a post-ready running turn it
  overtakes readiness-waiting operations and enters the TUI immediately. Only
  `sendKeys` bypasses the queue entirely — the deliberate raw-input escape hatch.

### Fixed

- **A failed or slow overlapping launch can no longer break a live session's hook
  bridge.** The per-session socket home is stable and shared across a session's
  launches; a failed start/resume now removes only its own socket file, never the
  whole home, so it cannot delete a concurrently-live launch's bound socket (which
  would have silently failed every later hook). Teardown still removes the whole
  home. The home is also restored to private `0700` on every launch and rejects a
  planted non-directory at its predictable path. (§8.1, §9.1)
- **A relative `cwd` is resolved once at the start boundary.** `startClaude`/
  `startCodex` now resolve `cwd` (like `stateDir`) to absolute BEFORE the awaited
  preflight, so a `process.cwd()` change during preflight can no longer split where
  state is written and persisted from where the CLI launches. (§8.2)
- **A transcript drop/read-error warning can no longer fire after `terminal:exit`.**
  A Claude poll that found the watcher finished mid-pass could still flush that
  pass's drop past the permanent terminal latch; it now discards the pass. (§5.4)
- **Every startup warning is delivered.** The startup warning buffer no longer caps
  silently at 64 entries — a pathological startup can no longer drop the tail
  (including the guaranteed `version_unparseable` warning). (C-API-14)

- **Resume no longer emits a phantom turn / false "unread".** After a resumed
  session reached readiness, the transcript replay repainted prior turns whose
  footer lines read as "working", fabricating a spurious `running → ready` cycle on
  every resume. Rendered turn edges are now suppressed through the replay until the
  composer has stayed quiet and non-blocking for a SUSTAINED run of frames — the
  real Codex CLI repaints those footers in bursts with brief quiet gaps, so
  releasing on the first quiet frame let a later burst still fire the phantom;
  a working/blocking frame during suppression resets the run. Evidence-based turns
  (a caller submission, hooks) are unaffected. Verified against the real Codex CLI.
  (C-TURN-03)

- **A resume could never leave the queue permanently starved by a failed
  transition.** Initial readiness now latches only *after* its callback completes,
  so a throwing readiness callback is retried on the next hook/frame/deadline
  rather than consuming readiness and wedging the queue. (C-API-28)

- **The 8 MiB hook-request cap is now measured identically on both sides.** The
  child bridge script capped RAW stdin while the parent IPC server capped the
  JSON-wrapped wire envelope, so an escape-heavy hook input (backslash/quote-heavy
  tool output) could pass the child's cap yet be rejected by the server, silently
  losing the hook decision. The child now measures the same encoded envelope the
  server does and fails open before connecting, so the two never disagree. (C-HOOK-16)

- **Hook payloads with multibyte characters split across socket chunks are no longer
  corrupted.** Both the child bridge script and the parent IPC server decoded each
  byte chunk independently, so a UTF-8 code point straddling two chunks (emoji,
  CJK, accented text) became replacement characters before the hook input was parsed.
  Both sides now accumulate raw bytes and decode once at the frame boundary. (C-HOOK-16)

- **A throwing warning listener never stops transcript observation.** Warning
  delivery is contained at the emit site, so a throwing `warning`/`activity`
  listener cannot escape into the poll loop and stop the transcript watcher or
  wedge frame processing. The watcher stays live (both adapters). Warnings are
  live-only: a contained failure means that one live warning is not delivered, not
  that any aggregate is retained or replayed.

- **An empty-ish non-array `images` value now rejects instead of sending silently.**
  An untyped caller passing `""` or `{ length: 0 }` as `images` took a no-image fast
  path and the text was sent with no error; only a genuinely absent list (or an empty
  array) skips attachment now — anything else is validated and rejects `invalid_image`.
  (C-API-44)

- **`transcript_read_error`'s `lastErrorCode` is always a string (both adapters).** A
  non-string errno `code` (e.g. a numeric code) is normalized to `"UNKNOWN"` instead
  of round-tripping a number through the string-typed warning field.

- **Transcript reading no longer spins on an incomplete UTF-8 tail.** A partial
  write that ends mid-code-point made the reader re-read the same bytes up to
  64×/second per session; it now reports no-progress and resumes on the next tick
  once the rest of the code point is committed (both adapters).

- **A malformed `images` send on a terminated session rejects `session_not_running`,
  not `invalid_image`.** Image validation used to run before the lifecycle guard, so a
  bad image on a stopped/killed/torn-down session reported the wrong error; terminal
  status now takes precedence. (C-API-25)

- **A per-session ceiling now bounds queued image-clone memory.** Beyond the
  per-submission 50 MiB limit, at most 200 MiB of cloned image bytes may be held across
  all not-yet-attached queued submissions; a submission that would exceed it rejects
  `invalid_image`, and reservations release as submissions settle. This prevents a slow
  paste/confirmation from letting many legal queued sends retain gigabytes of clones.
  (C-API-44)

- **Codex transcript reading is bounded and crash-safe.** The reader reads in
  fixed-size chunks with a max-pending ceiling, streams a large backlog across poll
  ticks, and drains within a bounded budget at exit — a hundreds-of-MiB transcript
  can no longer OOM or block the event loop. Lost data surfaces as the content-free,
  count-free `transcript_records_dropped` warning (a live event, cause-tagged, not
  persisted or counted); a scan that throws is contained and surfaced as
  `transcript_poll_stopped` (both now `agent: "codex" | "claude"`).
  `finish()` is terminal and idempotent. (C-CODEX-20)

- **Guidance/message delivery is never wedged by a throwing listener.** A throwing
  `status` or `activity` listener can no longer wedge the control queue mid-turn:
  the queue is released first and any warning delivery is isolated. (C-API-42)

- **Runtime cleanup is failure-safe and retryable.** A failed `stop`/`kill`/
  `teardown` no longer latches — a later call retries — and every cleanup step runs
  even if an earlier one throws, so a failing bridge stop never leaks the terminal
  or transcript watcher. (§9.4)

- **A runtime-cleanup failure in `stop()`/`kill()` now rejects with the typed
  `termination_failed`, not a raw `Error`.** The cleanup aggregator threw a bare
  `Error` on the assumption its caller wrapped it, but the shutdown boundary awaited
  it directly — so a failing bridge/watcher/terminal cleanup could escape `stop()`
  /`kill()` untyped, violating the stable public error contract. It is now folded
  into `termination_failed` with the underlying reason as `cause`. (§10, C-LIFE-10)

- **Image attachment size limits apply to file-path inputs too.** Path images now
  count toward the same aggregate byte ceiling as byte inputs, and an entry must be
  exactly `{path}` or `{data, format}` (extra keys are rejected). (C-API-44)

- **A `{data}` image buffer is now cloned at the send call, not at queue dispatch.**
  Previously the defensive clone ran inside the queued op, so a caller that reused
  or mutated its `Uint8Array` between the `sendMessage`/`sendPrompt`/`sendGuidance`
  call and the (possibly much later) dispatch could change what got attached — the
  opposite of the documented guarantee. The clone now happens synchronously at the
  call. A knock-on: a malformed or over-limit `images` input now rejects
  synchronously *before* the submission is queued (rather than at dispatch), so it
  never occupies a queue slot; the promise still rejects with `invalid_image`.
  Path readability/size checks still run at dispatch (a file made unreadable after
  the call still rejects). (C-API-44)

- Post-exit `stop()`/`kill()` are documented correctly: they do not re-signal the
  PTY but still confirm/retry the process-group reap and may reject with
  `termination_failed` (they are not silent no-ops).

### Notes for consumers

- **Observe readiness through the signals Elwood sends — not the state file.** Use
  `session.status`, the `status` event, or `await session.waitForStatus(s => s ===
  "ready")` on the live session object. The persisted `session.json` is internal
  state (it exists to enable resume); its `status`/timing is not part of the
  readiness contract and should not be polled.
