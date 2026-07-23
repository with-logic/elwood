/**
 * The one-shot initial-ready transition with an anti-starvation completion boundary,
 * shared by BOTH adapters (PRD §5.3, C-API-42). The status engine commits
 * `current = ready` BEFORE it persists/emits and releases the queue, so a persist or
 * listener throw there would leave the queue suspended AND make a retry a no-op
 * (status is already `ready`). On any throw this releases the queue DIRECTLY and
 * warns, so queued input is never starved by a partially-committed ready transition.
 */

import type { ElwoodAgentKind } from "../core/activity.ts";
import type { ElwoodWarningEvent, InitialReadyFallbackReason } from "../core/types.ts";
import { type SessionRecord, updateSessionStatus } from "../state/store.ts";
import { initialReadyFallbackWarning } from "./initial-ready-fallback.ts";

/** The narrow session surface the initial-ready advance needs. */
export type InitialReadyAdvanceDeps = {
  readonly agent: ElwoodAgentKind;
  readonly elwoodSessionId: string;
  readonly record: SessionRecord;
  readonly submitInitialReady: () => void;
  readonly persist: (record: SessionRecord) => void;
  readonly markReady: () => void;
  readonly recordWarnings: (warnings: readonly ElwoodWarningEvent[]) => void;
};

export function advanceInitialReady(deps: InitialReadyAdvanceDeps): void {
  try {
    deps.submitInitialReady();
  } catch {
    // Classify BEFORE releasing (`markReady` drains to `running`, masking a persist
    // fault), then release unconditionally and warn.
    const reason = classifyFailure(deps);
    deps.markReady();
    try {
      deps.recordWarnings([initialReadyFallbackWarning(deps.agent, deps.elwoodSessionId, reason)]);
    } catch {
      // A warning-sink/listener failure must never block the readiness release.
    }
  }
}

// Re-attempt the durable `ready` write to classify the throw: success ⇒ a lifecycle
// LISTENER threw; throw ⇒ PERSISTENCE failing (disk-first persist left `record` stale).
function classifyFailure(deps: InitialReadyAdvanceDeps): InitialReadyFallbackReason {
  try {
    deps.persist(updateSessionStatus(deps.record, "ready"));
    return "listener";
  } catch {
    return "persist";
  }
}
