/**
 * Bundles a session's initial-readiness wiring so both adapters share one blocking-
 * aware gate. `ready` fires the pre-input hook/deadline readiness; a per-frame
 * `observeReadinessFrame` feeds it the frame's blocking fact so readiness never
 * drains the queue INTO a dialog (even one shown during `starting`, which never
 * latched `blocked`) and is never starved BY it — it reconciles once the dialog
 * clears — and marks resume-composer readiness. Implements PRD §5.3 (C-API-28).
 */

import type { ComposerReadyFacts } from "../readiness/initial-ready.ts";
import {
  type InitialReady,
  initialReady,
  markReadyOnResumeComposer,
} from "../readiness/initial-ready.ts";

export type ReadinessGate = {
  readonly ready: InitialReady;
  /** Per rendered frame: update the blocking gate, reconcile a deferred mark, and
   * (on resume) mark readiness on the first quiet, non-blocking composer. */
  readonly observeReadinessFrame: (facts: ComposerReadyFacts) => void;
};

export function createReadinessGate(onReady: () => void, resumed: boolean): ReadinessGate {
  let blockingVisible = false;
  const ready = initialReady(onReady, undefined, () => blockingVisible);
  return {
    ready,
    observeReadinessFrame: (facts) => {
      blockingVisible = facts.blocking_prompt_visible;
      markReadyOnResumeComposer(ready, resumed, facts);
      ready.retryWhenUnblocked(blockingVisible); // fire a block-deferred readiness once clear
    },
  };
}
