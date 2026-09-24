/** Fresh update evidence renews CLI grace without claiming success (PRD §5.4/§5.5). */
import type { StartupActivityEmitter } from "../../core/startup/automation.ts";

export function emitUpdateAttention(
  emitter: StartupActivityEmitter,
  elwoodSessionId: string,
  promptGeneration: number | undefined,
): void {
  if (promptGeneration === undefined) return;
  try {
    emitter.emit("activity", {
      elwoodSessionId,
      agent: "codex",
      source: "terminal",
      kind: "attention",
      label: "codex-update-prompt",
      promptGeneration,
    });
  } catch {
    // A throwing observer cannot interrupt the frame or its new bounded attempt.
  }
}
