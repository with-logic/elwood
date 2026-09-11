# Recurring loops

Purpose: how to schedule, inspect, cancel, and persist recurring prompts on a
session.

Elwood schedules loops itself, so Claude and Codex behave the same and no
parent-app timer is needed. The typed API supports fixed intervals and an idle
cadence, multiple loops per session, inspection, and cancellation:

```ts
const fixed = await session.createLoop({
  mode: "fixed",
  intervalMs: 5 * 60_000,
  message: "Check the deployment and report regressions.",
});
await session.createLoop({ mode: "idle", message: "Continue with the next useful task." });

console.log(await session.listLoops());
await session.cancelLoop(fixed.id);
```

## Parsing a `/loop` command

`parseLoopCommand("/loop 5m check the deployment")` returns the same fixed
request shape; `parseLoopCommand("/loop check the deployment")` returns an
idle request. Parsing is opt-in: `sendMessage("/loop ...")` still sends the
literal text. Use the helper when your app wants a shared `/loop` UX.

## Limits

- Fixed intervals are one minute to less than seven days. Idle loops fire
  after five minutes of readiness.
- At most 50 active loops per session; messages are 1 to 65,536 bytes.
- Delivery is readiness-safe and serial: a loop never interrupts a running
  turn or writes into a blocking dialog.
- Each loop gets a stable, id-derived, delay-only jitter of up to 30 seconds.
- Loops expire after seven wall-clock days.
- Missed runs are never replayed after resume.

Validation, capacity, not-found cancellation, persistence, and
scheduling/submission failures reject with stable typed errors.

## Persistence and lifecycle

Loop definitions live in a private, versioned, owner-only (`0600`) sidecar next
to the session record. The sidecar stores the loop message and cadence
metadata, but no live timer, due state, or submission state. This is the one
place Elwood persists prompt text; see
[design-notes.md](design-notes.md#state-privacy-and-safety).

- `stop()` and unexpected exits preserve definitions.
- `kill()` clears them permanently.
- `teardown()` removes them with the session.
- Resume restores unexpired definitions with the same ids and jitter, starting
  fresh clocks from the resumed session's first real readiness.

Subscribe to the `loop` event for redacted `created`, `fired`, `cancelled`,
`expired`, and `failed` lifecycle events. The event never carries prompt text.
