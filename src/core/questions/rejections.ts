/** Nonblocking containment for public question listeners (PRD §5.10). */
import type { QuestionActivityEvent } from "./activity.ts";
import type { QuestionEmitter } from "./dispatch.ts";
import type { ElwoodQuestionEvent } from "./types.ts";
export type QuestionRejectionEmitter = QuestionEmitter & {
  observeRejections<T>(onError: (error: unknown) => void, operation: () => T): T;
};
type Emission = ["question", ElwoodQuestionEvent] | ["activity", QuestionActivityEvent];
export function containQuestionRejections(emitter: QuestionRejectionEmitter): QuestionEmitter {
  return {
    emit(...[event, payload]: Emission): void {
      emitter.observeRejections(
        () => {
          /* Notification failures cannot delay native lifecycle delivery. */
        },
        () => {
          if (event === "question") emitter.emit(event, payload);
          else emitter.emit(event, payload);
        },
      );
    },
  };
}
