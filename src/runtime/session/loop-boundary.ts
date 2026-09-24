/** Keep raw input behind selected loops while controls pass (PRD §5.8/§5.9). */
import { controlOperationTraits } from "../../core/control-queue/traits.ts";
import type { AdmitOperation } from "../../core/control-queue/types.ts";
import { loopBoundaryTail, reserveLoopSubmission } from "../../core/simple/loop-boundary.ts";
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
  return (origin, signal, kind) => {
    if (!controlOperationTraits[kind].reportsCallerSubmission) return undefined;
    if (origin.kind === "caller") {
      const tail = loopBoundaryTail(session);
      return tail ? { ready: tail, run: (work) => work() } : undefined;
    }
    const reservation = reserveLoopSubmission(session, observed, {
      closing: session.closing.signal,
      admission: signal,
    });
    return { ready: reservation.ready, run: (work) => reservation.submit(work) };
  };
}
