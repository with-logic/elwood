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
  let finished = false;
  let reported = false;
  function fail(phase: Phase): void {
    failedPhase ??= phase;
    if (finished) boundary.report();
  }
  const boundary = {
    run(phase: Phase, operation: () => void): void {
      try {
        emitter.observeErrors(() => fail(phase), operation);
      } catch {
        fail(phase);
      }
    },
    report(): void {
      finished = true;
      if (failedPhase === undefined || reported) return;
      reported = true;
      const warning: HookObserverFailedWarning = Object.freeze({
        elwoodSessionId,
        agent: "claude",
        source: "lifecycle",
        code: "hook_observer_failed",
        severity: "warning",
        message: "A Claude hook notification failed; hook decisions and lifecycle were preserved.",
        phase: failedPhase,
        raw: `hook_observer_failed phase=${failedPhase}`,
      });
      const activity = activityFromWarning(warning);
      emitter.observeErrors(
        () => {
          /* Diagnostic throws and rejections must not recursively warn. */
        },
        () => {
          emitter.emit("warning", warning);
          emitter.emit("activity", activity);
        },
      );
    },
  };
  return boundary;
}
