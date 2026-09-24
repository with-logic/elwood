/** Queue lifecycle and cancellation bookkeeping (PRD §5.3/§5.9). */

import { toError } from "../errors.ts";
import { ControlAdmissions } from "./admission.ts";
import type { ControlQueueError } from "./traits.ts";
import {
  ControlCancellation,
  controlOperationTraits,
  nextDispatchIndex,
  overtakesReadiness,
} from "./traits.ts";
import type { AdmitOperation, Cancel, PendingOperation, QueuedOperation } from "./types.ts";

/** Shared mutable state for the serialized control queue. */
export abstract class ControlQueueState {
  protected readonly queue: QueuedOperation[] = [];
  protected ready = false;
  protected everReady = false;
  protected closed = false;
  protected readinessEpoch = 0;
  protected bypassable = 0;
  protected inFlight: QueuedOperation | undefined;
  protected submitAbort: AbortController | undefined;
  private preparationAbort: AbortController | undefined;
  protected readonly cancellation = new ControlCancellation();
  protected readonly stoppedError: ControlQueueError;
  protected readonly admissions: ControlAdmissions;
  private readonly loopHolds = new Set<object>();
  private blockedThrough = 0;

  protected constructor(stoppedError: ControlQueueError, admit?: AdmitOperation) {
    this.stoppedError = stoppedError;
    this.admissions = new ControlAdmissions(
      admit,
      () => {
        this.blockedThrough = 0;
        this.drain();
      },
      (op, error) => this.cancelOperation(op, error),
    );
  }

  /** Keep due loops behind the ergonomic owner without blocking its own recovery. */
  holdLoops(): () => void {
    const hold = {};
    this.loopHolds.add(hold);
    this.blockedThrough = 0;
    return () => {
      if (this.loopHolds.delete(hold)) {
        this.blockedThrough = 0;
        this.drain();
      }
    };
  }

  protected nextDispatchIndex(): number {
    if (!this.admissions.size)
      return this.ready && this.loopHolds.size > 0
        ? this.queue.findIndex((operation) => operation.origin.kind !== "loop")
        : nextDispatchIndex(this.queue, this.ready, this.bypassable);
    // A parked reservation blocks later turn input, but independent controls may
    // pass it. An admitted loop also keeps its place ahead of a later caller hold.
    // Appending cannot unblock the already scanned prefix. Eligibility changes
    // and removals invalidate it; each blocked append is otherwise checked once.
    let reservedBefore = this.blockedThrough > 0;
    for (let index = this.blockedThrough; index < this.queue.length; index += 1) {
      const operation = this.queue[index] as QueuedOperation;
      const admitted = this.admissions.has(operation);
      reservedBefore ||= admitted;
      if (
        !this.admissions.waiting(operation) &&
        (!reservedBefore ||
          admitted ||
          !controlOperationTraits[operation.kind].reportsCallerSubmission) &&
        (!this.loopHolds.size || operation.origin.kind !== "loop" || admitted) &&
        (this.ready || overtakesReadiness(operation))
      )
        return index;
    }
    this.blockedThrough = this.queue.length;
    return -1;
  }

  markReady(): void {
    if (this.closed) return;
    this.blockedThrough = 0;
    this.everReady = this.ready = true;
    this.readinessEpoch += 1;
    this.drain();
  }

  suspendReadiness(): void {
    this.blockedThrough = 0;
    this.ready = false;
    this.readinessEpoch += 1;
  }

  close(): void {
    this.closed = true;
    this.loopHolds.clear();
    const error = this.stoppedError();
    const settling = this.inFlight;
    this.cancellation.clear();
    if (settling) {
      this.cancellation.remove(settling);
      // Retain inFlight until physical settlement. Close owns the stopped error
      // whether that write later resolves or rejects, overriding prior cancellation.
      if (settling.settleAfterWrite) this.cancellation.mark(settling, error);
      else {
        this.inFlight = undefined;
        settling.reject(error);
      }
    }
    this.submitAbort?.abort(error);
    this.bypassable = 0;
    for (const operation of this.queue.splice(0)) {
      this.cancellation.remove(operation);
      this.admissions.cancel(operation, error);
      operation.reject(error);
    }
  }

  protected enqueue(op: PendingOperation, cancel?: Cancel): Promise<void> {
    if (this.closed) return Promise.reject(this.stoppedError());
    return new Promise((resolve, reject) => {
      const operation: QueuedOperation = { ...op, resolve, reject };
      this.queue.push(operation);
      if (overtakesReadiness(operation)) this.bypassable += 1;
      if (cancel) this.listenForCancel(operation, cancel);
      if (!cancel?.signal.aborted) this.drain();
    });
  }

  protected removeQueued(index: number): void {
    this.blockedThrough = 0;
    this.queue.splice(index, 1);
  }

  protected settle(operation: QueuedOperation, finish: () => void): void {
    if (this.inFlight !== operation) return;
    this.inFlight = undefined;
    this.cancellation.remove(operation);
    finish();
    this.drain();
  }

  protected armAbort(): AbortSignal {
    this.submitAbort?.abort();
    this.submitAbort = new AbortController();
    return this.submitAbort.signal;
  }

  /** Deadlines cancel pre-operation cleanup without revoking an active dialog owner. */
  protected prepareSignal(closed: AbortSignal): AbortSignal {
    this.preparationAbort = new AbortController();
    return AbortSignal.any([closed, this.preparationAbort.signal]);
  }

  protected abortError(signal: AbortSignal): Error {
    return toError(signal.reason);
  }

  protected abstract drain(): void;

  private listenForCancel(operation: QueuedOperation, cancel: Cancel): void {
    this.cancellation.listen(operation, cancel, (error) => this.cancelOperation(operation, error));
  }

  private cancelOperation(operation: QueuedOperation, error: Error): void {
    const index = this.queue.indexOf(operation);
    if (index >= 0) {
      this.removeQueued(index);
      if (overtakesReadiness(operation)) this.bypassable -= 1;
      this.cancellation.remove(operation);
      this.admissions.cancel(operation, error);
      operation.reject(error);
      this.drain();
    } else if (operation.run) this.preparationAbort?.abort(error);
    else {
      // Settled operations have no listener; an operation absent from the queue is active.
      this.cancellation.mark(operation, error);
      this.submitAbort?.abort(error);
    }
  }
}
