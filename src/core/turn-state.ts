/**
 * Rendered-TUI turn-state watching driven by adapter screen-fact tables for
 * hook-independent turn boundaries. Frames carry both the viewport text and
 * the OSC window title, so a width-independent title spinner can reveal a
 * turn the elided footer hides.
 * Implements PRD §5.3 and C-TURN-01 through C-TURN-05.
 */

import type { ScreenFacts } from "./screen-facts.ts";

export type TurnEdge = "started" | "ended";

// Consecutive quiet, non-blocking composer frames required to declare the resume
// transcript replay finished. The replay repaints working footers in bursts with
// brief (1-frame) quiet gaps between them; requiring several quiet frames in a row
// clears those gaps before detection resumes, so a post-replay burst can't fire a
// phantom turn. A real post-resume turn is EVIDENCE-driven and bypasses settling, so
// this only delays RENDERED detection by a few poll frames (C-TURN-03).
const quietFramesToSettle = 5;

export class TurnStateWatcher {
  private running = false;
  private bannerSeen = false;
  private armed = false;
  private replaySettling = false;
  // Consecutive quiet, non-blocking composer frames seen while settling. The resume
  // transcript replay repaints working-token footers in BURSTS with brief quiet gaps
  // between them, so a SINGLE quiet composer frame is not proof the replay finished —
  // releasing on it lets a later burst fire a phantom `started`. Require the composer
  // to stay quiet for `quietFramesToSettle` consecutive frames; any working/blocking
  // frame resets the run to 0 (C-TURN-03, real-Codex resume).
  private quietStreak = 0;

  /**
   * Watching starts only after initial readiness so startup spinners that borrow the
   * same wording (Codex MCP boot) cannot fabricate turns.
   *
   * On RESUME (C-API-28's composer-marked readiness) the CLI marks ready on its FIRST
   * composer frame, but the transcript replay that follows repaints prior turns —
   * including footer lines the fact tables read as `working_visible`. Those flashes are
   * history, not work: emitting a started/ended pair for them fabricates a phantom turn
   * on EVERY resume (observed as one false unread per resumed conversation downstream).
   * So `arm(true)` enters a settling state that swallows rendered turn edges until the
   * first QUIET composer frame (composer visible, no working marker) — the replay has
   * finished painting and the screen is genuinely idle; detection then behaves exactly
   * like a cold start's post-ready watcher. Evidence-based turns (`caller_submitted`,
   * hooks) are unaffected throughout.
   */
  arm(resumed = false): void {
    this.armed = true;
    this.replaySettling = resumed;
    this.quietStreak = 0;
  }

  /** Adopt verified working clearance without consuming a second edge from its frame. */
  adoptWorkingClearance(facts: ScreenFacts): void {
    if (!this.armed) return;
    this.replaySettling = false;
    this.running = true;
    this.bannerSeen = facts.interrupt_complete_visible;
  }

  /** Consumes facts already classified from the frame (see observeRenderedFrame).
   * `evidenceRunning` — the session is running from EVIDENCE (a caller
   * submission or hook), not from rendered detection — also releases
   * settling: a real turn began, so the replay is over by definition, and
   * holding settling through it would swallow that turn's rendered end-edge
   * (a message drained at resume-readiness can start its spinner before any
   * quiet composer frame ever paints). */
  observe(facts: ScreenFacts, evidenceRunning = false): TurnEdge | undefined {
    if (!this.armed) return undefined;
    if (this.replaySettling) {
      if (evidenceRunning) {
        // A real turn is ALREADY running from evidence — release settling and
        // synchronize only to CURRENT rendered work. The stale resume composer
        // can remain painted briefly after caller submission, so it is not an end
        // edge until a working frame has established this turn. An interrupt
        // banner remains a valid immediate end below even without a spinner.
        this.replaySettling = false;
        this.running = facts.working_visible || facts.interrupt_complete_visible;
      } else {
        // Without evidence, settling releases only after the composer stays QUIET and
        // non-blocking for `quietFramesToSettle` consecutive frames — one quiet frame
        // is not enough because the replay repaints working footers in bursts with
        // brief quiet gaps, and releasing on a lone quiet frame lets the next burst
        // fire a phantom `started`. A blocking dialog's option caret is byte-identical
        // to the composer marker, so a blocking frame is NOT quiet and resets the run
        // (matches the end-edge gate, so queued sends never drain into a dialog).
        const quiet =
          facts.composer_visible && !facts.working_visible && !facts.blocking_prompt_visible;
        this.quietStreak = quiet ? this.quietStreak + 1 : 0;
        if (this.quietStreak >= quietFramesToSettle) this.replaySettling = false;
        return undefined;
      }
    }
    if (!this.running && facts.working_visible) {
      this.running = true;
      return "started";
    }
    // The end banner fires the ended edge at any width — including narrow
    // screens where the elided footer means "started" was never observed.
    if (facts.interrupt_complete_visible && !this.bannerSeen) {
      this.bannerSeen = true;
      this.running = false;
      return "ended";
    }
    if (!facts.interrupt_complete_visible) this.bannerSeen = false;
    // A screen with neither the working token nor the composer holds state.
    // A blocking dialog also holds it: Claude's permission dialog renders a
    // "❯ 1. Yes" caret that would otherwise read as the idle composer, and a
    // false ready here would drain queued sends into the dialog.
    if (
      this.running &&
      !facts.working_visible &&
      facts.composer_visible &&
      !facts.blocking_prompt_visible
    ) {
      this.running = false;
      return "ended";
    }
    return undefined;
  }
}
