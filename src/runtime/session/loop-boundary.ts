/** Bind loop input ownership before preparation or physical dispatch (PRD §5.8/§5.9). */
import type { AdmitOperation } from "../../core/control-queue/types.ts";
import { reserveLoopSubmission } from "../../core/simple/loop-boundary.ts";
import { registerTurnLoopHold } from "../../core/simple/loop-hold.ts";
import type { SessionLifecycle } from "./lifecycle.ts";
import type { SessionStatusEmitter } from "./status-wiring.ts";

export function bindLoopAdmission(
  session: SessionLifecycle,
  events: SessionStatusEmitter,
  holdLoops: () => () => void,
): AdmitOperation {
  registerTurnLoopHold(session, holdLoops);
  const observed = {
    get status() {
      return session.status;
    },
    on: events.on.bind(events),
  };
  return (origin, signal) => {
    if (origin.kind !== "loop") return undefined;
    const reservation = reserveLoopSubmission(session, observed, {
      closing: session.closing.signal,
      admission: signal,
    });
    return { ready: reservation.ready, run: (work) => reservation.submit(work) };
  };
}
