/** Contains hook notifications without changing wire decisions or lifecycle (C-HOOK-22). */
import {
  activityFromWarning,
  type ElwoodActivityEvent,
  type ElwoodAgentKind,
} from "./activity/index.ts";
import type { HookObserverFailedWarning } from "./warnings/lifecycle.ts";

type Phase = HookObserverFailedWarning["phase"];
type ObservationEmitter = {
  observeErrors<T>(onError: (error: unknown) => void, operation: () => T): T;
  emit(event: "warning", payload: HookObserverFailedWarning): void;
  emit(event: "activity", payload: ElwoodActivityEvent): void;
};

export function hookObservationBoundary(
  emitter: ObservationEmitter,
  elwoodSessionId: string,
  agent: ElwoodAgentKind,
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
        agent,
        source: "lifecycle",
        code: "hook_observer_failed",
        severity: "warning",
        message: `A ${agent === "claude" ? "Claude" : "Codex"} hook notification failed; hook decisions and lifecycle were preserved.`,
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
