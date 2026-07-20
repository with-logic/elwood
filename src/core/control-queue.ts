/** Serialized adapter controls with readiness semantics (PRD §5.3, C-API-19/37). */

import {
  type ControlOperationKind,
  type ControlOperationTraits,
  type ControlQueueError,
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

import type {
  AbortableQueueTask,
  Cancel,
  ControlSubmitter,
  PendingOperation,
  QueuedOperation,
} from "./control-queue-types.ts";
import { toError } from "./errors.ts";

export type { AbortableQueueTask, ControlSubmitter } from "./control-queue-types.ts";

export class ControlQueue {
  private readonly queue: QueuedOperation[] = [];
  private readonly submit: ControlSubmitter;
  private readonly stoppedError: ControlQueueError;
  private readonly onTurnStarted: () => void;
  private readonly guidanceMayBypass: () => boolean;
  private ready = false;
  private everReady = false;
  private closed = false;
  private readinessEpoch = 0; // monotonic; rollback restores its snapshot only if the epoch is unchanged
  private bypassable = 0; // # ops dispatchable while not ready; lets drain skip the overtaker scan
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

  send(input: string, kind: ControlOperationKind, attach?: AbortableQueueTask): Promise<void> {
    // Freeze bypass eligibility: guidance bypasses only if past initial readiness AND mid-turn (C-API-37).
    const mayBypassReadiness =
      controlOperationTraits[kind].readiness === "running_after_ready" &&
      this.everReady &&
      this.guidanceMayBypass();
    return this.enqueue({ input, kind, mayBypassReadiness, attach });
  }

  // Hold EXCLUSIVE queue ownership for the task's whole run (C-API-43 login);
  // `cancel` drops it if aborted while STILL QUEUED.
  runExclusive(
    kind: ControlOperationKind,
    run: AbortableQueueTask,
    cancel?: Cancel,
  ): Promise<void> {
    return this.enqueue({ input: "", kind, mayBypassReadiness: false, run }, cancel);
  }

  private dropQueued(operation: QueuedOperation, error: Error): void {
    const index = this.queue.indexOf(operation);
    if (index < 0) return; // already dispatched (in flight) — its own signal handles it
    this.queue.splice(index, 1);
    this.bypassable -= 1; // cancel-able ops (exclusive login) have `always` readiness → always counted
    operation.reject(error);
  }

  private enqueue(op: PendingOperation, cancel?: Cancel): Promise<void> {
    if (this.closed) return Promise.reject(this.stoppedError());
    return new Promise((resolve, reject) => {
      const operation = { ...op, resolve, reject } as QueuedOperation;
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
    // Abort the in-flight signal and reject the still-dispatching op.
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
    this.inFlight = operation; // own the queue before lifecycle/write (C-API-35)
    const traits = controlOperationTraits[operation.kind];
    const priorReady = this.ready;
    const dispatchEpoch = this.readinessEpoch;
    let dispatched: Promise<void>;
    try {
      const signal = this.armAbort();
      // An image attach defers its lifecycle to after the attach; others do it now.
      if (!operation.attach) this.beginSubmission(traits);
      dispatched = operation.run
        ? operation.run(signal)
        : this.submitWithAttach(operation, traits, signal);
    } catch (error) {
      this.rollbackSubmission(operation, priorReady, dispatchEpoch, toError(error));
      return;
    }
    // The write holds the next drain so ops never interleave; no-op after close().
    dispatched.then(
      () => this.settleInFlight(operation, () => operation.resolve()),
      (e: unknown) => this.rollbackSubmission(operation, priorReady, dispatchEpoch, toError(e)),
    );
  }

  // Restore readiness on failure, only if no lifecycle transition bumped the epoch since dispatch (C-API-35/37).
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

  // Attach FIRST, then the deferred lifecycle, then the write: deferring past a successful attach avoids wedging (C-API-19/44).
  private async submitWithAttach(
    operation: QueuedOperation,
    traits: ControlOperationTraits,
    signal: AbortSignal,
  ): Promise<void> {
    if (operation.attach) {
      await operation.attach(signal);
      if (signal.aborted) throw this.stoppedError();
      try {
        this.beginSubmission(traits); // readiness consumed before any throw
      } catch {
        // Images are staged; a throwing turn-start listener must not strand them.
      }
    }
    await this.submit(operation.input, traits.submitMode, signal);
  }

  private beginSubmission(traits: ControlOperationTraits): void {
    if (traits.consumesReadiness) this.ready = false; // a throwing listener aborts with nothing in flight
    if (traits.reportsCallerSubmission) this.onTurnStarted();
  }

  private armAbort(): AbortSignal {
    this.submitAbort?.abort();
    this.submitAbort = new AbortController();
    return this.submitAbort.signal;
  }
}
