/** Queue lifecycle and cancellation bookkeeping (PRD §5.3/§5.9). */

import { toError } from "../errors.ts";
import { ControlAdmissions } from "./admission.ts";
import { AdmissionScan } from "./admission-scan.ts";
import { InputQueueBudget } from "./budget.ts";
import type { ControlQueueError } from "./traits.ts";
import { ControlCancellation, overtakesReadiness } from "./traits.ts";
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
  private readonly budget = new InputQueueBudget();
  private preparationAbort: AbortController | undefined;
  protected readonly cancellation = new ControlCancellation();
  protected readonly stoppedError: ControlQueueError;
  private readonly loopHolds = new Set<object>();
  protected readonly scan = new AdmissionScan();
  protected readonly admissions: ControlAdmissions;

  protected constructor(stoppedError: ControlQueueError, admit?: AdmitOperation) {
    this.stoppedError = stoppedError;
    this.admissions = new ControlAdmissions(
      admit,
      () => {
        this.scan.reset();
        this.drain();
      },
      (operation, error) => this.cancelOperation(operation, error),
    );
  }

  /** Keep due loops behind the ergonomic owner without blocking its own recovery. */
  holdLoops(): () => void {
    const hold = {};
    if (this.ready && this.loopHolds.size === 0) this.scan.reset();
    this.loopHolds.add(hold);
    return () => {
      if (this.loopHolds.delete(hold)) {
        if (this.ready && this.loopHolds.size === 0) this.scan.reset();
        this.drain();
      }
    };
  }

  protected nextDispatchIndex(): number {
    if (this.admissions.size > 0)
      return this.scan.select(this.queue, this.admissions, this.ready, this.loopHolds.size > 0);
    if (this.ready)
      return this.loopHolds.size > 0
        ? this.scan.findIndex(this.queue, (operation) => operation.origin.kind !== "loop")
        : 0;
    return this.bypassable > 0 ? this.scan.findIndex(this.queue, overtakesReadiness) : -1;
  }

  protected setReady(ready: boolean): void {
    if (this.ready !== ready) this.scan.reset();
    this.ready = ready;
  }

  protected takeQueued(index: number): QueuedOperation {
    this.scan.removed(index);
    return this.queue.splice(index, 1)[0] as QueuedOperation;
  }

  markReady(): void {
    if (this.closed) return;
    this.everReady = true;
    this.setReady(true);
    this.readinessEpoch += 1;
    this.drain();
  }

  suspendReadiness(): void {
    this.setReady(false);
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
        this.budget.release(settling);
        settling.reject(error);
      }
    }
    this.submitAbort?.abort(error);
    this.bypassable = 0;
    for (const operation of this.queue.splice(0)) {
      this.budget.release(operation);
      this.admissions.cancel(operation, error);
      this.cancellation.remove(operation);
      operation.reject(error);
    }
  }

  protected enqueue(op: PendingOperation, cancel?: Cancel): Promise<void> {
    if (this.closed) return Promise.reject(this.stoppedError());
    return new Promise((resolve, reject) => {
      const operation: QueuedOperation = { ...op, resolve, reject };
      this.budget.reserve(operation);
      this.queue.push(operation);
      if (overtakesReadiness(operation)) this.bypassable += 1;
      if (cancel) this.listenForCancel(operation, cancel);
      if (!cancel?.signal.aborted) this.drain();
    });
  }

  protected settle(operation: QueuedOperation, finish: () => void): void {
    if (this.inFlight !== operation) return;
    this.inFlight = undefined;
    this.budget.release(operation);
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
      this.takeQueued(index);
      this.budget.release(operation);
      this.admissions.cancel(operation, error);
      if (overtakesReadiness(operation)) this.bypassable -= 1;
      this.cancellation.remove(operation);
      operation.reject(error);
      // Admission may fail synchronously while selecting: never recurse through a backlog.
      queueMicrotask(() => this.drain());
    } else if (operation.run) this.preparationAbort?.abort(error);
    else {
      // Settled operations have no listener; an operation absent from the queue is active.
      this.cancellation.mark(operation, error);
      this.submitAbort?.abort(error);
    }
  }
}
