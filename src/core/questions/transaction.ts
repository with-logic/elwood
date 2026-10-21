/** Own one answer attempt until native acceptance or revocation (PRD §4). */
import type { ElwoodTerminal } from "../../terminal/headless.ts";
import type { QuestionAdapter } from "./adapter.ts";
import { QuestionAttempt } from "./attempt.ts";
import { questionAnswerFailed, questionError } from "./errors.ts";
import { questionInput } from "./input.ts";
import type { QuestionRegistry } from "./registry.ts";
import type { ElwoodQuestionAnswer, ElwoodQuestionAnswerOptions } from "./types.ts";
import { questionTimeoutMs, validateQuestionAnswers } from "./validate.ts";

export class QuestionTransaction {
  private active: AbortController | undefined;
  private reservation: { readonly requestId: string; inFlightWrites: number } | undefined;
  private readonly registry: QuestionRegistry;
  private readonly terminal: ElwoodTerminal;
  private readonly inputSignal: () => AbortSignal;
  private readonly closing: AbortSignal;
  constructor(
    registry: QuestionRegistry,
    terminal: ElwoodTerminal,
    inputSignal: () => AbortSignal,
    closing: AbortSignal,
  ) {
    this.registry = registry;
    this.terminal = terminal;
    this.inputSignal = inputSignal;
    this.closing = closing;
  }
  busy(): boolean {
    return this.isBusy();
  }
  revoke(): void {
    this.active?.abort(questionAnswerFailed());
  }
  /** Resolves after adapter completion AND native answered closure; revocation, cancellation,
   * deadline, or unconfirmed writes reject without permitting replay of uncertain input. */
  async run(
    adapter: QuestionAdapter | undefined,
    requestId: string,
    answers: readonly ElwoodQuestionAnswer[],
    options?: ElwoodQuestionAnswerOptions,
  ): Promise<void> {
    const request = this.registry.get(requestId);
    if (!request)
      throw questionError(
        "question_not_found",
        "The native question request is no longer available.",
      );
    const timeoutMs = questionTimeoutMs(options);
    const validated = validateQuestionAnswers(request, answers);
    this.releaseSettledReservation();
    if (this.isBusy() || !adapter) throw questionAnswerFailed();
    const operation = new AbortController();
    const signal = this.operationSignal(operation, options);
    // Reading options.signal can reenter run() before this attempt installs its owner.
    if (this.isBusy()) throw questionAnswerFailed();
    this.active = operation;
    const reservation = { requestId, inFlightWrites: 0 };
    const attempt = new QuestionAttempt(request, operation, signal, this.registry, timeoutMs);
    const io = questionInput(
      this.terminal,
      this.registry,
      request,
      signal,
      () => attempt.assertLive(),
      {
        started: () => {
          attempt.writeAttempted = true;
          this.reservation = reservation;
          reservation.inFlightWrites++;
        },
        settled: () => {
          reservation.inFlightWrites--;
          this.releaseSettledReservation();
        },
        failed: () => {
          attempt.failureCategory = "terminal_write";
        },
      },
    );
    try {
      await attempt.execute(adapter, validated, io);
    } catch {
      throw attempt.failure();
    } finally {
      attempt.dispose();
      this.active = undefined;
      this.releaseSettledReservation();
    }
  }
  private isBusy(): boolean {
    const reservation = this.reservation;
    // Retired requests retain native ownership without a second closed event.
    return (
      this.active !== undefined ||
      (reservation !== undefined &&
        (reservation.inFlightWrites > 0 ||
          this.registry.keyFor(reservation.requestId) !== undefined))
    );
  }
  private releaseSettledReservation(): void {
    if (!this.isBusy()) this.reservation = undefined;
  }
  private operationSignal(
    operation: AbortController,
    options?: ElwoodQuestionAnswerOptions,
  ): AbortSignal {
    try {
      return AbortSignal.any([
        operation.signal,
        this.closing,
        this.inputSignal(),
        ...(options?.signal === undefined ? [] : [options.signal]),
      ]);
    } catch {
      throw questionError("invalid_question_answer", "The question answer options are invalid.");
    }
  }
}
