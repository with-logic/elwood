/** Serialize lifecycle notifications while registry mutations stay synchronous (PRD §4). */
import type { QuestionActivityEvent } from "./activity.ts";
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

  emit(event: ElwoodQuestionEvent): void {
    const errors: unknown[] = [];
    this.pending.push(Object.freeze(event));
    if (!this.delivering) {
      this.delivering = true;
      while (this.pending.length > 0) {
        const next = this.pending.shift()!;
        for (const listener of this.listeners) attempt(() => listener(next), errors);
        attempt(() => this.emitter.emit("question", next), errors);
        const activity: QuestionActivityEvent = Object.freeze({
          elwoodSessionId: next.elwoodSessionId,
          agent: next.agent,
          source: "terminal",
          kind: "question",
          label: next.phase,
          question: next,
        });
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
