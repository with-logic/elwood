/** Contains hook notifications without changing wire decisions or lifecycle (C-HOOK-22). */
import {
  activityFromWarning,
  type ElwoodActivityEvent,
  type ElwoodAgentKind,
} from "./activity/index.ts";
import type { HookObserverFailedWarning, ObserverFailureWarning } from "./warnings/lifecycle.ts";

type Phase = HookObserverFailedWarning["phase"];
type ObservationEmitter = {
  observeErrors<T>(onError: (error: unknown) => void, operation: () => T): T;
  observeRejections<T>(onError: (error: unknown) => void, operation: () => T): T;
  emit(event: "warning", payload: ObserverFailureWarning): void;
  emit(event: "activity", payload: ElwoodActivityEvent): void;
};

export function hookObservationBoundary(
  emitter: ObservationEmitter,
  elwoodSessionId: string,
  agent: ElwoodAgentKind,
) {
  return observationBoundary(emitter, elwoodSessionId, agent, false);
}

export type HookObservation = ReturnType<typeof hookObservationBoundary>;

/** Standalone readiness is a lifecycle transition, not a hook invocation. */
export function initialReadyObservationBoundary(
  emitter: ObservationEmitter,
  elwoodSessionId: string,
) {
  return observationBoundary(emitter, elwoodSessionId, "codex", true);
}

function observationBoundary(
  emitter: ObservationEmitter,
  elwoodSessionId: string,
  agent: ElwoodAgentKind,
  initialReady: boolean,
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
    runRejections(phase: Phase, operation: () => void): void {
      emitter.observeRejections(() => fail(phase), operation);
    },
    report(): void {
      finished = true;
      if (failedPhase === undefined || reported) return;
      reported = true;
      const warning: ObserverFailureWarning = initialReady
        ? Object.freeze({
            elwoodSessionId,
            agent: "codex" as const,
            source: "lifecycle" as const,
            code: "initial_ready_observer_failed" as const,
            severity: "warning" as const,
            message: "A Codex initial-ready notification failed; readiness was preserved.",
            phase: "lifecycle" as const,
            raw: "initial_ready_observer_failed phase=lifecycle",
          })
        : Object.freeze({
            elwoodSessionId,
            agent,
            source: "lifecycle" as const,
            code: "hook_observer_failed" as const,
            severity: "warning" as const,
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
