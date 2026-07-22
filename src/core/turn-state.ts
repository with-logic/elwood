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

  /** Watching starts only after initial readiness so startup spinners that
   * borrow the same wording (Codex MCP boot) cannot fabricate turns. */
  arm(): void {
    this.armed = true;
  }

  /** Resume-mode arming (C-API-28's composer-marked readiness): a resumed CLI
   * marks ready on its FIRST composer frame, but the transcript replay that
   * follows repaints prior turns — including footer lines the fact tables
   * read as `working_visible`. Those flashes are history, not work: emitting
   * a started/ended pair for them fabricates a phantom turn on EVERY resume
   * (observed as one false unread per resumed Codex conversation downstream).
   * So a resume arms in a settling state that swallows rendered turn edges
   * until the first QUIET composer frame (composer visible, no working
   * marker) — the replay has finished painting and the screen is genuinely
   * idle; detection then behaves exactly like a cold start's post-ready
   * watcher. Evidence-based turns (`caller_submitted`, hooks) are unaffected
   * throughout. */
  armForResume(): void {
    this.armed = true;
    this.replaySettling = true;
  }

  /** Consumes facts already classified from the frame (see observeRenderedFrame). */
  observe(facts: ScreenFacts): TurnEdge | undefined {
    if (!this.armed) return undefined;
    if (this.replaySettling) {
      if (facts.composer_visible && !facts.working_visible) {
        this.replaySettling = false; // replay settled — watch normally from here
      }
      return undefined;
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
