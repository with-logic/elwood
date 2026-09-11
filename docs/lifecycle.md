# Session lifecycle

Purpose: event delivery guarantees, terminal sizing, and how to persist and
resume a session across parent-app restarts.

## Event delivery guarantees

- `terminal:exit` is emitted exactly once per session process exit.
- A handler never fires after its unsubscribe function returns.
- A late `terminal:data` subscriber first receives the replay buffer as one
  coalesced chunk, then live chunks, with no gap and no duplicates. The buffer
  is bounded at 128 KB (oldest data dropped); use
  `session.terminal.snapshot()` for current-screen ground truth.
- `stop()` / `kill()` after exit do not re-signal the PTY and preserve the exit
  status, but they still confirm or retry the process-group reap and may
  reject with `termination_failed`. `teardown()` is safe to call twice.
- `status` transitions mark every real turn boundary: `running` when a turn
  starts and `ready` when it ends, including turns ended by an interrupt.
  Consumers can clear "agent is working" UI on the `ready` beat.

The default terminal size is 189x48, wide enough that full-width TUI layouts
render without artificial wrapping. Visual embedders should pass and maintain
their real xterm size instead.

## Persisting and resuming

To resume across parent-app restarts, persist exactly two things: the
`elwoodSessionId` and the `stateDir` it lives in (keep that directory intact).
Everything else Elwood needs is in the session record.

- Resume restores only the launch posture from the record: `permissionMode`,
  allowed/disallowed tools, and `tools` for Claude; `sandbox` and
  `approvalPolicy` for Codex. Explicit resume options override those fields
  one by one and the result is re-persisted. Everything else is per-call and
  must be re-supplied: `model`, `reasoningEffort`, hook handlers, `autotrust`,
  `autoupdate`, `hookTimeoutMs`, `strictVersionCheck`, and `initialSize`.
- `resumeClaude` / `resumeCodex` reject with `resume_unavailable` when the CLI
  never reported its conversation id (Claude is resumable only after one
  completed turn), `state_not_found` when no record exists, and
  `adapter_mismatch` when the id belongs to the other adapter.
- Prefer `startOrResumeClaude` / `startOrResumeCodex`: they fall back to a
  fresh start only on those three errors, rethrow everything else (for example
  `state_corrupt`), and return `{ session, resumed }`.
- Loop definitions are restored with the same ids and jitter but fresh clocks;
  expired loops are pruned and missed runs are never replayed.
