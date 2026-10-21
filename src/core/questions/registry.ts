/** Immutable request identities and native lifecycle edges (PRD §5.10, C-QUESTION-01). */
import { randomUUID } from "node:crypto";
import type { ElwoodActivityEvent, ElwoodAgentKind } from "../activity/index.ts";
import type {
  ElwoodQuestionEvent,
  ElwoodQuestionRequest,
  QuestionCloseReason,
  QuestionDefinition,
} from "./types.ts";

export type QuestionEmitter = {
  emit(event: "question", payload: ElwoodQuestionEvent): void;
  emit(event: "activity", payload: ElwoodActivityEvent): void;
};
type Entry = {
  readonly key: string;
  readonly signature: string;
  readonly request: ElwoodQuestionRequest;
};
export class QuestionRegistry {
  private readonly entries = new Map<string, Entry>();
  private readonly byKey = new Map<string, Entry>();
  private readonly listeners = new Set<(event: ElwoodQuestionEvent) => void>();
  readonly agent: ElwoodAgentKind;
  private readonly sessionId: string;
  private readonly emitter: QuestionEmitter;
  constructor(agent: ElwoodAgentKind, sessionId: string, emitter: QuestionEmitter) {
    this.agent = agent;
    this.sessionId = sessionId;
    this.emitter = emitter;
  }
  list(): readonly ElwoodQuestionRequest[] {
    return Object.freeze([...this.entries.values()].map((entry) => entry.request));
  }
  get(id: string): ElwoodQuestionRequest | undefined {
    return this.entries.get(id)?.request;
  }
  find(key: string): ElwoodQuestionRequest | undefined {
    return this.byKey.get(key)?.request;
  }
  keyFor(id: string): string | undefined {
    return this.entries.get(id)?.key;
  }
  publish(
    key: string,
    delivery: ElwoodQuestionRequest["delivery"],
    questions: readonly QuestionDefinition[],
  ): ElwoodQuestionRequest {
    const signature = JSON.stringify([delivery, questions]);
    const existing = this.byKey.get(key);
    if (existing?.signature === signature) return existing.request;
    let failure: unknown;
    let failed = false;
    if (existing) {
      try {
        this.close(existing.request.id, "unavailable");
      } catch (error) {
        failure = error;
        failed = true;
      }
    }
    const request: ElwoodQuestionRequest = Object.freeze({
      id: randomUUID(),
      agent: this.agent,
      delivery,
      questions: Object.freeze(
        questions.map((question) =>
          Object.freeze({
            ...question,
            id: randomUUID(),
            options: Object.freeze(
              question.options.map((option) => Object.freeze({ ...option, id: randomUUID() })),
            ),
          }),
        ),
      ),
    });
    const entry = { key, signature, request };
    this.entries.set(request.id, entry);
    this.byKey.set(key, entry);
    try {
      this.emit({ elwoodSessionId: this.sessionId, agent: this.agent, phase: "raised", request });
    } catch (error) {
      if (!failed) failure = error;
      failed = true;
    }
    if (failed) throw failure;
    return request;
  }
  close(id: string, reason: QuestionCloseReason): void {
    const entry = this.entries.get(id);
    if (!entry) return;
    this.entries.delete(id);
    this.byKey.delete(entry.key);
    this.emit({
      elwoodSessionId: this.sessionId,
      agent: this.agent,
      phase: "closed",
      request: entry.request,
      reason,
    });
  }
  clear(reason: QuestionCloseReason): void {
    let failure: unknown;
    let failed = false;
    for (const id of [...this.entries.keys()]) {
      try {
        this.close(id, reason);
      } catch (error) {
        if (!failed) failure = error;
        failed = true;
      }
    }
    if (failed) throw failure;
  }
  onEvent(listener: (event: ElwoodQuestionEvent) => void): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }
  private emit(event: ElwoodQuestionEvent): void {
    Object.freeze(event);
    for (const listener of this.listeners) listener(event);
    try {
      this.emitter.emit("question", event);
    } finally {
      this.emitter.emit("activity", {
        elwoodSessionId: this.sessionId,
        agent: this.agent,
        source: "terminal",
        kind: "question",
        label: event.phase,
        question: event,
      });
    }
  }
}
