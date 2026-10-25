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
  readonly observeFrameHold: (
    facts: ComposerReadyFacts,
    trustInputBlocking: boolean,
    frame: string,
  ) => void;
  /** Per rendered frame: update the blocking gate, reconcile a deferred or waiting mark,
   * and (on resume) mark readiness on the first quiet, non-blocking composer. */
  readonly observeReadinessFrame: (
    facts: ComposerReadyFacts,
    trustInputBlocking: boolean,
    frame: string,
  ) => void;
};

/**
 * `composerConfigured`, when an adapter supplies it, proves a rendered composer belongs
 * to a configured session rather than to the boot screen (Codex's model footer). The
 * initial deadline then marks only onto such a frame (C-API-28). The latest frame is
 * checked only when a waiting deadline asks, never on every render.
 */
export function createReadinessGate(
  onReady: () => void,
  resumed: boolean,
  composerConfigured?: (frame: string) => boolean,
): ReadinessGate {
  let readinessHeld = false;
  let latest: { facts: ComposerReadyFacts; frame: string } | undefined;
  const observeFrameHold = (
    facts: ComposerReadyFacts,
    trustInputBlocking: boolean,
    frame: string,
  ) => {
    // A dialog's deferred mark waits for idle; ordinary cold-start work still
    // retains the existing hook/deadline path instead of waiting on itself.
    readinessHeld =
      facts.blocking_prompt_visible ||
      trustInputBlocking ||
      (readinessHeld && (facts.working_visible === true || !facts.composer_visible));
    latest = { facts, frame };
  };
  // Work may animate forever (a failing MCP server's retry spinner), so only the
  // configured composer itself, not idleness, is required before the deadline marks.
  const configuredComposerShown =
    composerConfigured &&
    (() =>
      latest?.facts.composer_visible === true &&
      !latest.facts.blocking_prompt_visible &&
      composerConfigured(latest.frame));
  const ready = initialReady(onReady, undefined, () => readinessHeld, configuredComposerShown);
  return {
    ready,
    isHeld: () => readinessHeld,
    observeFrameHold,
    observeReadinessFrame: (facts, trustInputBlocking, frame) => {
      observeFrameHold(facts, trustInputBlocking, frame);
      markReadyOnResumeComposer(ready, resumed, facts, readinessHeld);
      ready.retryWhenReleased(readinessHeld);
    },
  };
}
