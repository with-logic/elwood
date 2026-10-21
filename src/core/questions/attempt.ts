/** Track one answer's execution, native acknowledgement, and failure cleanup (PRD §4). */
import { untilQuestionAbort } from "./abort.ts";
import type { QuestionAdapter } from "./adapter.ts";
import { questionDeadline } from "./deadline.ts";
import { type QuestionFailureCategory, questionAnswerFailed } from "./errors.ts";
import type { QuestionIo } from "./io.ts";
import type { QuestionRegistry } from "./registry.ts";
import type { ElwoodQuestionRequest } from "./types.ts";
import type { ValidatedQuestionAnswer } from "./validate.ts";

export class QuestionAttempt {
  writeAttempted = false;
  failureCategory: QuestionFailureCategory = "frame_wait";
  private nativeAccepted = false;
  private adapterFinished = false;
  private wake: (() => void) | undefined;
  private readonly stopDeadline: () => void;
  private readonly off: () => void;
  private readonly request: ElwoodQuestionRequest;
  private readonly operation: AbortController;
  private readonly signal: AbortSignal;
  private readonly registry: QuestionRegistry;
  constructor(
    request: ElwoodQuestionRequest,
    operation: AbortController,
    signal: AbortSignal,
    registry: QuestionRegistry,
    timeoutMs: number,
  ) {
    this.request = request;
    this.operation = operation;
    this.signal = signal;
    this.registry = registry;
    this.stopDeadline = questionDeadline(timeoutMs, () => operation.abort(questionAnswerFailed()));
    this.off = registry.onEvent((event) => {
      if (event.phase !== "closed" || event.request.id !== request.id) return;
      if (event.reason === "answered") {
        this.nativeAccepted = true;
        if (this.adapterFinished) this.stopDeadline();
        this.wake?.();
      } else operation.abort(questionAnswerFailed());
    });
  }
  assertLive(): void {
    const requestAvailable = this.registry.get(this.request.id) !== undefined;
    const requestAvailableOrAccepted = this.nativeAccepted || requestAvailable;
    if (this.signal.aborted || !requestAvailableOrAccepted) throw questionAnswerFailed();
  }
  async execute(
    adapter: QuestionAdapter,
    answers: readonly ValidatedQuestionAnswer[],
    io: QuestionIo,
  ): Promise<void> {
    this.assertLive();
    await io.wait(() => true);
    this.failureCategory = "adapter";
    await untilQuestionAbort(adapter.answer(this.request, answers, io), this.signal);
    this.adapterFinished = true;
    this.failureCategory = "native_acceptance";
    await this.waitForNativeAcceptance();
    this.assertLive();
  }
  failure(): Error {
    // Retirement emits a closed edge that aborts this operation; retain its original category.
    const category = this.signal.aborted ? "aborted" : this.failureCategory;
    if (this.writeAttempted && !this.nativeAccepted) {
      try {
        this.registry.retireUnconfirmed(this.request.id);
      } catch {
        // Observer failures cannot restore native authority or expose answer-bearing causes.
      }
    }
    return questionAnswerFailed(category);
  }
  dispose(): void {
    if (this.wake) this.signal.removeEventListener("abort", this.wake);
    this.operation.abort();
    this.stopDeadline();
    this.off();
  }
  private async waitForNativeAcceptance(): Promise<void> {
    if (this.nativeAccepted) {
      this.stopDeadline();
      return;
    }
    await new Promise<void>((resolve) => {
      this.wake = () => resolve();
      this.signal.addEventListener("abort", this.wake, { once: true });
      if (this.signal.aborted) resolve();
    });
  }
}
