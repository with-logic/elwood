/**
 * Tracks ONE appearance of the Codex in-TUI update screen across the frames it is split
 * over, and carries the first-party evidence that appearance has accumulated.
 * Implements PRD §5.5, C-CODEX-12 and C-CODEX-22.
 *
 * Recognition of a single frame lives in `recognition.ts`; this file owns the cross-frame
 * LIFECYCLE built on top of it, and `index.ts` owns the write path.
 */

import {
  appearanceBindingsHold,
  bannerContradictsAppearance,
  type CodexUpdateAppearanceEvidence,
  emptyUpdateEvidence,
  evidenceAllowsContinuation,
  withUpdateFrameEvidence,
} from "./evidence.ts";
import { codexUpdatePromptVisible, hasContinuationShape } from "./recognition.ts";

/** Codex's idle composer marker: a bare `›` row, the frame's own input line. */
const composerRow = /^\s*›\s*$/;
/** Any row that could be part of a live dialog, by either option style. */
const optionRow = /(?:^|[\s›>❯])\d+[.)]\s*\S|^\s*[❯›]\s+(?!\d+[.)]\s)\S/;

/**
 * Whether a frame POSITIVELY shows that no dialog is up any more, which is the only thing
 * that releases a retained input hold.
 *
 * Both naive tests are wrong, in opposite directions (round 3 of #59). "No numbered rows"
 * lets a CURSOR-style human prompt (`❯ Yes, go ahead` / `  No, cancel`) release queued
 * input straight into it, pressing its highlighted action. "Any numbered row blocks" pins
 * the hold open forever on ordinary agent prose that happens to contain `1. First step`.
 *
 * What separates them is POSITION, not shape. Both CLIs replace the composer with a live
 * dialog, so a rendered composer row is proof that nothing below it is awaiting an answer:
 * options ABOVE a live composer are transcript the agent printed, while a dialog owning
 * the screen has no composer under it. So the hold clears exactly when the frame's last
 * meaningful row is the composer — which admits the prose case and still holds for a
 * cursor-only dialog, a numbered dialog, and a half-painted one.
 */
function frameClearsDialog(frameText: string): boolean {
  const rows = frameText.split("\n").filter((row) => row.trim() !== "");
  const last = rows.at(-1);
  if (last === undefined || !composerRow.test(last)) return false;
  // Nothing selectable may sit BELOW the composer; rows above it are transcript.
  return !optionRow.test(last);
}

/**
 * Tracks one appearance of the update screen across the frames it is split over, carrying
 * the first-party evidence it has accumulated so a banner-less continuation frame is
 * checked against what THIS appearance actually showed rather than its own shape alone
 * (C-CODEX-22; see `evidence.ts`).
 *
 * The tracker answers TWO different questions with two different lifetimes, and they fail
 * safe in OPPOSITE directions — which is why they cannot share one boolean (#59 round 2):
 *
 * - `observe`: may Elwood WRITE the skip digit? Scoped to the CURRENT appearance. A
 *   contradicted frame answers NO immediately, because the digit was chosen for a
 *   different dialog, and the appearance ENDS there.
 * - `observeAndHoldInput`: must queued caller/persona input keep being HELD? This OUTLIVES the
 *   appearance. The same contradicted frame answers YES, because a prompt is still on
 *   screen — one Elwood may not answer, but a human still owns. Releasing there would
 *   paste and press Enter into it: the same "advanced without consent" outcome the digit
 *   would have caused, reached by another path.
 *
 * So ending an appearance never releases the hold. Only a POSITIVELY identified clear
 * frame does — see `frameClearsDialog`, which keys on position rather than row shape.
 */
export class CodexUpdatePromptTracker {
  private active = false;
  private generation = 0;
  private evidence: CodexUpdateAppearanceEvidence = emptyUpdateEvidence();
  /** Held while ANY dialog we recognized is still on screen, answerable by us or not. */
  private holdingInput = false;

  /** Identifies the current appearance; it changes whenever the update screen clears or appears. */
  get currentGeneration(): number {
    return this.generation;
  }

  /** True once a LATER appearance replaced `generation`; its own clear is only `generation + 1`. */
  hasLaterAppearance(generation: number): boolean {
    return this.generation > generation + 1;
  }

  /** Whether the update screen itself is currently live, as of the last observed frame. */
  get appearanceLive(): boolean {
    return this.active;
  }

  /**
   * Whether input is held for a dialog that is NOT the update screen — a hold retained
   * after its appearance ended. Blocking is still correct; calling it an update prompt
   * would not be, so this is reported under its own screen-fact rule.
   */
  get holdWithoutAppearance(): boolean {
    return this.holdingInput && !this.active;
  }

