/** Queue lifecycle and cancellation bookkeeping (PRD §5.3/§5.9). */

import { toError } from "../errors.ts";
import { QueueScanCursor } from "./scan.ts";
import type { ControlQueueError } from "./traits.ts";
import { ControlCancellation, overtakesReadiness } from "./traits.ts";
import type { Cancel, PendingOperation, QueuedOperation } from "./types.ts";

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
  private readonly loopHolds = new Set<object>();
  protected readonly scan = new QueueScanCursor();

  protected constructor(stoppedError: ControlQueueError) {
    this.stoppedError = stoppedError;
  }

  /** Keep due loops behind the ergonomic owner without blocking its own recovery. */
  holdLoops(): () => void {
    const hold = {};
    this.loopHolds.add(hold);
    this.scan.reset();
    return () => {
      if (this.loopHolds.delete(hold)) {
        this.scan.reset();
        this.drain();
      }
    };
  }

  protected nextDispatchIndex(): number {
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
        settling.reject(error);
      }
    }
    this.submitAbort?.abort(error);
    this.bypassable = 0;
    for (const operation of this.queue.splice(0)) {
      this.cancellation.remove(operation);
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
      this.takeQueued(index);
      if (overtakesReadiness(operation)) this.bypassable -= 1;
      this.cancellation.remove(operation);
      operation.reject(error);
    } else if (operation.run) this.preparationAbort?.abort(error);
    else {
      // Settled operations have no listener; an operation absent from the queue is active.
      this.cancellation.mark(operation, error);
      this.submitAbort?.abort(error);
    }
  }
}
