/** Select the private input mode directly; session binding is tested separately (C-API-56). */
import type { ControlSendOptions, ControlSubmitter } from "../../src/core/control-queue/index.ts";
import type { InputTerminal } from "../../src/core/input/abort.ts";
import { type PasteGuard, queuedInputSubmitter } from "../../src/core/input/index.ts";

/** These fixtures have one replay followed by an ordinary `next` submission. */
export function replayInput(terminal: InputTerminal, guard: PasteGuard): ControlSubmitter {
  const submit = queuedInputSubmitter(terminal, guard);
  return (input, mode, signal, onSubmitted) =>
    submit(input, input === "next" ? mode : "turn_replay_input", signal, onSubmitted);
}

export function replayControl(signal: AbortSignal): ControlSendOptions {
  return {
    settleAfterWrite: true,
    cancel: { signal, error: () => new Error("Turn replay cancelled.") },
  };
}
