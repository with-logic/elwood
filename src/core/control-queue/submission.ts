/** Physical queue submission and caller acknowledgment (PRD §5.3/§5.9). */
import { runContained } from "../contained.ts";
import { toError } from "../errors.ts";
import type { ControlOperationTraits } from "./traits.ts";
import type { ControlSubmitter, QueuedOperation } from "./types.ts";

export async function submitControl(
  operation: QueuedOperation,
  traits: ControlOperationTraits,
  signal: AbortSignal,
  submit: ControlSubmitter,
  beginSubmission: () => void,
  onCallerInputSubmitted: (() => void) | undefined,
): Promise<void> {
  if (operation.attach) {
    await operation.attach(signal);
    if (signal.aborted) throw toError(signal.reason);
    beginSubmission();
  }
  const onSubmitted =
    onCallerInputSubmitted && traits.reportsCallerSubmission && operation.origin.kind === "caller"
      ? () => runContained(onCallerInputSubmitted)
      : undefined;
  await submit(operation.input, traits.submitMode, signal, onSubmitted);
}
