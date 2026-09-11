/**
 * The one-shot initial-ready transition with an anti-starvation completion boundary,
 * shared by BOTH adapters (PRD §5.3, C-API-42). The status engine commits
 * `current = ready` BEFORE it emits and releases the queue, so a lifecycle-listener
 * throw there would leave the queue suspended AND make a retry a no-op (status is
 * already `ready`). On any throw this releases the queue DIRECTLY and surfaces the
 * risk as a typed, content-free `initial_ready_fallback` warning (emitted lifecycle
 * events may be stale), so queued input is never starved by a partially-committed
 * ready transition.
 */

import type { ElwoodAgentKind } from "../../core/activity/index.ts";
import type { ElwoodWarningEvent } from "../../core/types.ts";

/** The narrow session surface the initial-ready advance needs. */
export type InitialReadyAdvanceDeps = {
  readonly agent: ElwoodAgentKind;
  readonly elwoodSessionId: string;
  readonly submitInitialReady: () => void;
  readonly markReady: () => void;
  readonly emitWarnings: (warnings: readonly ElwoodWarningEvent[]) => void;
};

export function advanceInitialReady(deps: InitialReadyAdvanceDeps): void {
  try {
    deps.submitInitialReady();
  } catch {
    // A lifecycle-event LISTENER threw after `current` committed to `ready`; release
    // the queue unconditionally so queued input is never starved, then warn.
    deps.markReady();
    try {
      deps.emitWarnings([fallbackWarning(deps.agent, deps.elwoodSessionId)]);
    } catch {
      // A warning-sink/listener failure must never block the readiness release.
    }
  }
}

/** Live-only and content-free: no raw system message, no listener error text. */
function fallbackWarning(agent: ElwoodAgentKind, elwoodSessionId: string): ElwoodWarningEvent {
  return {
    elwoodSessionId,
    agent,
    source: "lifecycle",
    code: "initial_ready_fallback",
    severity: "warning",
    message:
      "Recording the initial-ready transition failed; released the queue directly, so lifecycle events may be stale.",
    raw: "initial_ready_fallback",
  };
}
