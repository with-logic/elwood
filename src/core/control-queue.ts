/** Serialized adapter controls with readiness semantics (PRD §5.3, C-API-19/37). */

import {
  type ControlOperationKind,
  type ControlOperationTraits,
  type ControlQueueError,
  type ControlSubmitMode,
  controlOperationTraits,
  nextDispatchIndex,
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

// Writes an op to the terminal; resolves only once the submission (incl. any
// delayed Enter) has dispatched, so the next op never drains into a half-written
// composer. `signal` aborts on the NEXT op / on close, so prior recovery nudges
// can't fire an Enter into a later paste.
export type ControlSubmitter = (
  input: string,
  mode: ControlSubmitMode,
  signal: AbortSignal,
) => Promise<void>;

type QueuedOperation = {
  readonly input: string;
  readonly kind: ControlOperationKind;
  // FROZEN at enqueue: guidance queued before first readiness stays message-like (C-API-37).
  readonly mayBypassReadiness: boolean;
  // An EXCLUSIVE op (e.g. `login`) runs an interactive task holding the queue
  // in-flight for its whole duration; aborted on close. `input`/submitMode unused.
  readonly run?: ExclusiveTask;
  readonly resolve: () => void;
  readonly reject: (error: Error) => void;
};

/** Runs an exclusive interactive task; aborted when the session closes. */
export type ExclusiveTask = (signal: AbortSignal) => Promise<void>;

export class ControlQueue {
  private readonly queue: QueuedOperation[] = [];
  private readonly submit: ControlSubmitter;
  private readonly stoppedError: ControlQueueError;
  private readonly onTurnStarted: () => void;
  private readonly guidanceMayBypass: () => boolean;
  private ready = false;
  private everReady = false;
  private closed = false;
  // Monotonic readiness version bumped by every lifecycle transition; a failed
  // submission's rollback restores its snapshot only if the epoch is unchanged.
  private readinessEpoch = 0;
  // Count of queued ops that can dispatch while not ready; lets `drain` skip the
  // overtaker scan when none exists (keeps a message backlog amortized O(1)).
  private bypassable = 0;
  private inFlight: QueuedOperation | undefined; // submission still dispatching (incl. delayed Enter)
  private submitAbort: AbortController | undefined; // aborts prior submission's nudges

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
    // Freeze bypass eligibility: guidance bypasses only if past initial readiness
    // AND mid-turn at enqueue time (C-API-37).
    const mayBypassReadiness =
      controlOperationTraits[kind].readiness === "running_after_ready" &&
      this.everReady &&
      this.guidanceMayBypass();
    return this.enqueue({ input, kind, mayBypassReadiness });
  }

  // Run an interactive task holding EXCLUSIVE queue ownership for its whole duration
  // (C-API-43 login): serialized behind queued work, blocking every later op until
  // it settles, abort-on-close. `login`'s `always` readiness lets it run pre-`ready`.
  runExclusive(kind: ControlOperationKind, run: ExclusiveTask): Promise<void> {
    return this.enqueue({ input: "", kind, mayBypassReadiness: false, run });
  }

  // Push an op, track bypass-eligibility, drain; rejects a post-close enqueue.
  private enqueue(fields: Omit<QueuedOperation, "resolve" | "reject">): Promise<void> {
    if (this.closed) return Promise.reject(this.stoppedError());
    return new Promise((resolve, reject) => {
      const operation = { ...fields, resolve, reject };
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

  // Suspends readiness so readiness-waiting ops (messages, compact) hold until the
  // next `markReady`. Used on turn start AND on a blocking dialog; implies no turn.
  suspendReadiness(): void {
    this.ready = false;
    this.readinessEpoch += 1;
  }

  close(): void {
    this.closed = true;
    const error = this.stoppedError();
    // Abort the in-flight signal so an exclusive task (login) stops promptly, and
    // reject the still-dispatching op so a pending delayed Enter can't resolve it.
    this.submitAbort?.abort();
    const settling = this.inFlight;
    this.inFlight = undefined;
    this.bypassable = 0;
    if (settling) settling.reject(error);
    for (const operation of this.queue.splice(0)) operation.reject(error);
  }

  private drain(): void {
    if (this.inFlight || this.queue.length === 0) return;
    const index = nextDispatchIndex(this.queue, this.ready, this.bypassable);
    if (index < 0) return;
    const operation = this.queue.splice(index, 1)[0] as QueuedOperation;
    if (overtakesReadiness(operation)) this.bypassable -= 1;
    // Own the queue BEFORE lifecycle work/write so a throwing turn-start listener
    // can't leave a started write ownerless for a follower to interleave (C-API-35).
    this.inFlight = operation;
    const traits = controlOperationTraits[operation.kind];
    // Snapshot readiness + epoch so rollback can restore the prior value (see rollback).
    const priorReady = this.ready;
    const dispatchEpoch = this.readinessEpoch;
    let dispatched: Promise<void>;
    try {
      this.beginSubmission(traits);
      const signal = this.armAbort();
      // Exclusive op runs its interactive task (holds the queue); ordinary op writes once.
      dispatched =
        operation.run?.(signal) ?? this.submit(operation.input, traits.submitMode, signal);
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

  // Restore readiness on a failed submission (no turn started, so no Stop comes) —
  // but ONLY if no lifecycle transition bumped the epoch since dispatch, so a stale
  // snapshot never clobbers a newer markReady/suspend (C-API-35/37).
  private rollbackSubmission(
    operation: QueuedOperation,
    priorReady: boolean,
    dispatchEpoch: number,
    error: Error,
  ): void {
    if (!this.closed && this.readinessEpoch === dispatchEpoch) this.ready = priorReady;
    this.settleInFlight(operation, () => operation.reject(error));
  }

  private settleInFlight(operation: QueuedOperation, settle: () => void): void {
    if (this.inFlight !== operation) return; // close() may have already settled it
    this.inFlight = undefined;
    settle();
    this.drain();
  }

  // Consume-readiness / report-turn lifecycle runs BEFORE the write, so a throwing
  // status listener aborts with nothing in flight yet.
  private beginSubmission(traits: ControlOperationTraits): void {
    if (traits.consumesReadiness) this.ready = false;
    if (traits.reportsCallerSubmission) this.onTurnStarted();
  }

  // Fresh signal per submission; aborting the PRIOR one halts its background nudges.
  private armAbort(): AbortSignal {
    this.submitAbort?.abort();
    this.submitAbort = new AbortController();
    return this.submitAbort.signal;
  }
}
