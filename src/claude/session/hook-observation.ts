/** Contains hook notifications without changing wire decisions or lifecycle (C-HOOK-22). */
import { activityFromWarning } from "../../core/activity/index.ts";
import type { ClaudeEventMap } from "../../core/types.ts";
import type { HookObserverFailedWarning } from "../../core/warnings/lifecycle.ts";
import type { TypedEmitter } from "../../events/emitter.ts";

type Phase = HookObserverFailedWarning["phase"];

export function hookObservationBoundary(
  emitter: TypedEmitter<ClaudeEventMap>,
  elwoodSessionId: string,
) {
  let failedPhase: Phase | undefined;
  return {
    run(phase: Phase, operation: () => void): void {
      try {
        operation();
      } catch {
        failedPhase ??= phase;
      }
    },
    report(): void {
      if (failedPhase === undefined) return;
      const warning: HookObserverFailedWarning = {
        elwoodSessionId,
        agent: "claude",
        source: "lifecycle",
        code: "hook_observer_failed",
        severity: "warning",
        message: "A Claude hook notification failed; hook decisions and lifecycle were preserved.",
        phase: failedPhase,
        raw: `hook_observer_failed phase=${failedPhase}`,
      };
      try {
        emitter.emit("warning", warning);
      } catch {
        // Diagnostic listeners must not control the hook response.
      }
      try {
        emitter.emit("activity", activityFromWarning(warning));
      } catch {
        // Do not recurse when the failing observer also receives warnings.
      }
    },
  };
}
