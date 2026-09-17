/** One abortable, generation-owned trust attempt for both layouts (PRD §5.4/C-TRUST-01). */
import type { StartupWriteCompletion } from "../startup/write.ts";
import type { SelectableOption } from "../terminal-options.ts";
import type { TrustWriteResult } from "./types.ts";
import { choiceIdentity, type TrustCandidate, type TrustView } from "./view.ts";

const retryMs = 250;
const observationMs = 20;

export class TrustAttempt {
  readonly candidate: TrustCandidate;
  readonly identity: string;
  private readonly controller = new AbortController();
  private confirmed = false;
  private clearance = false;
  invalidated = false;

  constructor(candidate: TrustCandidate, identity: string) {
    this.candidate = candidate;
    this.identity = identity;
  }

  get cleared(): boolean {
    return this.clearance;
  }

  start(
    write: (input: string) => TrustWriteResult,
    read: (() => TrustView) | undefined,
    deadline: number,
  ): Promise<StartupWriteCompletion> {
    const operation = read === undefined ? this.atomic(write) : this.run(write, read, deadline);
    return operation.catch((error: unknown) => {
      if (this.controller.signal.aborted) return this.completion();
      throw error;
    });
  }

  /** Only an observed clear/successor after a fulfilled confirmation permits success. */
  cancel(cleared = false): void {
    if (!cleared) this.invalidated = true;
    this.clearance = cleared;
    this.controller.abort();
  }

  private completion(): StartupWriteCompletion {
    return this.clearance && this.confirmed && !this.invalidated ? "answered" : "cancelled";
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
    read: () => TrustView,
    deadline: number,
  ): Promise<StartupWriteCompletion> {
    let retryAt = 0;
    let previousOffset: number | undefined;
    while (!this.controller.signal.aborted && Date.now() < deadline) {
      const option = this.readChoice(read());
      if (typeof option === "string") return option;
      const step = trustStep(option);
      if (Date.now() >= retryAt || step.offset !== previousOffset) {
        if (this.controller.signal.aborted) return this.completion();
        if (!(await this.send(write, step))) return this.completion();
        previousOffset = step.offset;
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
    const result = write(step.key);
    // A void writer has already fulfilled before an observer can replace the frame.
    if (result === undefined && step.confirm) this.confirmed = true;
    const fulfilled = await this.own(result);
    if (fulfilled && step.confirm) this.confirmed = true;
    return fulfilled;
  }

  private readChoice(view: TrustView): SelectableOption | StartupWriteCompletion {
    const successor =
      view.kind === "candidate" && view.valid && view.spec.id !== this.candidate.spec.id;
    if (view.kind === "clear" || successor) {
      this.clearance = true;
      return this.completion();
    }
    if (view.kind !== "candidate" || choiceIdentity(view) !== this.identity) return "cancelled";
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

function trustStep(option: SelectableOption) {
  if (option.style === "numbered")
    return { key: `${option.number}\r`, offset: undefined, confirm: true, pollMs: retryMs };
  return {
    key: option.offset === 0 ? "\r" : option.offset < 0 ? "\u001b[A" : "\u001b[B",
    offset: option.offset,
    confirm: option.offset === 0,
    pollMs: observationMs,
  };
}
