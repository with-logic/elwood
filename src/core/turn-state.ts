/**
 * Rendered-TUI turn-state watching driven by adapter screen-fact tables for
 * hook-independent turn boundaries. Frames carry both the viewport text and
 * the OSC window title, so a width-independent title spinner can reveal a
 * turn the elided footer hides.
 * Implements PRD §5.3 and C-TURN-01 through C-TURN-05.
 */

import type { ScreenFacts } from "./screen-facts.ts";

export type TurnEdge = "started" | "ended";

export class TurnStateWatcher {
  private running = false;
  private bannerSeen = false;
  private armed = false;
  private replaySettling = false;

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
        // sync into the running state silently (no "started" edge: the status
        // engine heard the evidence; re-announcing would be a no-op) so this
        // turn's END edge is observed like any other. Do NOT return here: the
        // CURRENT frame may already be the turn's only end edge (a quiet composer
        // or interrupt banner that painted exactly as evidence arrived) — fall
        // through to the end-edge checks so it is not discarded.
        this.replaySettling = false;
        this.running = true;
      } else {
        // Without evidence, settling releases only on the first quiet, non-blocking
        // composer frame — which is not itself an end edge (no turn was running).
        if (facts.composer_visible && !facts.working_visible) this.replaySettling = false;
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
