/** Observe loop input before preparation or physical dispatch (PRD §5.8/§5.9, C-API-48). */
import type { AroundOperation, ControlSubmissionOrigin } from "../../core/control-queue/types.ts";
import { observeLoopSubmission } from "../../core/simple/loop-boundary.ts";
import type { SessionLifecycle } from "./lifecycle.ts";
import type { SessionLoops } from "./loops.ts";
import type { SessionStatusEmitter } from "./status-wiring.ts";

export function observeLoopSubmissions(
  session: SessionLifecycle,
  events: SessionStatusEmitter,
  around: AroundOperation,
): AroundOperation {
  const observed = {
    get status() {
      return session.status;
    },
    on: events.on.bind(events),
  };
  return (work, signal, origin) => {
    const submit = () => around(work, signal, origin);
    return origin.kind === "loop"
      ? observeLoopSubmission(session, observed, session.closing.signal, submit)
      : submit();
  };
}

/** Keep the committed loop's fired notification ahead of its running evidence. */
export function recordSubmission(
  session: SessionLifecycle,
  loops: SessionLoops,
  origin: ControlSubmissionOrigin,
): void {
  loops.turnStarted(origin);
  session.submitEvidence("caller_submitted");
}
