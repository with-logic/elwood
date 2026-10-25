/** One abortable, generation-owned trust attempt for both layouts (PRD §5.4/C-TRUST-01). */
import type { StartupWriteCompletion } from "../startup/write.ts";
import { cursorSelection, type SelectableOption } from "../terminal-options.ts";
import type { TrustWriteResult } from "./types.ts";
import { choiceIdentity, type TrustCandidate, type TrustView } from "./view.ts";

const retryMs = 250;
const observationMs = 20;

export class TrustAttempt {
  readonly candidate: TrustCandidate;
  readonly identity: string;
  private readonly controller = new AbortController();
  private confirmationWriteFulfilled = false;
  private clearance = false;
  invalidated = false;
  /** The polled choice vanished mid-attempt; its return deserves a fresh attempt. */
  lostChoice = false;

  constructor(candidate: TrustCandidate, identity: string) {
    this.candidate = candidate;
    this.identity = identity;
  }

  get cleared(): boolean {
    return this.clearance;
  }

  start(
    write: (input: string) => TrustWriteResult,
    read: (() => TrustView | undefined) | undefined,
    deadlineAtMs: number,
  ): Promise<StartupWriteCompletion> {
    const operation = read === undefined ? this.atomic(write) : this.run(write, read, deadlineAtMs);
    return operation.catch((error: unknown) => {
      if (this.controller.signal.aborted) return this.completion();
      throw error;
    });
  }

  /**
   * With a live reader, only an observed clear/successor after a fulfilled confirmation
   * permits success. Without one (`atomic`), a fulfilled numbered write is the only evidence.
   */
  cancel(cleared = false): void {
    if (!cleared) this.invalidated = true;
    this.clearance = cleared;
    this.controller.abort();
  }

  private completion(): StartupWriteCompletion {
    return this.clearance && this.confirmationWriteFulfilled && !this.invalidated
      ? "answered"
      : "cancelled";
  }

  private async atomic(
    write: (input: string) => TrustWriteResult,
  ): Promise<StartupWriteCompletion> {
    const option = this.candidate.option!;
    if (option.style !== "numbered") return "cancelled";
    const fulfilled = await this.own(write(`${option.number}\r`));
    return fulfilled ? "answered" : "cancelled";
  }

  private async run(
    write: (input: string) => TrustWriteResult,
    read: () => TrustView | undefined,
    deadlineAtMs: number,
  ): Promise<StartupWriteCompletion> {
    let retryAt = 0;
    let previousInput: string | undefined;
    while (!this.controller.signal.aborted && Date.now() < deadlineAtMs) {
      const view = read();
      if (view === undefined) {
        // Pending rendering, synchronized output, or permanent render failure leaves
        // no usable frame. Hold the attempt's writes until evidence returns or its
        // deadline; unavailable evidence never enables the legacy no-reader path.
        if (!(await this.pause(Math.min(observationMs, deadlineAtMs - Date.now()))))
          return this.completion();
        continue;
      }
      const option = this.readChoice(view);
      if (typeof option === "string") return option;
      const step = trustStep(option);
      if (Date.now() >= retryAt || step.input !== previousInput) {
        if (this.controller.signal.aborted) return this.completion();
        if (!(await this.send(write, step))) return this.completion();
        previousInput = step.input;
        retryAt = Date.now() + retryMs;
      }
      if (!(await this.pause(Math.min(step.pollMs, retryAt - Date.now()))))
        return this.completion();
    }
    return this.completion();
  }

  private async send(
    write: (input: string) => TrustWriteResult,
    step: ReturnType<typeof trustStep>,
  ): Promise<boolean> {
    const result = write(step.input);
    // A void writer has already fulfilled before an observer can replace the frame.
    if (result === undefined && step.confirm) this.confirmationWriteFulfilled = true;
    const fulfilled = await this.own(result);
    if (fulfilled && step.confirm) this.confirmationWriteFulfilled = true;
    return fulfilled;
  }

  private readChoice(view: TrustView): SelectableOption | StartupWriteCompletion {
    const successor =
      view.kind === "candidate" && view.valid && view.spec.id !== this.candidate.spec.id;
    if (view.kind === "clear" || successor) {
      this.clearance = true;
      return this.completion();
    }
    if (view.kind !== "candidate" || choiceIdentity(view) !== this.identity) {
      this.lostChoice = true;
      return "cancelled";
    }
    return view.option!; // Identity exists only for a validated affirmative.
  }

  /** Race disposal against an in-flight write while retaining a rejection handler for it. */
  private own(write: TrustWriteResult): Promise<boolean> {
    return new Promise((resolve, reject) => {
      const signal = this.controller.signal;
      const cancel = () => resolve(false);
      if (signal.aborted) cancel();
      else signal.addEventListener("abort", cancel, { once: true });
      Promise.resolve(write).then(
        () => {
          signal.removeEventListener("abort", cancel);
          resolve(!signal.aborted);
        },
        (error: unknown) => {
          signal.removeEventListener("abort", cancel);
          reject(error);
        },
      );
    });
  }

  private pause(ms: number): Promise<boolean> {
    if (this.controller.signal.aborted) return Promise.resolve(false);
    return new Promise((resolve) => {
      const signal = this.controller.signal;
      const cancel = () => {
        clearTimeout(timer);
        resolve(false);
      };
      const timer = setTimeout(() => {
        signal.removeEventListener("abort", cancel);
        resolve(true);
      }, ms);
      timer.unref();
      signal.addEventListener("abort", cancel, { once: true });
    });
  }
}

/**
 * A cursor answer never sends a relative arrow or a bare Enter (docs/cli-behavior.md).
 * Claude 2.1.310 remounts its dialog with the cursor back on "No, exit" once its input
 * guard settles, and a retried arrow can land after the first already moved; a bare
 * Enter decided from the earlier frame then confirms the decline. The absolute selection
 * lands on the same row however often it repeats, and Enter travels only in the same
 * write as it, once the rendered cursor sits on the affirmative.
 */
function trustStep(option: SelectableOption) {
  if (option.style === "numbered")
    return { input: `${option.number}\r`, confirm: true, pollMs: retryMs };
  const select = cursorSelection(option);
  const confirm = option.offset === 0;
  return { input: confirm ? `${select}\r` : select, confirm, pollMs: observationMs };
}
