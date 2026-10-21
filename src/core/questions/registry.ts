/** Immutable request identities and native lifecycle edges (PRD §4). */
import { randomUUID } from "node:crypto";
import type { ElwoodAgentKind } from "../activity/index.ts";
import { QuestionDispatch, type QuestionEmitter } from "./dispatch.ts";
import type {
  ElwoodQuestionEvent,
  ElwoodQuestionRequest,
  QuestionCloseReason,
  QuestionDefinition,
} from "./types.ts";

export type { QuestionEmitter } from "./dispatch.ts";

type Entry = {
  answerable: boolean;
  readonly nativeKey: string;
  readonly signature: string;
  readonly request: ElwoodQuestionRequest;
};
export class QuestionRegistry {
  private readonly entries = new Map<string, Entry>();
  private readonly byNativeKey = new Map<string, Entry>();
  private readonly publishingNativeKeys = new Set<string>();
  private readonly dispatch: QuestionDispatch;
  private stopped = false;
  readonly agent: ElwoodAgentKind;
  private readonly elwoodSessionId: string;
  constructor(agent: ElwoodAgentKind, elwoodSessionId: string, emitter: QuestionEmitter) {
    this.agent = agent;
    this.elwoodSessionId = elwoodSessionId;
    this.dispatch = new QuestionDispatch(emitter);
  }
  /** Includes retired requests until their native ownership is released. */
  hasPending(): boolean {
    return this.entries.size > 0;
  }
  list(): readonly ElwoodQuestionRequest[] {
    return Object.freeze(
      [...this.entries.values()].filter((entry) => entry.answerable).map((entry) => entry.request),
    );
  }
  get(requestId: string): ElwoodQuestionRequest | undefined {
    const entry = this.entries.get(requestId);
    return entry?.answerable ? entry.request : undefined;
  }
  /** Retired identities remain available for authoritative native-close correlation. */
  find(nativeKey: string): ElwoodQuestionRequest | undefined {
    return this.byNativeKey.get(nativeKey)?.request;
  }
  /** A retired request keeps its native reservation without answer authority. */
  isRetired(nativeKey: string): boolean {
    return this.byNativeKey.get(nativeKey)?.answerable === false;
  }
  keyFor(requestId: string): string | undefined {
    return this.entries.get(requestId)?.nativeKey;
  }
  /** Mirrors retain identity; changed native authority retires its previous request. */
  publish(
    nativeKey: string,
    delivery: ElwoodQuestionRequest["delivery"],
    questions: readonly QuestionDefinition[],
  ): ElwoodQuestionRequest | undefined {
    // A replacement closes before raising: reentrant publication of the same key
    // must not install an entry that the outer replacement would orphan in the index.
    if (
      this.stopped ||
      this.publishingNativeKeys.has(nativeKey) ||
      this.byNativeKey.get(nativeKey)?.answerable === false
    )
      return undefined;
    this.publishingNativeKeys.add(nativeKey);
    try {
      return this.publishRequest(nativeKey, delivery, questions);
    } finally {
      this.publishingNativeKeys.delete(nativeKey);
    }
  }
  private publishRequest(
    nativeKey: string,
    delivery: ElwoodQuestionRequest["delivery"],
    questions: readonly QuestionDefinition[],
  ): ElwoodQuestionRequest | undefined {
    const signature = JSON.stringify([delivery, questions]);
    const existing = this.byNativeKey.get(nativeKey);
    // Definition serialization can invoke getters that retire the active request.
    if (existing?.answerable === false) return undefined;
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
    if (this.stopped) {
      if (failed) throw failure;
      return undefined;
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
    const entry = { nativeKey, signature, request, answerable: true };
    this.entries.set(request.id, entry);
    this.byNativeKey.set(nativeKey, entry);
    try {
      this.emit({
        elwoodSessionId: this.elwoodSessionId,
        agent: this.agent,
        phase: "raised",
        request,
      });
    } catch (error) {
      if (!failed) failure = error;
      failed = true;
    }
    if (failed) throw failure;
    return request;
  }
  /** Close the API request while retaining native ownership until native closure. */
  retireUnconfirmed(requestId: string): void {
    const entry = this.entries.get(requestId);
    if (!entry?.answerable) return;
    entry.answerable = false;
    this.emit({
      elwoodSessionId: this.elwoodSessionId,
      agent: this.agent,
      phase: "closed",
      request: entry.request,
      reason: "unavailable",
    });
  }
  close(requestId: string, reason: QuestionCloseReason): void {
    const entry = this.entries.get(requestId);
    if (!entry) return;
    this.entries.delete(requestId);
    this.byNativeKey.delete(entry.nativeKey);
    if (!entry.answerable) return;
    this.emit({
      elwoodSessionId: this.elwoodSessionId,
      agent: this.agent,
      phase: "closed",
      request: entry.request,
      reason,
    });
  }
  clear(reason: QuestionCloseReason): void {
    let failure: unknown;
    let failed = false;
    for (const requestId of [...this.entries.keys()]) {
      try {
        this.close(requestId, reason);
      } catch (error) {
        if (!failed) failure = error;
        failed = true;
      }
    }
    if (failed) throw failure;
  }
  shutdown(): void {
    // Closure observers run synchronously; latch first so they cannot repopulate shutdown state.
    this.stopped = true;
    this.clear("unavailable");
  }
  onEvent(listener: (event: ElwoodQuestionEvent) => void): () => void {
    return this.dispatch.onEvent(listener);
  }
  private emit(event: ElwoodQuestionEvent): void {
    this.dispatch.emit(event);
  }
}
