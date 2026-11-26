/**
 * Bundles a session's initial-readiness wiring so both adapters share one blocking-
 * aware gate. `ready` fires the pre-input hook/deadline readiness; a per-frame
 * `observeReadinessFrame` combines human and automation-owned input gates so readiness never
 * drains the queue INTO a dialog (even one shown during `starting`, which never
 * latched `blocked`) and is never starved BY it — it reconciles once the dialog
 * clears to a positive idle composer — and marks resume-composer readiness. Before the
 * first readiness it also holds physical writes until a configured composer is seen; the
 * first readiness, from a hook or otherwise, ends that hold too.
 * Implements PRD §5.3 (C-API-28).
 */

import type { ComposerReadyFacts } from "../readiness/initial-ready.ts";
import {
  type ConfiguredComposerEvidence,
  type InitialReady,
  initialReady,
  markReadyOnResumeComposer,
} from "../readiness/initial-ready.ts";

/** The holds a session applies before its first readiness (C-API-28). */
export type InitialReadinessHold = {
  /** Readiness evidence waits: a dialog, trust, or, after the backstop, no configured composer. */
  readonly holdsReadiness: () => boolean;
  /**
   * A physical write waits: a dialog, trust, or no configured composer seen yet. The
   * session consults it from launch until the first readiness, which an adapter's
   * readiness hook can also bring. Operations that bypass the readiness queue
   * (`sendPrompt`, picker commands, `login`) would otherwise write onto a startup screen
   * before the composer, such as an update offer. The release is one-shot: once any
   * write has seen the configured composer the startup screen is past, so later writes
   * before readiness (the Enter after a paste, picker keys) do not wait for the composer
   * to look idle again.
   */
  readonly holdsWrites: () => boolean;
};

export type ReadinessGate = InitialReadinessHold & {
  readonly ready: InitialReady;
  readonly observeFrameHold: (
    facts: ComposerReadyFacts,
    automationInputBlocking: boolean,
    frame: string,
    cols?: number,
  ) => void;
  /** Per rendered frame: update the blocking gate, reconcile a deferred or waiting mark,
   * and (on resume) mark readiness on the first non-blocking configured composer. */
  readonly observeReadinessFrame: (
    facts: ComposerReadyFacts,
    automationInputBlocking: boolean,
    frame: string,
    cols?: number,
  ) => void;
};

/**
 * An adapter's `composer.configured`, when supplied, proves a rendered composer belongs
 * to a configured session. The initial deadline then marks only onto such a frame, and
 * the resume composer marks on nothing else: without it, a resume waits for a hook or
 * the deadline, and every write before readiness waits for a hook (C-API-28). The
 * latest frame is checked only when readiness or a held write asks.
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
    automationInputBlocking: boolean,
    frame: string,
    cols?: number,
  ) => {
    // A dialog's deferred mark waits for idle; ordinary cold-start work still
    // retains the existing hook/deadline path instead of waiting on itself.
    readinessHeld =
      facts.blocking_prompt_visible ||
      automationInputBlocking ||
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
  let configuredComposerSeen = false;
  const sawConfiguredComposer = () => {
    if (!configuredComposerSeen) configuredComposerSeen = configured();
    return configuredComposerSeen;
  };
  return {
    ready,
    holdsReadiness: () => readinessHeld || backstopHold?.() === true,
    holdsWrites: () => readinessHeld || !sawConfiguredComposer(),
    observeFrameHold,
    observeReadinessFrame: (facts, automationInputBlocking, frame, cols) => {
      observeFrameHold(facts, automationInputBlocking, frame, cols);
      if (!readyFired) markReadyOnResumeComposer(ready, resumed, facts, configured, readinessHeld);
      ready.retryWhenReleased(readinessHeld);
    },
  };
}
