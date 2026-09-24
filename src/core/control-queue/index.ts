/** Serialized adapter controls with readiness semantics (PRD §5.3/§5.9). */

import { runContained } from "../contained.ts";
import { toError } from "../errors.ts";
import { ControlQueueState } from "./state.ts";
import {
  type ControlOperationKind,
  type ControlOperationTraits,
  type ControlQueueError,
  controlOperationTraits,
  overtakesReadiness,
} from "./traits.ts";
import type {
  AbortableQueueTask,
  AdmitOperation,
  AroundOperation,
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

  private readonly aroundOperation: AroundOperation | undefined;

  constructor(
    submit: ControlSubmitter,
    stoppedError: ControlQueueError,
    onTurnStarted: (origin: ControlSubmissionOrigin) => void,
    guidanceMayBypass: () => boolean = () => false,
    onCallerInputSubmitted?: () => void,
    aroundOperation?: AroundOperation,
    admitOperation?: AdmitOperation,
  ) {
    super(stoppedError, admitOperation);
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
        ...(attach ? { attach } : {}),
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

  protected drain(): void {
    if (this.inFlight || this.queue.length === 0) return;
    const index = this.nextDispatchIndex();
    if (index < 0) return;
    const operation = this.queue[index] as QueuedOperation;
    if (!this.admissions.prepare(operation)) {
      this.drain();
      return;
    }
    this.queue.splice(index, 1);
    const around = this.admissions.take(operation)?.run ?? this.aroundOperation;
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
          : this.submitWithAttach(operation, traits, workSignal);
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

  private async submitWithAttach(
    operation: QueuedOperation,
    traits: ControlOperationTraits,
    signal: AbortSignal,
  ): Promise<void> {
    if (operation.attach) {
      await operation.attach(signal);
      if (signal.aborted) throw this.abortError(signal);
      this.beginSubmission(operation, traits);
    }
    const dispatched = this.onCallerInputSubmitted;
    const onSubmitted =
      dispatched && traits.reportsCallerSubmission && operation.origin.kind === "caller"
        ? () => runContained(dispatched)
        : undefined;
    await this.submit(operation.input, traits.submitMode, signal, onSubmitted);
  }

  private beginSubmission(operation: QueuedOperation, traits: ControlOperationTraits): void {
    if (traits.consumesReadiness) this.ready = false;
    if (traits.reportsCallerSubmission && operation.origin.kind === "caller") {
      runContained(() => this.onTurnStarted(operation.origin));
    }
  }

  private commit(operation: QueuedOperation, traits: ControlOperationTraits): void {
    const error = this.cancellation.errorFor(operation);
    if (error || !traits.reportsCallerSubmission || operation.origin.kind !== "loop") {
      this.settle(operation, () => (error ? operation.reject(error) : operation.resolve()));
      return;
    }
    // Commit before observers can cancel. Let LoopDelivery report fired first,
    // retaining the queue slot until the running notification has been delivered.
    this.cancellation.remove(operation);
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
    if (!this.closed && this.readinessEpoch === epoch) this.ready = priorReady;
    this.settle(operation, () => operation.reject(error));
  }
}
