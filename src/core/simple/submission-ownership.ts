/** Attribute native hooks to bounded, ordered physical submissions (PRD §5.9). */
import { AsyncLocalStorage } from "node:async_hooks";
import { elwoodError } from "../errors.ts";
import { type BoundarySession, observeTurnBoundary } from "./observe-boundary.ts";
import type { TurnBoundaryHook } from "./turn-types.ts";

const limits = { count: 1024, bytes: 8 * 1024 * 1024 };
type Submission = {
  readonly completion: ReturnType<typeof Promise.withResolvers<void>>;
  readonly ready: ReturnType<typeof Promise.withResolvers<void>>;
  /** Remains latched after removal to fence delayed writes into retired records. */
  finished: boolean;
  bytes: number;
  prompt?: string | undefined;
  accepted?: { readonly turn_id: string | undefined } | undefined;
  stop?: TurnBoundaryHook | undefined;
  observer?: ReturnType<typeof observeTurnBoundary> | undefined;
};

export class SubmissionOwnership {
  private readonly submissions = new Set<Submission>();
  private readonly active = new AsyncLocalStorage<Submission>();
  private bytes = 0;
  private nativeRunning = false;
  private readonly session: BoundarySession;
  private readonly closing: AbortSignal;
  private readonly canonicalPrompt: (prompt: string) => string;

  constructor(
    session: BoundarySession,
    closing: AbortSignal,
    canonicalPrompt: (prompt: string) => string,
  ) {
    this.session = session;
    this.closing = closing;
    this.canonicalPrompt = canonicalPrompt;
    const unsubscribe = session.on("hook", (event) => this.hook(event));
    closing.addEventListener(
      "abort",
      () => {
        unsubscribe();
        this.active.disable();
        for (const submission of this.submissions) {
          submission.observer?.discard();
          this.finish(submission, elwoodError("session_not_running", "Session is closing."));
        }
      },
      { once: true },
    );
  }

  observeNativeStatus(running: boolean): void {
    this.nativeRunning = running;
  }

  /** Confirm idle freshly observed after Stop; earlier ready status is not enough. */
  confirmNativeIdle(): void {
    this.nativeRunning = false;
    for (const submission of this.submissions) submission.observer?.confirmIdle();
  }

  get hasRunningOwner(): boolean {
    return (
      this.nativeRunning || [...this.submissions].some((prior) => prior.accepted && !prior.stop)
    );
  }

  /** A selected loop waits for earlier native ownership without occupying physical input. */
  reserve() {
    const submission = this.create();
    return {
      ready: submission.ready.promise,
      completion: submission.completion.promise,
      /** Bind an already-admitted write; ready is awaited outside the physical input slot. */
      bindWrite: (write: () => Promise<void>) => this.active.run(submission, write),
      discard: () => {
        // A failed attempted Enter can still have committed. Its owner stays until
        // native completion or shutdown; only an unattempted reservation is discarded.
        if (submission.prompt === undefined) this.finish(submission);
      },
    };
  }

  /** Called immediately before the physical submitting Enter, including raw caller input. */
  entering(prompt: string, steering = false): void {
    if (this.closing.aborted) throw elwoodError("session_not_running", "Session is closing.");
    const bound = this.active.getStore();
    if (bound?.finished) throw new Error("Submission reservation is no longer active.");
    if (steering) return;
    const submission = bound ?? this.create();
    const canonical = this.canonicalPrompt(prompt);
    const bytes = Buffer.byteLength(canonical);
    if (this.bytes + bytes > limits.bytes) {
      const error = this.full();
      this.finish(submission, error);
      throw error;
    }
    submission.bytes = bytes;
    this.bytes += bytes;
    submission.prompt = canonical;
    submission.observer = observeTurnBoundary(this.session, this.closing, {
      accepted: () => submission.accepted !== undefined,
      ownsHook: (event) => event === submission.stop,
      ownsActivity: (event) =>
        event.turnId === undefined ||
        submission.accepted?.turn_id === undefined ||
        event.turnId === submission.accepted.turn_id,
    });
    void submission.observer.promise.then(
      () => this.finish(submission),
      () => this.finish(submission),
    );
  }

  private create(): Submission {
    if (this.closing.aborted) throw elwoodError("session_not_running", "Session is closing.");
    if (this.submissions.size >= limits.count) throw this.full();
    const submission: Submission = {
      completion: Promise.withResolvers<void>(),
      ready: Promise.withResolvers<void>(),
      finished: false,
      bytes: 0,
    };
    void submission.ready.promise.catch(() => undefined);
    void submission.completion.promise.catch(() => undefined);
    this.submissions.add(submission);
    if (this.submissions.size === 1) submission.ready.resolve();
    return submission;
  }

  private hook(event: TurnBoundaryHook): void {
    if (event.hook_event_name === "UserPromptSubmit" && event.prompt !== undefined) {
      for (const submission of this.submissions) {
        if (!submission.accepted && submission.prompt === event.prompt) {
          submission.accepted = { turn_id: event.turn_id };
          break;
        }
      }
    } else if (event.hook_event_name === "Stop") {
      for (const submission of this.submissions) {
        // Untagged completion cannot jump an earlier ambiguous attempted input.
        if (event.turn_id === undefined && submission.prompt !== undefined && !submission.accepted)
          return;
        if (submission.accepted && submission.accepted.turn_id === event.turn_id) {
          submission.stop = event;
          break;
        }
      }
    }
  }

  private finish(submission: Submission, error?: Error): void {
    if (!this.submissions.has(submission)) return;
    if (submission.finished && !error) return;
    if (error) {
      submission.ready.reject(error);
      submission.completion.reject(error);
    } else submission.completion.resolve();
    this.bytes -= submission.bytes;
    submission.bytes = 0;
    submission.finished = true;
    submission.prompt = undefined;
    submission.accepted = undefined;
    submission.stop = undefined;
    submission.observer = undefined;
    if (this.closing.aborted) {
      this.submissions.delete(submission);
      return;
    }
    // Cancelled successors retain bounded ordering slots until prior owners finish.
    // No promise chain or readiness edge can bypass an unresolved oldest owner.
    for (const pending of this.submissions) {
      pending.ready.resolve();
      if (!pending.finished) break;
      this.submissions.delete(pending);
    }
  }

  private full() {
    return elwoodError("input_queue_full", "The session input queue is full.");
  }
}
