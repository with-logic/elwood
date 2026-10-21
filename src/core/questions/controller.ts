/** Bind question discovery, guarded answers and shutdown to a session (PRD §5.10). */
import { subscribeRender } from "../../terminal/cursor.ts";
import type { ElwoodTerminal } from "../../terminal/headless.ts";
import type { ElwoodActivityEvent, ElwoodAgentKind } from "../activity/index.ts";
import type { Unsubscribe } from "../types.ts";
import type { QuestionAdapter } from "./adapter.ts";
import { type QuestionEmitter, QuestionRegistry } from "./registry.ts";
import { QuestionTransaction, readQuestionFrame } from "./transaction.ts";
import type { ElwoodQuestionAnswer, ElwoodQuestionAnswerOptions } from "./types.ts";

type Events = QuestionEmitter & {
  on(event: "activity", handler: (event: ElwoodActivityEvent) => void): Unsubscribe;
  on(event: "terminal:data", handler: () => void): Unsubscribe;
};
export class SessionQuestions {
  readonly registry: QuestionRegistry;
  private adapter: QuestionAdapter | undefined;
  private readonly transaction: QuestionTransaction;
  constructor(
    agent: ElwoodAgentKind,
    id: string,
    events: Events,
    terminal: ElwoodTerminal,
    inputSignal: () => AbortSignal,
    closing: AbortSignal,
  ) {
    this.registry = new QuestionRegistry(agent, id, events);
    this.transaction = new QuestionTransaction(this.registry, terminal, inputSignal, closing);
    const refresh = () => {
      const frame = readQuestionFrame(terminal);
      if (frame) {
        try {
          this.adapter?.render(frame);
        } catch {
          /* Public observers cannot turn a completed native render into render failure. */
        }
      }
    };
    const offActivity = events.on("activity", (event) => {
      if (event.kind === "question") return;
      this.adapter?.observe(event);
      refresh();
    });
    const offTerminal = events.on("terminal:data", refresh);
    const offRender = subscribeRender(terminal, refresh);
    closing.addEventListener(
      "abort",
      () => {
        this.transaction.revoke();
        offRender();
        offActivity();
        offTerminal();
        try {
          this.registry.clear("unavailable");
        } catch {
          /* Shutdown owns cleanup even when a question observer throws. */
        }
      },
      { once: true },
    );
  }
  configure(factory: (registry: QuestionRegistry) => QuestionAdapter): void {
    this.adapter = factory(this.registry);
  }
  blocksInput(): boolean {
    return (
      this.transaction.busy() ||
      this.registry.list().length > 0 ||
      this.adapter?.blocksInput() === true
    );
  }
  revoke(): void {
    this.transaction.revoke();
  }
  list() {
    return this.registry.list();
  }
  answer(
    id: string,
    answers: readonly ElwoodQuestionAnswer[],
    options?: ElwoodQuestionAnswerOptions,
  ) {
    return this.transaction.run(this.adapter, id, answers, options);
  }
}
