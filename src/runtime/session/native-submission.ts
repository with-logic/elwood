/** Bind physical submissions and native idle evidence to a live session (PRD §5.8/§5.9). */
import type { AdmitOperation, ControlSubmitter } from "../../core/control-queue/types.ts";
import { reserveLoopSubmission } from "../../core/simple/loop-boundary.ts";
import { registerNativeIdle } from "../../core/simple/native-idle.ts";
import { observeOwnedLoop } from "../../core/simple/owned-loop.ts";
import { nativeTurnReader } from "../../core/simple/submission-context.ts";
import { captureRenderProgress } from "../../terminal/cursor.ts";
import type { SessionLifecycle } from "./lifecycle.ts";
import type { SessionStatusEmitter } from "./status-wiring.ts";

export function bindNativeInput(
  session: SessionLifecycle,
  events: SessionStatusEmitter,
  readEmpty: () => object | undefined,
  submit: ControlSubmitter,
) {
  let loopEnter: ((payload: string) => void) | undefined;
  const observed = {
    get status() {
      return session.status;
    },
    on: events.on.bind(events),
  };
  registerNativeIdle(session, {
    capture: () => {
      const progressed = captureRenderProgress(session.terminal);
      const isReady = () =>
        !session.closing.signal.aborted &&
        progressed() &&
        session.status === "ready" &&
        !session.inputBlocking &&
        !session.trustInputBlocking;
      return { isReady, isIdle: () => isReady() && readEmpty() !== undefined };
    },
    // Both adapters emit terminal:data after attachPtyTerminal's completed-render observer.
    subscribe: (listener) => events.on("terminal:data", listener),
  });
  const admit: AdmitOperation = (origin, signal) => {
    if (origin.kind !== "loop") return undefined;
    const reader = nativeTurnReader(session);
    const reservation = reserveLoopSubmission(session, observed, {
      closing: session.closing.signal,
      admission: signal,
      ...(reader
        ? {
            observe: () => {
              const observer = observeOwnedLoop(session, observed, session.closing.signal, reader);
              loopEnter = observer.beforeEnter;
              return observer;
            },
          }
        : {}),
    });
    return {
      ready: reservation.ready,
      run: async (work) => {
        try {
          await reservation.submit(work);
        } finally {
          loopEnter = undefined;
        }
      },
    };
  };
  const write: ControlSubmitter = (input, mode, signal, submitted, beforeEnter) =>
    submit(input, mode, signal, submitted, (payload) => {
      loopEnter?.(payload);
      beforeEnter?.(payload);
    });
  return { admit, submit: write, readEmpty };
}
