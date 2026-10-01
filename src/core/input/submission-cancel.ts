/** Private awaited ergonomic input cancellation, without public SendOptions fields (PRD §5.3/§5.8). */
import type { ControlSendOptions } from "../control-queue/index.ts";
import type { SendOptions } from "../images/types.ts";

const awaitedControls = new WeakMap<SendOptions, ControlSendOptions>();

export function cancellableSubmission(
  options: SendOptions | undefined,
  signal: AbortSignal,
  onSubmitted?: () => void,
): SendOptions {
  const submissionOptions = { ...options };
  awaitedControls.set(submissionOptions, {
    origin: { kind: "caller", awaitInputConsumption: true },
    settleAfterWrite: true,
    ...(onSubmitted ? { onSubmitted } : {}),
    cancel: {
      signal,
      error: () =>
        signal.reason instanceof Error ? signal.reason : new Error("Turn input cancelled."),
    },
  });
  return submissionOptions;
}

export function submissionControlOptions(options?: SendOptions): ControlSendOptions {
  return (options && awaitedControls.get(options)) ?? {};
}
