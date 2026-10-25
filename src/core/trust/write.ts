/** One abortable, generation-owned trust attempt for both layouts (PRD §5.4/C-TRUST-01). */
import type { StartupWriteCompletion } from "../startup/write.ts";
import { cursorSelection, type SelectableOption } from "../terminal-options.ts";
import { abortableDelay, ownWrite, untilWoken } from "./abortable.ts";
import type { GateDeadline } from "./deadline.ts";
import type { TrustWriteResult } from "./types.ts";
import { choiceIdentity, type TrustCandidate, type TrustView } from "./view.ts";

const retryMs = 250;
const observationMs = 20;

export class TrustAttempt {
  readonly candidate: TrustCandidate;
  readonly identity: string;
  private readonly controller = new AbortController();
  private clearance = false;
  private retryAt = 0;
  private previousInput: string | undefined;
  private wakeWaiter: (() => void) | undefined;
  /** The confirming write fulfilled; that is not clearance, which only a frame verifies. */
  confirmationWriteFulfilled = false;
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

  /** A frame rendered: a waiting answer re-reads it (see `awaiting`). */
  wake(): void {
    const waiter = this.wakeWaiter;
    this.wakeWaiter = undefined;
    waiter?.();
  }

  /** The deadline is read live, so a gate that returns writes within its resumed budget. */
  start(
    write: (input: string) => TrustWriteResult,
    read: (() => TrustView | undefined) | undefined,
    deadline: Pick<GateDeadline, "deadlineAtMs">,
  ): Promise<StartupWriteCompletion> {
    const operation = read === undefined ? this.atomic(write) : this.run(write, read, deadline);
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
    deadline: Pick<GateDeadline, "deadlineAtMs">,
  ): Promise<StartupWriteCompletion> {
    while (!this.controller.signal.aborted) {
      const view = read();
      if (this.awaiting(view)) {
        if (!(await this.nextFrame())) return this.completion();
        continue;
      }
      const remainingMs = deadline.deadlineAtMs - Date.now();
      if (remainingMs <= 0) break;
      if (view === undefined) {
        // Pending rendering, synchronized output, or permanent render failure leaves
        // no usable frame. Hold the attempt's writes until evidence returns or its
        // deadline; unavailable evidence never enables the legacy no-reader path.
        if (!(await this.pause(Math.min(observationMs, remainingMs)))) return this.completion();
        continue;
      }
      const option = this.readChoice(view);
      if (typeof option === "string") return option;
      const step = trustStep(option);
      if (!(await this.send(write, step))) return this.completion();
      if (!(await this.pause(Math.min(step.pollMs, this.retryAt - Date.now()))))
        return this.completion();
    }
    return this.completion();
  }

  /**
   * A confirmed answer whose gate left the frame (the CLI erased it and is painting its
   * next screen), or whose frame is unavailable, writes nothing and is not lost: it waits,
   * unbounded here and without polling, for verified clearance or the gate's return. The
   * coordinator owns that wait's end: clearance, expiry, a changed gate, an off-allowlist
   * gate (which a human must answer), or closing (C-TRUST-01).
   */
  private awaiting(view: TrustView | undefined): boolean {
    if (!this.confirmationWriteFulfilled) return false;
    return view === undefined || (view.kind === "unknown" && view.gate !== true);
  }

  private nextFrame(): Promise<boolean> {
    return untilWoken(this.controller.signal, (wake) => {
      this.wakeWaiter = wake;
    });
  }

  private own(write: TrustWriteResult): Promise<boolean> {
    return ownWrite(this.controller.signal, write);
  }

  private pause(ms: number): Promise<boolean> {
    return abortableDelay(this.controller.signal, ms);
  }

  /** Write `step` unless it repeats the last input within the retry interval. */
  private async send(
    write: (input: string) => TrustWriteResult,
    step: ReturnType<typeof trustStep>,
  ): Promise<boolean> {
    if (Date.now() < this.retryAt && step.input === this.previousInput) return true;
    if (this.controller.signal.aborted) return false;
    const result = write(step.input);
    // A void writer has already fulfilled before an observer can replace the frame.
    if (result === undefined && step.confirm) this.confirmationWriteFulfilled = true;
    const fulfilled = await this.own(result);
    if (fulfilled && step.confirm) this.confirmationWriteFulfilled = true;
    this.previousInput = step.input;
    this.retryAt = Date.now() + retryMs;
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
