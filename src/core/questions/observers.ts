/** Contain session question notifications and diagnose once (PRD §5.4, §5.10). */
import type { ElwoodActivityEvent, ElwoodAgentKind } from "../activity/index.ts";
import type { ElwoodWarningEvent } from "../types.ts";
import type { QuestionObserverFailedWarning } from "../warnings/questions.ts";
import { emitSessionWarnings } from "../warnings/session.ts";
import type { QuestionActivityEvent } from "./activity.ts";
import type { QuestionEmitter } from "./dispatch.ts";
import type { ElwoodQuestionEvent } from "./types.ts";

export type QuestionObservationEmitter = QuestionEmitter & {
  observeErrors<T>(
    onError: (error: unknown) => void,
    operation: () => T,
    retainOnOverflow?: boolean,
  ): T;
  emit(event: "warning", payload: ElwoodWarningEvent): void;
  emit(event: "activity", payload: ElwoodActivityEvent): void;
};
type QuestionNotifier = QuestionEmitter & { reportFailure(): void };
type Emission = ["question", ElwoodQuestionEvent] | ["activity", QuestionActivityEvent];

/** Deliver question/activity pairs with contained failures (PRD §§5.4, 5.10).
 * Preserve the first failed phase and defer synchronous diagnostics until both events finish. */
export function observeQuestionNotifications(
  emitter: QuestionObservationEmitter,
  elwoodSessionId: string,
  agent: ElwoodAgentKind,
): QuestionNotifier {
  let failedPhase: QuestionObserverFailedWarning["phase"] | undefined;
  let delivering = false;
  let reported = false;
  function report(): void {
    if (failedPhase === undefined || reported) return;
    reported = true;
    const warning: QuestionObserverFailedWarning = Object.freeze({
      elwoodSessionId,
      agent,
      source: "lifecycle",
      code: "question_observer_failed",
      severity: "warning",
      message: "A question notification failed; native question ownership was preserved.",
      phase: failedPhase,
      raw: `question_observer_failed phase=${failedPhase}`,
    });
    emitter.observeErrors(
      () => {
        /* Diagnostic failures must not recursively warn. */
      },
      () =>
        emitSessionWarnings([warning], {
          warning: (event) => emitter.emit("warning", event),
          activity: (event) => emitter.emit("activity", event),
        }),
    );
  }
  function fail(phase: QuestionObserverFailedWarning["phase"]): void {
    failedPhase ??= phase;
    if (!delivering) report();
  }
  const failures = { question: () => fail("question"), activity: () => fail("activity") };
  return {
    reportFailure(): void {
      fail("question");
    },
    emit(...[event, payload]: Emission): void {
      // QuestionDispatch always follows each typed event with its activity mirror.
      // Synchronous diagnostics wait for that pair; late rejections report directly.
      if (event === "question") delivering = true;
      emitter.observeErrors(
        failures[event],
        () => {
          if (event === "question") emitter.emit(event, payload);
          else emitter.emit(event, payload);
        },
        true,
      );
      if (event === "activity") {
        delivering = false;
        report();
      }
    },
  };
}
