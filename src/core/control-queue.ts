/** Serialized adapter controls with readiness semantics (PRD §5.3, C-API-19/37). */

import {
  type ControlOperationKind,
  type ControlOperationTraits,
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

import { toError } from "./errors.ts";

/**
 * Writes an operation to the terminal. Resolves only once the submission —
 * including any delayed Enter keystroke — has been dispatched, so the queue
 * does not drain the next operation into a half-written composer.
 */
export type ControlSubmitter = (
  input: string,
  mode: ControlSubmitMode,
  // Aborted when the NEXT operation begins dispatching, so a prior submission's
  // background recovery nudges cannot fire an Enter into a later prompt's paste.
  signal: AbortSignal,
) => Promise<void>;

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
  /** Aborts the current submission's background recovery nudges when the next starts. */
  private submitAbort: AbortController | undefined;

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
    // Own the queue BEFORE lifecycle work or the write starts, so a throwing
    // turn-start listener can't leave a started write ownerless and let a
    // bypass-capable follower interleave with it (C-API-35).
    this.inFlight = operation;
    const traits = controlOperationTraits[operation.kind];
    let dispatched: Promise<void>;
    try {
      this.beginSubmission(traits);
      dispatched = this.submit(operation.input, traits.submitMode, this.armAbort());
    } catch (error) {
      this.rollbackSubmission(operation, traits, toError(error));
      return;
    }
    // The write (incl. any delayed command Enter) holds the next drain so
    // back-to-back queued operations never interleave. close() may have already
    // settled this operation, in which case these handlers no-op.
    dispatched.then(
      () => this.settleInFlight(operation, () => operation.resolve()),
      (error: unknown) => this.rollbackSubmission(operation, traits, toError(error)),
    );
  }

  // Restore consumed readiness on a failed submission: it never actually started
  // a turn, so no Stop signal is coming — without this the queue wedges unready.
  private rollbackSubmission(
    operation: QueuedOperation,
    traits: ControlOperationTraits,
    error: Error,
  ): void {
    if (traits.consumesReadiness && !this.closed) this.ready = true;
    this.settleInFlight(operation, () => operation.reject(error));
  }

  // Index of the next operation to dispatch, or -1. The head dispatches when
  // ready; otherwise the first dispatch-while-not-ready operation (a prompt/command
  // or bypass-eligible guidance) overtakes it. The `bypassable` counter skips the
  // scan when no overtaker is queued, keeping a message backlog amortized O(1).
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

  // State-mutating lifecycle (consume readiness, report caller turn) runs BEFORE
  // the write, so a throwing status listener aborts with nothing yet in flight.
  private beginSubmission(traits: ControlOperationTraits): void {
    if (traits.consumesReadiness) this.ready = false;
    if (traits.startsTurn) this.onTurnStarted();
  }

  // Fresh abort signal per submission; aborting the PRIOR one halts its background
  // recovery nudges so an older nudge can't fire an Enter into this paste.
  private armAbort(): AbortSignal {
    this.submitAbort?.abort();
    this.submitAbort = new AbortController();
    return this.submitAbort.signal;
  }
}
