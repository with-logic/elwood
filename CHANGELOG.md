# Changelog

All notable **consumer-facing** changes to Elwood are recorded here — new or
changed public API, session/lifecycle behavior, activity/event shapes, and bug
fixes a parent app would notice. Internal refactors, test-only changes, and doc
tweaks are omitted. The format follows [Keep a Changelog](https://keepachangelog.com);
this project is pre-1.0, so everything lands under **Unreleased** until the first
tagged release.

Conformance criteria (`C-API-*`, `C-CODEX-*`, `C-TURN-*`, …) reference `PRD.md`.

## [Unreleased]

### Changed

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
