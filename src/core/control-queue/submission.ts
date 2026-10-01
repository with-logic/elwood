/** Preserve physical evidence separately from initial and replay ergonomic turn notification (PRD §5.3, C-ATTN-02). */
import { runContained } from "../contained.ts";
import { toError } from "../errors.ts";
import type { ControlOperationTraits, ControlSubmitMode } from "./traits.ts";
import type { ControlSubmissionOrigin, ControlSubmitter, QueuedOperation } from "./types.ts";

export function submissionMode(
  operation: QueuedOperation,
  traits: ControlOperationTraits,
): ControlSubmitMode {
  return operation.origin.kind === "caller" && operation.origin.awaitInputConsumption
    ? "awaited_input"
    : traits.submitMode;
}

export function submissionCallback(
  operation: QueuedOperation,
  traits: ControlOperationTraits,
  physicalSubmitted: (() => void) | undefined,
  turnStarted: (origin: ControlSubmissionOrigin) => void,
): (() => void) | undefined {
  const origin = operation.origin;
  if (!traits.reportsCallerSubmission || origin.kind !== "caller") return undefined;
  if (!(physicalSubmitted || origin.awaitInputConsumption || operation.onSubmitted))
    return undefined;
  return () => {
    if (physicalSubmitted) runContained(physicalSubmitted);
    if (operation.onSubmitted) runContained(operation.onSubmitted);
    if (origin.awaitInputConsumption) runContained(() => turnStarted(origin));
  };
}

export function notifySubmissionStart(
  operation: QueuedOperation,
  traits: ControlOperationTraits,
  turnStarted: (origin: ControlSubmissionOrigin) => void,
): void {
  if (
    traits.reportsCallerSubmission &&
    operation.origin.kind === "caller" &&
    !operation.origin.awaitInputConsumption
  )
    runContained(() => turnStarted(operation.origin));
}

/** Attachment completion and physical writes remain outside the caller's Stop scope. */
export async function submitControl(
  operation: QueuedOperation,
  traits: ControlOperationTraits,
  signal: AbortSignal,
  submit: ControlSubmitter,
  beginSubmission: () => void,
  onCallerInputSubmitted: (() => void) | undefined,
  onTurnStarted: (origin: ControlSubmissionOrigin) => void,
): Promise<void> {
  if (operation.attach) {
    await operation.attach(signal);
    if (signal.aborted) throw toError(signal.reason);
    beginSubmission();
  }
  const onSubmitted = submissionCallback(operation, traits, onCallerInputSubmitted, onTurnStarted);
  await submit(
    operation.input,
    submissionMode(operation, traits),
    signal,
    onSubmitted,
    operation.beforeEnter,
  );
}
