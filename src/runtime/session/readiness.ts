/**
 * Bundles a session's initial-readiness wiring so both adapters share one blocking-
 * aware gate. `ready` fires the pre-input hook/deadline readiness; a per-frame
 * `observeReadinessFrame` combines human and automation-owned input gates so readiness never
 * drains the queue INTO a dialog (even one shown during `starting`, which never
 * latched `blocked`) and is never starved BY it — it reconciles once the dialog
 * clears to a positive idle composer — and marks resume-composer readiness.
 * Implements PRD §5.3 (C-API-28).
 */

import type { ComposerReadyFacts } from "../readiness/initial-ready.ts";
import {
  type InitialReady,
  initialReady,
  markReadyOnResumeComposer,
} from "../readiness/initial-ready.ts";

export type ReadinessGate = {
  readonly ready: InitialReady;
  readonly isHeld: () => boolean;
  /** Per rendered frame: update the blocking gate, reconcile a deferred mark, and
   * (on resume) mark readiness on the first quiet, non-blocking composer. */
  readonly observeReadinessFrame: (facts: ComposerReadyFacts, automationBlocking?: boolean) => void;
};

export function createReadinessGate(onReady: () => void, resumed: boolean): ReadinessGate {
  let readinessHeld = false;
  const ready = initialReady(onReady, undefined, () => readinessHeld);
  return {
    ready,
    isHeld: () => readinessHeld,
    observeReadinessFrame: (facts, automationBlocking = false) => {
      // A dialog's deferred mark waits for idle; ordinary cold-start work still
      // retains the existing hook/deadline path instead of waiting on itself.
      readinessHeld =
        facts.blocking_prompt_visible ||
        automationBlocking ||
        (readinessHeld && (facts.working_visible === true || !facts.composer_visible));
      markReadyOnResumeComposer(ready, resumed, facts, readinessHeld);
      ready.retryWhenReleased(readinessHeld); // reconcile only after an idle clearance frame
    },
  };
}
