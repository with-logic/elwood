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

- **Resumed sessions reach readiness in ~1s instead of ~10s.** On resume the CLI
  reattaches to an existing conversation and does not re-fire its pre-input
  readiness hook (`SessionStart`/`InstructionsLoaded`), so readiness previously
  fell through to the 10s starvation deadline. A resumed session now marks ready
  on the first rendered composer frame — verified safe (the input loop is live on
  resume, unlike the cold-start placeholder). A blocking dialog on that first frame
  does **not** mark ready (its caret is byte-identical to the composer marker), so
  readiness waits for the dialog to clear. Cold-start behavior is unchanged.
  (C-API-28)

- **Codex exec tool calls now surface the *bare* command, not the JS harness.**
  The modern Codex `exec` tool wraps its command in a JavaScript snippet
  (`const r = await tools.exec_command({"cmd":"echo hi",…}); text(r.output);`).
  A `tool_call` activity's `toolInput` is now the unwrapped command (`echo hi`; a
  `command` array is space-joined), with the `workdir`/`yield_time_ms`/… harness
  fields stripped. The classic `shell`/`exec_command` JSON `arguments` form is
  unwrapped the same way; an unparseable wrapper falls back to the raw string.
  Consumers can drop any client-side unwrapping. (C-CODEX-19)

- **`sendPrompt`, `sendMessage`, and `sendGuidance` all queue until readiness.**
  All three go through the same control queue and are held until the session is
  ready (they differ only in readiness policy, per §5.3). Only `sendKeys` writes
  raw input immediately — it is the deliberate escape hatch and does **not** queue.

### Fixed

- **Resume no longer emits a phantom turn / false "unread".** After a resumed
  session reached readiness, the transcript replay repainted prior turns whose
  footer lines read as "working", fabricating a spurious `running → ready` cycle on
  every resume. Rendered turn edges are now suppressed through the replay until the
  first quiet, non-blocking composer frame; evidence-based turns (a caller
  submission, hooks) are unaffected. (C-TURN-03)

- **A resume could never leave the queue permanently starved by a failed
  transition.** Initial readiness now latches only *after* its callback completes,
  so a failed durable status write is retried on the next hook/frame/deadline
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

- **A throwing warning sink no longer loses a transcript diagnostic mid-session or
  stops observation.** The retain-on-throw guarantee previously only held before the
  session's warning sink existed; once it did, a throwing `recordWarnings` lost the
  notice and could escape into the poll loop and permanently stop the transcript
  watcher. Warnings are now queued before delivery and the flush is contained, so a
  transient sink failure is retried on the next scan and the watcher stays live
  (both adapters). This corrects an over-broad claim in a prior entry.

- **An empty-ish non-array `images` value now rejects instead of sending silently.**
  An untyped caller passing `""` or `{ length: 0 }` as `images` took a no-image fast
  path and the text was sent with no error; only a genuinely absent list (or an empty
  array) skips attachment now — anything else is validated and rejects `invalid_image`.
  (C-API-44)

- **Claude's `transcript_read_error` `lastErrorCode` is now normalized to a string.**
  Matching the Codex fix, a non-string errno `code` (e.g. a numeric code) becomes
  `"UNKNOWN"` instead of round-tripping a number through the string-typed field
  (which could fail the persisted record's validation).

- **Transcript reading no longer spins on an incomplete UTF-8 tail.** A partial
  write that ends mid-code-point made the reader re-read the same bytes up to
  64×/second per session; it now reports no-progress and resumes on the next tick
  once the rest of the code point is committed (both adapters).

- **`transcript_read_error`'s `lastErrorCode` is always a string.** A non-string
  errno `code` (e.g. a numeric code) is now normalized to `"UNKNOWN"` instead of
  round-tripping a number through the string-typed field.

- **A throwing warning sink no longer silently loses drop/read-error totals.** If
  persisting a `transcript_records_dropped` / `transcript_read_error` warning threw
  (e.g. a failed `session.json` write), the running total was cleared before the
  write was confirmed and the incident vanished. The buffered notices and the drop
  aggregate now stay queued until the sink returns, so the next flush re-delivers
  them rather than dropping them (both adapters).

- **Codex transcript reading is bounded and crash-safe.** The reader reads in
  fixed-size chunks with a max-pending ceiling, streams a large backlog across poll
  ticks, and drains within a bounded budget at exit — a hundreds-of-MiB transcript
  can no longer OOM or block the event loop. Lost data surfaces as the content-free
  `transcript_records_dropped` warning; a scan that throws is contained and surfaced
  as `transcript_poll_stopped` (both now `agent: "codex" | "claude"`); a resumed
  session continues its running drop/read-error totals rather than restarting at 0.
  `finish()` is terminal and idempotent. (C-CODEX-20)

- **Guidance/message delivery is never split from status persistence.** A throwing
  `status` or `activity` listener can no longer leave the persisted session record
  and the in-memory status disagreeing, nor wedge the queue mid-turn. (C-API-42)

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
