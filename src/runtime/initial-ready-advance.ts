/**
 * The one-shot initial-ready transition with an anti-starvation completion boundary,
 * shared by BOTH adapters (PRD §5.3, C-API-42). The status engine commits
 * `current = ready` BEFORE it emits and releases the queue, so a lifecycle-listener
 * throw there would leave the queue suspended AND make a retry a no-op (status is
 * already `ready`). On any throw this releases the queue DIRECTLY and warns, so queued
 * input is never starved by a partially-committed ready transition.
 */

import type { ElwoodAgentKind } from "../core/activity.ts";
import type { ElwoodWarningEvent } from "../core/types.ts";
import { initialReadyFallbackWarning } from "./initial-ready-fallback.ts";

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
      deps.emitWarnings([initialReadyFallbackWarning(deps.agent, deps.elwoodSessionId)]);
    } catch {
      // A warning-sink/listener failure must never block the readiness release.
    }
  }
}
