/** Serialized adapter controls with readiness semantics (PRD §5.3/§5.9). */

import { runContained } from "../contained.ts";
import { toError } from "../errors.ts";
import { outsideStopInput } from "../stop-input.ts";
import { ControlQueueState } from "./state.ts";
import { notifySubmissionStart, submitControl } from "./submission.ts";
import {
  type ControlOperationKind,
  type ControlOperationTraits,
  type ControlQueueError,
  controlOperationTraits,
  overtakesReadiness,
} from "./traits.ts";
import type {
  AbortableQueueTask,
  AdmissionWrapper,
  AdmitOperation,
  Cancel,
  ControlSendOptions,
  ControlSubmissionOrigin,
  ControlSubmitter,
  QueuedOperation,
} from "./types.ts";

export type {
  ControlOperationKind,
  ControlOperationTraits,
  ControlQueueError,
  ControlSubmitMode,
  ReadinessPolicy,
} from "./traits.ts";
export { controlOperationTraits } from "./traits.ts";
export type {
  AbortableQueueTask,
  Cancel,
  ControlSendOptions,
  ControlSubmissionOrigin,
  ControlSubmitter,
} from "./types.ts";

const callerOrigin: ControlSubmissionOrigin = { kind: "caller" };

export class ControlQueue extends ControlQueueState {
  private readonly submit: ControlSubmitter;
  private readonly onTurnStarted: (origin: ControlSubmissionOrigin) => void;
  private readonly guidanceMayBypass: () => boolean;
  private readonly onCallerInputSubmitted: (() => void) | undefined;
  private readonly aroundOperation: AdmissionWrapper | undefined;

  constructor(
    submit: ControlSubmitter,
    stoppedError: ControlQueueError,
    onTurnStarted: (origin: ControlSubmissionOrigin) => void,
    guidanceMayBypass: () => boolean = () => false,
    onCallerInputSubmitted?: () => void,
    aroundOperation?: AdmissionWrapper,
    admit?: AdmitOperation,
  ) {
    super(stoppedError, admit);
    this.submit = submit;
    this.aroundOperation = aroundOperation;
    this.onTurnStarted = onTurnStarted;
    this.guidanceMayBypass = guidanceMayBypass;
    this.onCallerInputSubmitted = onCallerInputSubmitted;
  }

  send(
    input: string,
    kind: ControlOperationKind,
    attach?: AbortableQueueTask,
    options: ControlSendOptions = {},
  ): Promise<void> {
    const mayBypassReadiness =
      controlOperationTraits[kind].readiness === "running_after_ready" &&
      this.everReady &&
      this.guidanceMayBypass();
    return this.enqueue(
      {
        input,
        kind,
        settleAfterWrite: options.settleAfterWrite === true,
        mayBypassReadiness,
        origin: options.origin ?? callerOrigin,
        ...(options.onSubmitted ? { onSubmitted: options.onSubmitted } : {}),
        ...(attach ? { attach } : {}),
        ...(options.beforeEnter ? { beforeEnter: options.beforeEnter } : {}),
      },
      options.cancel,
    );
  }

  runExclusive(
    kind: ControlOperationKind,
    run: AbortableQueueTask,
    cancel?: Cancel,
  ): Promise<void> {
    return this.enqueue(
      {
        input: "",
        kind,
        settleAfterWrite: false,
        mayBypassReadiness: false,
        origin: callerOrigin,
        run,
      },
      cancel,
    );
  }

  /** Queue work outlives the caller; only caller-registered Promise reactions retain its Stop scope. */
  protected drain(): void {
    outsideStopInput(() => this.dispatchNext());
  }

  private dispatchNext(): void {
    if (this.inFlight || this.queue.length === 0) return;
    const index = this.nextDispatchIndex();
    if (index < 0) return;
    const operation = this.queue[index] as QueuedOperation;
    const state = this.admissions.prepare(operation);
    if (state !== "ready") {
      if (state === "waiting") queueMicrotask(() => this.drain());
      return;
    }
    this.takeQueued(index);
    const around = this.admissions.takeWrapper(operation, this.aroundOperation);
    if (overtakesReadiness(operation)) this.bypassable -= 1;
    this.inFlight = operation;
    const traits = controlOperationTraits[operation.kind];
    const priorReady = this.ready;
    const epoch = this.readinessEpoch;
    let dispatched: Promise<void>;
    try {
      const workSignal = this.armAbort();
      const work = () => {
        if (!operation.attach) this.beginSubmission(operation, traits);
        return operation.run
          ? operation.run(workSignal)
          : submitControl(
              operation,
              traits,
              workSignal,
              this.submit,
              () => this.beginSubmission(operation, traits),
              this.onCallerInputSubmitted,
              this.onTurnStarted,
            );
      };
      dispatched = around ? around(work, this.prepareSignal(workSignal), operation.origin) : work();
    } catch (error) {
      this.rollback(operation, priorReady, epoch, toError(error));
      return;
    }
    dispatched.then(
      () => this.commit(operation, traits),
      (error: unknown) => {
        const cancellation = this.cancellation.errorFor(operation);
        this.rollback(operation, priorReady, epoch, cancellation ?? toError(error));
      },
    );
  }

  private beginSubmission(operation: QueuedOperation, traits: ControlOperationTraits): void {
    if (traits.consumesReadiness) this.setReady(false);
    notifySubmissionStart(operation, traits, this.onTurnStarted);
  }

  private commit(operation: QueuedOperation, traits: ControlOperationTraits): void {
    const error = this.cancellation.errorFor(operation);
    if (error || !traits.reportsCallerSubmission || operation.origin.kind !== "loop") {
      this.settle(operation, () => (error ? operation.reject(error) : operation.resolve()));
      return;
    }
    // Commit before observers can cancel. Let LoopDelivery report fired first,
    // releasing capacity now but retaining ordering through the running notification.
    this.cancellation.remove(operation);
    this.budget.release(operation);
    operation.resolve();
    queueMicrotask(() =>
      this.settle(operation, () => {
        if (!this.closed) runContained(() => this.onTurnStarted(operation.origin));
      }),
    );
  }

  private rollback(
    operation: QueuedOperation,
    priorReady: boolean,
    epoch: number,
    error: Error,
  ): void {
    if (!this.closed && this.readinessEpoch === epoch) this.setReady(priorReady);
    this.settle(operation, () => operation.reject(error));
  }
}
