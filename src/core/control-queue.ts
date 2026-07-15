/** Serialized adapter controls with readiness semantics (PRD §5.3, C-API-19/37). */

import {
  type ControlOperationKind,
  type ControlOperationTraits,
  type ControlQueueError,
  type ControlSubmitMode,
  controlOperationTraits,
  overtakesReadiness,
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
 * Writes an operation to the terminal. Resolves only once the submission (incl.
 * any delayed Enter keystroke) has dispatched, so the queue never drains the next
 * operation into a half-written composer.
 */
export type ControlSubmitter = (
  input: string,
  mode: ControlSubmitMode,
  // Aborted when the NEXT operation dispatches, so a prior submission's recovery
  // nudges cannot fire an Enter into a later prompt's paste.
  signal: AbortSignal,
) => Promise<void>;

type QueuedOperation = {
  readonly input: string;
  readonly kind: ControlOperationKind;
  // Bypass eligibility is FROZEN at enqueue time: guidance queued before first
  // readiness stays message-like all its life (C-API-37).
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
  // Monotonic readiness version, bumped by every lifecycle transition. A failed
  // submission's rollback restores its snapshot only if the epoch is unchanged, so
  // a mid-write turn-end/dialog transition is never clobbered (see rollback).
  private readinessEpoch = 0;
  // Count of queued operations that can dispatch while not ready; lets `drain` skip
  // the overtaker scan when none exists (keeps a message backlog amortized O(1)).
  private bypassable = 0;
  /** The operation whose submission (incl. delayed Enter) is still dispatching. */
  private inFlight: QueuedOperation | undefined;
  // Aborts the current submission's background recovery nudges when the next starts.
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
    // Freeze bypass eligibility now: guidance only bypasses if already past initial
    // readiness AND mid-turn at enqueue time (C-API-37).
    const mayBypassReadiness =
      controlOperationTraits[kind].readiness === "running_after_ready" &&
      this.everReady &&
      this.guidanceMayBypass();
    return new Promise((resolve, reject) => {
      const operation = { input, kind, mayBypassReadiness, resolve, reject };
      this.queue.push(operation);
      if (overtakesReadiness(operation)) this.bypassable += 1;
      this.drain();
    });
  }

  markReady(): void {
    if (this.closed) return;
    this.everReady = true;
    this.ready = true;
    this.readinessEpoch += 1;
    this.drain();
  }

  /**
   * Suspends readiness so readiness-waiting operations (messages, compact)
   * hold until the next `markReady`. Used both when a turn starts and when a
   * blocking dialog appears; it implies no new turn on its own.
   */
  suspendReadiness(): void {
    this.ready = false;
    this.readinessEpoch += 1;
  }

  close(): void {
    this.closed = true;
    const error = this.stoppedError();
    // Reject the still-dispatching operation too: closing mid-write must fail it
    // now, not let a pending delayed Enter later resolve it.
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
    if (overtakesReadiness(operation)) this.bypassable -= 1;
    // Own the queue BEFORE lifecycle work or the write starts, so a throwing
    // turn-start listener can't leave a started write ownerless and let a
    // bypass-capable follower interleave (C-API-35).
    this.inFlight = operation;
    const traits = controlOperationTraits[operation.kind];
    // Snapshot readiness and its epoch so rollback can restore the prior value (see rollback).
    const priorReady = this.ready;
    const dispatchEpoch = this.readinessEpoch;
    let dispatched: Promise<void>;
    try {
      this.beginSubmission(traits);
      dispatched = this.submit(operation.input, traits.submitMode, this.armAbort());
    } catch (error) {
      this.rollbackSubmission(operation, priorReady, dispatchEpoch, toError(error));
      return;
    }
    // The write holds the next drain so operations never interleave; no-op if close() settled it.
    dispatched.then(
      () => this.settleInFlight(operation, () => operation.resolve()),
      (error: unknown) =>
        this.rollbackSubmission(operation, priorReady, dispatchEpoch, toError(error)),
    );
  }

  // Restore readiness on a failed submission (it never started a turn, so no Stop
  // is coming) — but ONLY if no lifecycle transition bumped the epoch since
  // dispatch, so a stale snapshot never clobbers a newer markReady/suspend nor
  // fabricates/re-opens readiness the session never had mid-write (C-API-35/37).
  private rollbackSubmission(
    operation: QueuedOperation,
    priorReady: boolean,
    dispatchEpoch: number,
    error: Error,
  ): void {
    if (!this.closed && this.readinessEpoch === dispatchEpoch) this.ready = priorReady;
    this.settleInFlight(operation, () => operation.reject(error));
  }

  // Index of the next operation to dispatch, or -1. Head dispatches when ready;
  // otherwise the first overtaker goes. `bypassable === 0` skips the scan.
  private nextDispatchIndex(): number {
    if (this.ready) return 0;
    if (overtakesReadiness(this.queue[0] as QueuedOperation)) return 0;
    if (this.bypassable === 0) return -1;
    return this.queue.findIndex(overtakesReadiness);
  }

  private settleInFlight(operation: QueuedOperation, settle: () => void): void {
    // close() may have already rejected and cleared this operation.
    if (this.inFlight !== operation) return;
    this.inFlight = undefined;
    settle();
    this.drain();
  }

  // State-mutating lifecycle (consume readiness, report caller turn) runs BEFORE
  // the write, so a throwing status listener aborts with nothing in flight yet.
  private beginSubmission(traits: ControlOperationTraits): void {
    if (traits.consumesReadiness) this.ready = false;
    if (traits.reportsCallerSubmission) this.onTurnStarted();
  }

  // Fresh signal per submission; aborting the PRIOR one halts its background
  // nudges so an older nudge can't fire an Enter into this paste.
  private armAbort(): AbortSignal {
    this.submitAbort?.abort();
    this.submitAbort = new AbortController();
    return this.submitAbort.signal;
  }
}
