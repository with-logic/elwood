/** Own one answer attempt until native acceptance or revocation (PRD §4). */
import type { ElwoodTerminal } from "../../terminal/headless.ts";
import { untilQuestionAbort } from "./abort.ts";
import type { QuestionAdapter } from "./adapter.ts";
import { questionDeadline } from "./deadline.ts";
import { type QuestionFailurePhase, questionAnswerFailed, questionError } from "./errors.ts";
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
    const reservation = this.reservation;
    // Retired requests retain native ownership without a second closed event.
    if (
      reservation &&
      reservation.inFlightWrites === 0 &&
      this.registry.keyFor(reservation.requestId) === undefined
    )
      this.reservation = undefined;
    return this.active !== undefined || this.reservation !== undefined;
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
    if (this.busy() || !adapter) throw questionAnswerFailed();
    const operation = new AbortController();
    const signal = this.operationSignal(operation, options);
    // Reading options.signal can reenter run() before this attempt installs its owner.
    if (this.busy()) throw questionAnswerFailed();
    this.active = operation;
    const reservation = { requestId, inFlightWrites: 0 };
    let writeAttempted = false;
    let nativeAccepted = false;
    let failurePhase: QuestionFailurePhase = "frame_wait";
    let adapterFinished = false;
    let wake: (() => void) | undefined;
    const stopDeadline = questionDeadline(timeoutMs, () => operation.abort(questionAnswerFailed()));
    const off = this.registry.onEvent((event) => {
      if (event.phase !== "closed" || event.request.id !== requestId) return;
      if (event.reason === "answered") {
        nativeAccepted = true;
        if (adapterFinished) stopDeadline();
        wake?.();
      } else operation.abort(questionAnswerFailed());
    });
    const assertLive = () => {
      const requestAvailable = this.registry.get(requestId) !== undefined;
      const requestAvailableOrAccepted = nativeAccepted || requestAvailable;
      if (signal.aborted || !requestAvailableOrAccepted) throw questionAnswerFailed();
    };
    const io = questionInput(this.terminal, this.registry, request, signal, assertLive, {
      started: () => {
        writeAttempted = true;
        this.reservation = reservation;
        reservation.inFlightWrites++;
      },
      settled: () => {
        reservation.inFlightWrites--;
      },
      failed: () => {
        failurePhase = "terminal_write";
      },
    });
    try {
      assertLive();
      await io.wait(() => true);
      failurePhase = "adapter";
      await untilQuestionAbort(adapter.answer(request, validated, io), signal);
      adapterFinished = true;
      failurePhase = "native_acceptance";
      if (nativeAccepted) stopDeadline();
      if (!nativeAccepted) {
        await new Promise<void>((resolve) => {
          wake = () => resolve();
          signal.addEventListener("abort", wake, { once: true });
          if (signal.aborted) resolve();
        });
      }
      assertLive();
    } catch {
      // Retirement emits a closed edge that aborts this operation; retain the original safe phase.
      const phase = signal.aborted ? "revoked" : failurePhase;
      if (writeAttempted && !nativeAccepted) {
        try {
          this.registry.retireUnconfirmed(requestId);
        } catch {
          // Observer failures cannot restore native authority or expose answer-bearing causes.
        }
      }
      throw questionAnswerFailed(phase);
    } finally {
      if (wake) signal.removeEventListener("abort", wake);
      operation.abort();
      stopDeadline();
      off();
      this.active = undefined;
    }
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
