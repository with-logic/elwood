/** Serialized adapter controls with readiness semantics (PRD §5.3, C-API-19/37). */

import {
  type ControlOperationKind,
  type ControlQueueError,
  type ControlSubmitMode,
  controlOperationTraits,
} from "./control-queue-traits.ts";

export type {
  ControlOperationKind,
  ControlOperationTraits,
  ControlQueueError,
  ControlSubmitMode,
  ReadinessPolicy,
} from "./control-queue-traits.ts";
export { controlOperationTraits } from "./control-queue-traits.ts";

/**
 * Writes an operation to the terminal. Resolves only once the submission —
 * including any delayed Enter keystroke — has been dispatched, so the queue
 * does not drain the next operation into a half-written composer.
 */
export type ControlSubmitter = (input: string, mode: ControlSubmitMode) => Promise<void>;

type QueuedOperation = {
  readonly input: string;
  readonly kind: ControlOperationKind;
  // Bypass eligibility is FROZEN at enqueue time: guidance that was queued
  // before first readiness (or while blocked) behaves like a message for its
  // whole lifetime and must not later reclassify into an active turn (C-API-37).
  readonly mayBypassReadiness: boolean;
  readonly resolve: () => void;
  readonly reject: (error: Error) => void;
};

export class ControlQueue {
  private readonly queue: QueuedOperation[] = [];
  private readonly submit: ControlSubmitter;
  private readonly stoppedError: ControlQueueError;
  private readonly onTurnStarted: () => void;
  private readonly guidanceMayBypass: () => boolean;
  private ready = false;
  private everReady = false;
  private closed = false;
  // Count of queued operations that can dispatch while not ready (prompts,
  // picker commands, bypass-eligible guidance). Lets `drain` skip the O(n) scan
  // for an overtaker when none exists — so N held messages stay amortized O(1).
  private bypassable = 0;
  /** The operation whose submission (incl. delayed Enter) is still dispatching. */
  private inFlight: QueuedOperation | undefined;

  constructor(
    submit: ControlSubmitter,
    stoppedError: ControlQueueError,
    onTurnStarted: () => void,
    guidanceMayBypass: () => boolean = () => false,
  ) {
    this.submit = submit;
    this.stoppedError = stoppedError;
    this.onTurnStarted = onTurnStarted;
    this.guidanceMayBypass = guidanceMayBypass;
  }

  send(input: string, kind: ControlOperationKind): Promise<void> {
    if (this.closed) return Promise.reject(this.stoppedError());
    // Freeze bypass eligibility now: guidance only bypasses if the session is
    // already past initial readiness AND currently mid-turn at enqueue time.
    const mayBypassReadiness =
      controlOperationTraits[kind].readiness === "running_after_ready" &&
      this.everReady &&
      this.guidanceMayBypass();
    return new Promise((resolve, reject) => {
      const operation = { input, kind, mayBypassReadiness, resolve, reject };
      this.queue.push(operation);
      if (this.dispatchesWhileNotReady(operation)) this.bypassable += 1;
      this.drain();
    });
  }

  markReady(): void {
    if (this.closed) return;
    this.everReady = true;
    this.ready = true;
    this.drain();
  }

  /**
   * Suspends readiness so readiness-waiting operations (messages, compact)
   * hold until the next `markReady`. Used both when a turn starts and when a
   * blocking dialog appears; it implies no new turn on its own.
   */
  suspendReadiness(): void {
    this.ready = false;
  }

  close(): void {
    this.closed = true;
    const error = this.stoppedError();
    // Reject the still-dispatching operation too: closing while a command's
    // delayed Enter is pending must fail it immediately with the stopped
    // error, not let it later resolve or time out downstream.
    const settling = this.inFlight;
    this.inFlight = undefined;
    this.bypassable = 0;
    if (settling) settling.reject(error);
    for (const operation of this.queue.splice(0)) operation.reject(error);
  }

  private drain(): void {
    if (this.inFlight || this.queue.length === 0) return;
    const index = this.nextDispatchIndex();
    if (index < 0) return;
    const operation = this.queue.splice(index, 1)[0] as QueuedOperation;
    if (this.dispatchesWhileNotReady(operation)) this.bypassable -= 1;
    let dispatched: Promise<void>;
    try {
      dispatched = this.submitNow(operation.input, operation.kind);
    } catch (error) {
      operation.reject(asError(error));
      this.drain();
      return;
    }
    // The write (incl. any delayed command Enter) holds the next drain so
    // back-to-back queued operations never interleave in the terminal. The
    // caller settles with the write's outcome; if close() already settled this
    // operation, the handlers no-op (inFlight was cleared).
    this.inFlight = operation;
    dispatched.then(
      () => this.settleInFlight(operation, () => operation.resolve()),
      (error: unknown) => this.settleInFlight(operation, () => operation.reject(asError(error))),
    );
  }

  /**
   * The queue index of the next operation to dispatch, or -1 if none can. The
   * head dispatches when ready; otherwise the first operation that dispatches
   * while not ready (a prompt/command, or bypass-eligible guidance) overtakes
   * it. When no such overtaker is queued the scan is skipped, keeping a backlog
   * of held messages amortized O(1) rather than O(n) per enqueue.
   */
  private nextDispatchIndex(): number {
    if (this.ready) return 0;
    if (this.dispatchesWhileNotReady(this.queue[0] as QueuedOperation)) return 0;
    if (this.bypassable === 0) return -1;
    return this.queue.findIndex((operation) => this.dispatchesWhileNotReady(operation));
  }

  /** Whether the operation may dispatch even though the session is not ready. */
  private dispatchesWhileNotReady(operation: QueuedOperation): boolean {
    const policy = controlOperationTraits[operation.kind].readiness;
    if (policy === "always") return true;
    return policy === "running_after_ready" && operation.mayBypassReadiness;
  }

  private settleInFlight(operation: QueuedOperation, settle: () => void): void {
    // close() may have already rejected and cleared this operation.
    if (this.inFlight !== operation) return;
    this.inFlight = undefined;
    settle();
    this.drain();
  }

  /** Writes the operation and returns a promise for when its write fully lands. */
  private submitNow(input: string, kind: ControlOperationKind): Promise<void> {
    const traits = controlOperationTraits[kind];
    if (traits.consumesReadiness) this.ready = false;
    const dispatched = this.submit(input, traits.submitMode);
    if (traits.startsTurn) this.onTurnStarted();
    return dispatched;
  }
}

function asError(value: unknown): Error {
  return value instanceof Error ? value : new Error(String(value));
}
