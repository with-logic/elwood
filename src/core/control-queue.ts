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

// Writes an op to the terminal; resolves only once the submission (incl. any delayed
// Enter) has dispatched, so the next op never drains into a half-written composer.
// `signal` aborts on the NEXT op / on close (stops prior recovery nudges).
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
  // EXCLUSIVE op (e.g. `login`): runs a task holding the queue for its whole duration (input unused).
  readonly run?: ExclusiveTask;
  readonly resolve: () => void;
  readonly reject: (error: Error) => void;
};

/** Runs an exclusive interactive task; aborted when the session closes. */
export type ExclusiveTask = (signal: AbortSignal) => Promise<void>;

/** Drops a still-queued op when `signal` aborts, rejecting it with `error()`. */
type Cancel = { readonly signal: AbortSignal; readonly error: () => Error };

export class ControlQueue {
  private readonly queue: QueuedOperation[] = [];
  private readonly submit: ControlSubmitter;
  private readonly stoppedError: ControlQueueError;
  private readonly onTurnStarted: () => void;
  private readonly guidanceMayBypass: () => boolean;
  private ready = false;
  private everReady = false;
  private closed = false;
  // Monotonic readiness version; rollback restores its snapshot only if the epoch is unchanged.
  private readinessEpoch = 0;
  // Count of ops that can dispatch while not ready; lets `drain` skip the overtaker scan (amortized O(1)).
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
    // Freeze bypass eligibility: guidance bypasses only if past initial readiness AND mid-turn (C-API-37).
    const mayBypassReadiness =
      controlOperationTraits[kind].readiness === "running_after_ready" &&
      this.everReady &&
      this.guidanceMayBypass();
    return this.enqueue({ input, kind, mayBypassReadiness });
  }

  // Run a task holding EXCLUSIVE queue ownership for its whole duration (C-API-43
  // login), abort-on-close. `cancel` drops+rejects it if aborted while STILL QUEUED
  // (its deadline elapsing behind other work), so the timeout covers queue-wait too.
  runExclusive(kind: ControlOperationKind, run: ExclusiveTask, cancel?: Cancel): Promise<void> {
    return this.enqueue({ input: "", kind, mayBypassReadiness: false, run }, cancel);
  }

  private dropQueued(operation: QueuedOperation, error: Error): void {
    const index = this.queue.indexOf(operation);
    if (index < 0) return; // already dispatched (in flight) — its own signal handles it
    this.queue.splice(index, 1);
    this.bypassable -= 1; // cancel-able ops (exclusive login) have `always` readiness → always counted
    operation.reject(error);
  }

  private enqueue(op: Omit<QueuedOperation, "resolve" | "reject">, cancel?: Cancel): Promise<void> {
    if (this.closed) return Promise.reject(this.stoppedError());
    return new Promise((resolve, reject) => {
      const operation = { ...op, resolve, reject };
      this.queue.push(operation);
      if (overtakesReadiness(operation)) this.bypassable += 1;
      if (cancel) {
        const drop = () => this.dropQueued(operation, cancel.error());
        cancel.signal.addEventListener("abort", drop, { once: true });
      }
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

  // Suspend readiness so waiting ops (messages, compact) hold until the next `markReady`.
  suspendReadiness(): void {
    this.ready = false;
    this.readinessEpoch += 1;
  }

  close(): void {
    this.closed = true;
    const error = this.stoppedError();
    // Abort the in-flight signal (login stops promptly) and reject the still-dispatching op.
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
    // Own the queue BEFORE lifecycle work/write so a throwing listener can't leave a write ownerless (C-API-35).
    this.inFlight = operation;
    const traits = controlOperationTraits[operation.kind];
    const priorReady = this.ready;
    const dispatchEpoch = this.readinessEpoch;
    let dispatched: Promise<void>;
    try {
      this.beginSubmission(traits);
      const signal = this.armAbort();
      dispatched =
        operation.run?.(signal) ?? this.submit(operation.input, traits.submitMode, signal);
    } catch (error) {
      this.rollbackSubmission(operation, priorReady, dispatchEpoch, toError(error));
      return;
    }
    // The write holds the next drain so ops never interleave; no-op if close() settled it.
    dispatched.then(
      () => this.settleInFlight(operation, () => operation.resolve()),
      (e: unknown) => this.rollbackSubmission(operation, priorReady, dispatchEpoch, toError(e)),
    );
  }

  // Restore readiness on a failed submission, ONLY if no lifecycle transition bumped the epoch since dispatch (C-API-35/37).
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

  // Consume-readiness / report-turn lifecycle runs BEFORE the write (a throwing status listener aborts with nothing in flight).
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
