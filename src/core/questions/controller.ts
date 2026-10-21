/** Bind private discovery, guarded answers and shutdown to a session (PRD §4). */
import { subscribeRender } from "../../terminal/cursor.ts";
import type { ElwoodTerminal } from "../../terminal/headless.ts";
import type { ElwoodActivityEvent, ElwoodAgentKind } from "../activity/index.ts";
import type { Unsubscribe } from "../types.ts";
import type { QuestionAdapter } from "./adapter.ts";
import { readQuestionFrame } from "./input.ts";
import { type QuestionEmitter, QuestionRegistry } from "./registry.ts";
import { QuestionTransaction } from "./transaction.ts";
import type { ElwoodQuestionAnswer, ElwoodQuestionAnswerOptions } from "./types.ts";

type Events = QuestionEmitter & {
  on(event: "activity", handler: (event: ElwoodActivityEvent) => void): Unsubscribe;
};
export class SessionQuestions {
  readonly registry: QuestionRegistry;
  private adapter: QuestionAdapter | undefined;
  private readonly transaction: QuestionTransaction;
  private readonly closing: AbortSignal;
  constructor(
    agent: ElwoodAgentKind,
    elwoodSessionId: string,
    events: Events,
    terminal: ElwoodTerminal,
    inputSignal: () => AbortSignal,
    closing: AbortSignal,
  ) {
    this.closing = closing;
    this.registry = new QuestionRegistry(agent, elwoodSessionId, events);
    this.transaction = new QuestionTransaction(this.registry, terminal, inputSignal, closing);
    const refresh = () => {
      if (closing.aborted) return;
      const frame = readQuestionFrame(terminal);
      if (frame) {
        try {
          this.adapter?.render(frame);
        } catch {
          /* Observers cannot turn a completed native render into render failure. */
        }
      }
    };
    const offActivity = events.on("activity", (event) => {
      if (closing.aborted || event.kind === "question") return;
      try {
        if (!this.adapter?.observe(event)) return;
      } catch {
        /* Native state may already have changed before a public observer failed. */
      }
      refresh();
    });
    const offRender = subscribeRender(terminal, refresh);
    const shutdown = () => {
      this.transaction.revoke();
      offRender();
      offActivity();
      try {
        this.registry.shutdown();
      } catch {
        /* Shutdown owns cleanup even when a question observer throws. */
      }
    };
    closing.addEventListener("abort", shutdown, { once: true });
    if (closing.aborted) shutdown();
  }
  configure(factory: (registry: QuestionRegistry) => QuestionAdapter): void {
    if (!this.closing.aborted) this.adapter = factory(this.registry);
  }
  blocksInput(): boolean {
    return (
      this.transaction.busy() || this.registry.hasPending() || this.adapter?.blocksInput() === true
    );
  }
  revoke(): void {
    this.transaction.revoke();
  }
  list() {
    return this.registry.list();
  }
  answer(
    requestId: string,
    answers: readonly ElwoodQuestionAnswer[],
    options?: ElwoodQuestionAnswerOptions,
  ) {
    return this.transaction.run(this.adapter, requestId, answers, options);
  }
}
