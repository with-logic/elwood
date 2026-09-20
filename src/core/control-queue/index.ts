/** Serialized adapter controls with readiness semantics (PRD §5.3/§5.9). */

import { runContained } from "../contained.ts";
import { toError } from "../errors.ts";
import { ControlQueueState } from "./state.ts";
import {
  type ControlOperationKind,
  type ControlOperationTraits,
  type ControlQueueError,
  controlOperationTraits,
  nextDispatchIndex,
  overtakesReadiness,
} from "./traits.ts";
import type {
  AbortableQueueTask,
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

  constructor(
    submit: ControlSubmitter,
    stoppedError: ControlQueueError,
    onTurnStarted: (origin: ControlSubmissionOrigin) => void,
    guidanceMayBypass: () => boolean = () => false,
    onCallerInputSubmitted?: () => void,
  ) {
    super(stoppedError);
    this.submit = submit;
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
        mayBypassReadiness: false,
        origin: callerOrigin,
        run,
      },
      cancel,
    );
  }

  protected drain(): void {
    if (this.inFlight || this.queue.length === 0) return;
    const index = nextDispatchIndex(this.queue, this.ready, this.bypassable);
    if (index < 0) return;
    const operation = this.queue.splice(index, 1)[0] as QueuedOperation;
    if (overtakesReadiness(operation)) this.bypassable -= 1;
    this.inFlight = operation;
    const traits = controlOperationTraits[operation.kind];
    const priorReady = this.ready;
    const epoch = this.readinessEpoch;
    let dispatched: Promise<void>;
    try {
      const signal = this.armAbort();
      if (!operation.attach) this.beginSubmission(operation, traits);
      dispatched = operation.run
        ? operation.run(signal)
        : this.submitWithAttach(operation, traits, signal);
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
    const mode =
      operation.origin.kind === "caller" && operation.origin.recovery
        ? "recovery_input"
        : traits.submitMode;
    // Recovery publishes its delayed turn start at the same physical boundary.
    const dispatched =
      mode === "recovery_input"
        ? () => this.onTurnStarted(operation.origin)
        : this.onCallerInputSubmitted;
    const onSubmitted =
      dispatched && traits.reportsCallerSubmission && operation.origin.kind === "caller"
        ? () => runContained(dispatched)
        : undefined;
    await this.submit(operation.input, mode, signal, onSubmitted);
  }

  private beginSubmission(operation: QueuedOperation, traits: ControlOperationTraits): void {
    if (traits.consumesReadiness) this.ready = false;
    if (
      traits.reportsCallerSubmission &&
      operation.origin.kind === "caller" &&
      !operation.origin.recovery
    ) {
      runContained(() => this.onTurnStarted(operation.origin));
    }
  }

  private commit(operation: QueuedOperation, traits: ControlOperationTraits): void {
    if (traits.reportsCallerSubmission && operation.origin.kind === "loop") {
      runContained(() => this.onTurnStarted(operation.origin));
    }
    this.settle(operation, () => operation.resolve());
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
