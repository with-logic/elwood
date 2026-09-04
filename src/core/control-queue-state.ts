/** Queue lifecycle and cancellation bookkeeping (PRD §5.3/§5.9). */

import type { ControlQueueError } from "./control-queue-traits.ts";
import { ControlCancellation, notifyDispatch, overtakesReadiness } from "./control-queue-traits.ts";
import type {
  Cancel,
  ControlDispatchObserver,
  PendingOperation,
  QueuedOperation,
} from "./control-queue-types.ts";
import { toError } from "./errors.ts";

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
  protected readonly cancellation = new ControlCancellation();
  protected readonly stoppedError: ControlQueueError;
  protected readonly onDispatch: ControlDispatchObserver;

  protected constructor(stoppedError: ControlQueueError, onDispatch: ControlDispatchObserver) {
    this.stoppedError = stoppedError;
    this.onDispatch = onDispatch;
  }

  markReady(): void {
    if (this.closed) return;
    this.everReady = this.ready = true;
    this.readinessEpoch += 1;
    this.drain();
  }

  suspendReadiness(): void {
    this.ready = false;
    this.readinessEpoch += 1;
  }

  close(): void {
    this.closed = true;
    const error = this.stoppedError();
    this.submitAbort?.abort(error);
    const settling = this.inFlight;
    this.inFlight = undefined;
    this.bypassable = 0;
    if (settling) {
      this.cancellation.remove(settling);
      settling.reject(error);
    }
    this.cancellation.clear();
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
      this.queue.splice(index, 1);
      if (overtakesReadiness(operation)) this.bypassable -= 1;
      this.cancellation.remove(operation);
      operation.reject(error);
      notifyDispatch(this.onDispatch, operation, "cancelled");
    } else if (this.inFlight === operation && !operation.run) {
      this.cancellation.mark(operation, error);
      this.submitAbort?.abort(error);
    }
  }
}
