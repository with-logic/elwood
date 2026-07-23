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

- **A throwing warning sink never loses a transcript diagnostic and never stops
  observation.** Warning DELIVERY is now retain-on-throw for the whole session life:
  each notice is queued before delivery and the flush is contained, so a throwing
  `recordWarnings` (at any point, not only before the sink exists) is retried on the
  next scan instead of being lost or escaping into the poll loop and stopping the
  transcript watcher. The watcher stays live (both adapters).

- **A throwing warning sink never loses the drop/read-error AGGREGATE.** Separately
  from delivery, the running `transcript_records_dropped` / `transcript_read_error`
  totals are held until the sink confirms the write, so a failed `session.json`
  write can't clear the total before the incident is recorded — the next flush
  re-delivers it (both adapters).

- **An empty-ish non-array `images` value now rejects instead of sending silently.**
  An untyped caller passing `""` or `{ length: 0 }` as `images` took a no-image fast
  path and the text was sent with no error; only a genuinely absent list (or an empty
  array) skips attachment now — anything else is validated and rejects `invalid_image`.
  (C-API-44)

- **`transcript_read_error`'s `lastErrorCode` is always a string (both adapters).** A
  non-string errno `code` (e.g. a numeric code) is normalized to `"UNKNOWN"` instead
  of round-tripping a number through the string-typed field, which could otherwise
  fail the persisted record's validation.

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
