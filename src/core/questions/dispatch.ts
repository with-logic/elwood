/** Serialize lifecycle notifications while registry mutations stay synchronous (PRD §5.10). */

import type { QuestionActivityEvent } from "./activity.ts";
import { questionActivity } from "./activity-fields.ts";
import type { ElwoodQuestionEvent } from "./types.ts";

export type QuestionEmitter = {
  emit(event: "question", payload: ElwoodQuestionEvent): void;
  emit(event: "activity", payload: QuestionActivityEvent): void;
};

export class QuestionDispatch {
  private readonly pending: ElwoodQuestionEvent[] = [];
  private readonly listeners = new Set<(event: ElwoodQuestionEvent) => void>();
  private delivering = false;
  private readonly emitter: QuestionEmitter;
  constructor(emitter: QuestionEmitter) {
    this.emitter = emitter;
  }

  onEvent(listener: (event: ElwoodQuestionEvent) => void): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  // Synchronous observers may mutate the registry while a raised edge is being delivered.
  // Queue nested edges so every observer and its activity mirror see raised before closed.
  emit(event: ElwoodQuestionEvent): void {
    const errors: unknown[] = [];
    this.pending.push(Object.freeze(event));
    if (!this.delivering) {
      this.delivering = true;
      while (this.pending.length > 0) {
        const next = this.pending.shift()!;
        for (const listener of this.listeners) attempt(() => listener(next), errors);
        attempt(() => this.emitter.emit("question", next), errors);
        const activity = questionActivity(next);
        attempt(() => this.emitter.emit("activity", activity), errors);
      }
      this.delivering = false;
    }
    if (errors.length > 0) throw errors[0];
  }
}

function attempt(action: () => void, errors: unknown[]): void {
  try {
    action();
  } catch (error) {
    errors.push(error);
  }
}
