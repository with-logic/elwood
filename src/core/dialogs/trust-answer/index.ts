/** Reserve and translate one human workspace trust answer (PRD §5.3, C-ATTN-07). */
import { elwoodError } from "../../errors.ts";
import type { SelectableOption } from "../../terminal-options.ts";
import { deadlineClock, scheduleDeadline } from "../../timers.ts";
import type { ElwoodDialogAnswerOptions } from "../types.ts";
import type { AnswerFailureCategory, AnswerIo, WorkspaceTrustOutcome } from "./io.ts";
import { answerOptions, scheduleInputGrace } from "./options.ts";

export type { ReadChoice } from "./io.ts";

type Active<ChoiceIndex> = {
  readonly gateIdentity: string;
  readonly requestId: string;
  readonly choiceIndex: ChoiceIndex;
  readonly outcome: WorkspaceTrustOutcome;
  readonly deadlineAtMs: number;
  readonly result: PromiseWithResolvers<void>;
  readonly cleanup: () => void;
  readonly proofLifetime: AbortController;
  lastFrame?: object;
  reading: boolean;
  recheck: boolean;
  phase: "selecting" | "writing" | "writingConfirmation" | "awaitingNativeOutcome";
};

const failure = (category: AnswerFailureCategory) =>
  elwoodError("dialog_answer_failed", "Elwood could not verify the native dialog answer.", {
    category,
  });

export class WorkspaceTrustAnswers<
  Option extends SelectableOption = SelectableOption,
  ChoiceIndex extends number = number,
> {
  private active: Active<ChoiceIndex> | undefined;
  private readonly io: AnswerIo<Option, ChoiceIndex>;
  constructor(io: AnswerIo<Option, ChoiceIndex>) {
    this.io = io;
  }

  async answer(requestId: string, choiceId: string, options?: ElwoodDialogAnswerOptions) {
    const current = this.io.currentRequest();
    if (!current || current.request.id !== requestId)
      throw elwoodError("dialog_not_found", "The native dialog request is no longer available.");
    const choice = current.choices.find(({ id }) => id === choiceId);
    if (!choice) throw elwoodError("invalid_dialog_answer", "The native dialog choice is invalid.");
    const { signal, timeoutMs } = answerOptions(options);
    if (this.active) throw failure("busy");
    if (signal.aborted) throw failure("aborted");
    const now = deadlineClock.now();
    const deadlineAtMs = now + timeoutMs;
    const result = Promise.withResolvers<void>();
    const abort = () => this.revoke();
    const expire = () => this.expire();
    const clearDeadline = scheduleDeadline(
      { deadlineAtMs, initialDelayMs: timeoutMs },
      expire,
      deadlineClock,
    );
    const clearGrace = scheduleInputGrace(current.earliestInputAtMs, now, () => this.advance());
    signal.addEventListener("abort", abort, { once: true });
    this.active = {
      gateIdentity: current.gateIdentity,
      requestId,
      choiceIndex: choice.choiceIndex,
      outcome: choice.outcome,
      deadlineAtMs,
      result,
      proofLifetime: new AbortController(),
      cleanup() {
        clearDeadline();
        clearGrace?.();
        signal.removeEventListener("abort", abort);
      },
      phase: "selecting",
      reading: false,
      recheck: false,
    };
    if (!clearGrace) this.advance();
    await result.promise;
  }

  resumeNavigation(): void {
    if (this.active?.lastFrame) this.advance();
  }
  private advance(): void {
    const active = this.active;
    if (active?.phase !== "selecting") return;
    if (active.reading) {
      active.recheck = true;
      return;
    }
    active.reading = true;
    active.recheck = false;
    this.io.readChoice(
      active.gateIdentity,
      active.choiceIndex,
      active.requestId,
      active.lastFrame,
      (choice) => {
        if (!this.isCurrent(active)) return;
        active.reading = false;
        if (!choice || choice.frame === active.lastFrame || !choice.claim()) {
          if (!active.lastFrame) {
            this.finish("frame");
          } else if (active.recheck) this.advance();
          return;
        }
        const { keys, confirm } = this.io.step(choice.option);
        active.lastFrame = choice.frame;
        active.phase = confirm ? "writingConfirmation" : "writing";
        void this.send(active, keys, confirm);
      },
      active.proofLifetime.signal,
    );
  }

  private async send(active: Active<ChoiceIndex>, keys: string, confirm: boolean): Promise<void> {
    try {
      await this.io.write(keys);
    } catch {
      if (this.active === active) this.finish("terminal_write");
      return;
    }
    if (!this.isCurrent(active)) return;
    if (confirm) {
      active.phase = "awaitingNativeOutcome";
      try {
        this.io.reconcileDialogEvidence();
      } catch {
        if (this.active === active) this.finish("frame");
      }
    } else {
      active.phase = "selecting";
      this.advance();
    }
  }
  private expire(): void {
    this.finish(this.confirmationDispatched ? "native_acceptance" : "frame");
  }
  private isCurrent(active: Active<ChoiceIndex>): boolean {
    if (this.active !== active) return false;
    if (deadlineClock.now() >= active.deadlineAtMs) this.expire();
    return this.active === active;
  }
  recordConfirmation(outcome: Exclude<WorkspaceTrustOutcome, "exit">): boolean {
    const active = this.active;
    if (
      active?.phase !== "awaitingNativeOutcome" ||
      active.outcome !== outcome ||
      !this.isCurrent(active)
    )
      return false;
    this.finish();
    return true;
  }
  get confirmationDispatched(): boolean {
    return (
      this.active?.phase === "awaitingNativeOutcome" || this.active?.phase === "writingConfirmation"
    );
  }

  retireNavigation(requestId: string): void {
    if (this.active?.requestId === requestId && !this.confirmationDispatched) this.finish("frame");
  }
  revokeIfGateChanged(gateIdentity: string | undefined): void {
    if (gateIdentity && this.active && this.active.gateIdentity !== gateIdentity)
      this.finish("frame");
  }

  revoke(category: "aborted" | "frame" = "aborted"): void {
    this.finish(category);
  }
  get awaitingNativeExit(): boolean {
    return this.active?.phase === "awaitingNativeOutcome" && this.active.outcome === "exit";
  }
  nativeExit(matchesNativeDecline: boolean): void {
    const active = this.active;
    if (
      matchesNativeDecline &&
      active?.phase === "awaitingNativeOutcome" &&
      active.outcome === "exit" &&
      this.isCurrent(active)
    )
      this.finish();
    else this.finish("terminal_exit");
  }

  private finish(category?: AnswerFailureCategory): void {
    const active = this.active;
    if (!active) return;
    this.active = undefined;
    active.proofLifetime.abort();
    active.cleanup();
    if (category) {
      if (active.lastFrame) this.io.relinquish(active.gateIdentity);
      active.result.reject(failure(category));
    } else active.result.resolve();
  }
}
