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
  type ConfiguredComposerEvidence,
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
    cols?: number,
  ) => void;
  /** Per rendered frame: update the blocking gate, reconcile a deferred or waiting mark,
   * and (on resume) mark readiness on the first non-blocking configured composer. */
  readonly observeReadinessFrame: (
    facts: ComposerReadyFacts,
    trustInputBlocking: boolean,
    frame: string,
    cols?: number,
  ) => void;
};

/**
 * An adapter's `composer.configured`, when supplied, proves a rendered composer belongs
 * to a configured session. The initial deadline then marks only onto such a frame, and
 * the resume composer marks on nothing else: without it, a resume waits for a hook or
 * the deadline (C-API-28). The latest frame is checked only when readiness asks.
 */
export function createReadinessGate(
  onReady: () => void,
  resumed: boolean,
  composer?: {
    readonly configured: (frame: string, cols?: number) => boolean;
    readonly onBackstop: (dialogHeld: boolean) => void;
  },
): ReadinessGate {
  let readinessHeld = false;
  let backstopHold: (() => boolean) | undefined;
  let latest: { facts: ComposerReadyFacts; frame: string; cols: number | undefined } | undefined;
  const observeFrameHold = (
    facts: ComposerReadyFacts,
    trustInputBlocking: boolean,
    frame: string,
    cols?: number,
  ) => {
    // A dialog's deferred mark waits for idle; ordinary cold-start work still
    // retains the existing hook/deadline path instead of waiting on itself.
    readinessHeld =
      facts.blocking_prompt_visible ||
      trustInputBlocking ||
      (readinessHeld && (facts.working_visible === true || !facts.composer_visible));
    latest = { facts, frame, cols };
  };
  // Claude verifies an idle composer. Codex can verify its configured composer
  // during background work such as an MCP server retry.
  let evidence: ConfiguredComposerEvidence | undefined;
  if (composer) {
    const shown = () =>
      latest?.facts.composer_visible === true &&
      !latest.facts.blocking_prompt_visible &&
      composer.configured(latest.frame, latest.cols);
    evidence = {
      shown,
      onBackstop: () => {
        backstopHold = () => !shown();
        composer.onBackstop(readinessHeld);
      },
    };
  }
  // `mark()` is idempotent; this only stops the configured-composer check on every frame
  // after readiness. It latches after `onReady`, so a throwing listener retries (C-API-28).
  let readyFired = false;
  const configured = evidence?.shown ?? (() => false);
  const ready = initialReady(
    () => {
      backstopHold = undefined;
      onReady();
      readyFired = true;
    },
    undefined,
    () => readinessHeld,
    evidence,
  );
  return {
    ready,
    isHeld: () => readinessHeld || backstopHold?.() === true,
    observeFrameHold,
    observeReadinessFrame: (facts, trustInputBlocking, frame, cols) => {
      observeFrameHold(facts, trustInputBlocking, frame, cols);
      if (!readyFired) markReadyOnResumeComposer(ready, resumed, facts, configured, readinessHeld);
      ready.retryWhenReleased(readinessHeld);
    },
  };
}