  /**
   * OBSERVES `frameText` (advancing the appearance lifecycle, exactly as `observe` does)
   * and returns whether queued input must stay HELD afterwards. Not a pure predicate and
   * not "is a dialog on this frame": the answer includes a hold RETAINED from an earlier
   * frame, which is the whole point. Supplied to the session's `blocking_prompt_visible`
   * fact instead of `observe`, because a frame Elwood must not automate is still a frame a
   * human owns (C-API-56, C-CODEX-22). Call it once per frame.
   */
  observeAndHoldInput(frameText: string): boolean {
    this.observe(frameText);
    return this.holdingInput;
  }

  /** Whether the skip digit may be written for the frame last observed. */
  observe(frameText: string): boolean {
    const firstParty = codexUpdatePromptVisible(frameText);
    // A frame that CONTRADICTS this appearance's captured bindings is a different dialog,
    // however complete it looks. Checking that BEFORE the first-party branch is the whole
    // point: a replacement such as `1. Skip backup` / `2. Update now` is first-party
    // SHAPED, so an early accept on shape alone would let it inherit the running
    // attempt's authorization and take the digit bound to the old `1` (round 1, #59).
    if (this.active && !this.frameAgreesWithAppearance(frameText)) {
      // End the contradicted appearance. A first-party replacement immediately opens its
      // OWN appearance below, so it is still blocking — but on a new generation, with
      // fresh evidence, which strands every predicate captured on the old one.
      this.generation += 1;
      this.active = false;
      this.evidence = emptyUpdateEvidence();
    }
    if (firstParty) {
      // A first-party frame opens the appearance (or continues it) and is the evidence
      // every later frame of that appearance is measured against.
      if (!this.active) {
        this.generation += 1;
        this.evidence = emptyUpdateEvidence();
      }
      this.active = true;
      this.evidence = withUpdateFrameEvidence(this.evidence, frameText, true);
    } else if (this.active && this.continuesCurrentAppearance(frameText)) {
      // A banner-less safe-option repaint of the SAME appearance stays latched, and
      // folds its own rows in so a third frame is checked against all of them.
      this.evidence = withUpdateFrameEvidence(this.evidence, frameText, false);
    } else if (this.active) {
      this.generation += 1;
      this.active = false;
      this.evidence = emptyUpdateEvidence();
    }
    // The hold is INDEPENDENT of automation eligibility. An active appearance always
    // holds. Once held, the hold PERSISTS until a frame POSITIVELY clears it (a bare
    // composer offering nothing selectable) — so the contradicted replacement, a prompt
    // we may not answer but a human still owns, keeps queued input held. Elwood never
    // STARTS a hold for a dialog it did not recognize; it only refuses to drop one it is
    // already carrying while anything answerable is still up (rounds 2 and 3 of #59).
    this.holdingInput = this.active || (this.holdingInput && !frameClearsDialog(frameText));
    return this.active;
  }

  /**
   * Captures the current prompt generation so an async retry cannot enter a later dialog.
   * Retry eligibility uses the SAME agreement check as `observe`, so a frame that
   * contradicts the captured bindings can never authorize a write even in the window
   * before the next `observe` sees it.
   */
  currentFramePredicate(): (frameText: string) => boolean {
    const generation = this.generation;
    return (frameText) =>
      this.active &&
      this.generation === generation &&
      this.frameAgreesWithAppearance(frameText) &&
      (codexUpdatePromptVisible(frameText) || this.continuesCurrentAppearance(frameText));
  }

  /**
   * `true` when the frame AGREES with this appearance: every option number it shows still
   * carries the label the appearance bound it to, so nothing was reassigned. `false` means
   * a captured number came back under a different label. Applies to EVERY frame,
   * first-party or not — a complete-looking update screen that relabels a captured option
   * is a replacement dialog, not a repaint.
   */
  private frameAgreesWithAppearance(frameText: string): boolean {
    // A different VERSION pair is a different appearance even when the options match
    // exactly, so the banner is checked alongside the option bindings (round 2 of #59).
    return (
      appearanceBindingsHold(this.evidence, frameText) &&
      !bannerContradictsAppearance(this.evidence, frameText)
    );
  }

  /**
   * A banner-less frame belongs to the active appearance only when it is safe-option
   * shaped AND consistent with the evidence that appearance has already accumulated.
   */
  private continuesCurrentAppearance(frameText: string): boolean {
    return hasContinuationShape(frameText) && evidenceAllowsContinuation(this.evidence, frameText);
  }
}
