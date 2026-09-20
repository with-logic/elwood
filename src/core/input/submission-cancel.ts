/** Private cancellation for turn recovery submissions (PRD §5.3/§5.8, C-API-58). */
import type { ControlSendOptions } from "../control-queue/index.ts";
import type { SendOptions } from "../images/types.ts";

// Keep cancellation off the public SendOptions contract: only the turn owner registers it.
const cancellations = new WeakMap<SendOptions, ControlSendOptions>();

export function cancellableSubmission(
  options: SendOptions | undefined,
  signal: AbortSignal,
): SendOptions {
  const replayOptions = { ...options };
  cancellations.set(replayOptions, {
    origin: { kind: "caller", recovery: true },
    cancel: { signal, error: () => new Error("Turn recovery cancelled.") },
  });
  return replayOptions;
}

export function submissionControlOptions(options?: SendOptions): ControlSendOptions {
  return (options && cancellations.get(options)) ?? {};
}
