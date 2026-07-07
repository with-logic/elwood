/**
 * Rendered-TUI turn-state watching for hook-independent turn boundaries.
 * Implements PRD §5.3 and C-TURN-01 through C-TURN-04.
 */

/**
 * Rendered only while a turn is running. Verified against claude 2.1.201
 * (footer: "... · esc to interrupt · ...") and codex-cli 0.142.5 (spinner:
 * "• Working (3s • esc to interrupt)"). Claude elides this token below
 * roughly 66 columns, so narrow interrupts are detected by the end banner.
 */
export const turnRunningToken = /esc to interrupt/i;

/**
 * Interrupt end banners, captured at 46 and 100 columns: Claude renders
 * "⎿  Interrupted· What should Claude do" (claude 2.1.201; the ⎿ chrome
 * prefix keeps model output from matching) and Codex renders
 * "■ Conversation interrupted" (codex-cli 0.142.5).
 */
export const claudeInterruptBanner = /⎿\s*Interrupted/;
export const codexInterruptBanner = /Conversation interrupted/;

export type TurnEdge = "started" | "ended";

export class TurnStateWatcher {
  private readonly composerVisible: (text: string) => boolean;
  private readonly endBanner: RegExp;
  private running = false;
  private bannerSeen = false;
  private armed = false;

  constructor(composerVisible: (text: string) => boolean, endBanner: RegExp) {
    this.composerVisible = composerVisible;
    this.endBanner = endBanner;
  }

  /** Watching starts only after initial readiness so startup spinners that
   * borrow the same wording (Codex MCP boot) cannot fabricate turns. */
  arm(): void {
    this.armed = true;
  }

  observe(text: string): TurnEdge | undefined {
    if (!this.armed) return undefined;
    const working = turnRunningToken.test(text);
    if (!this.running && working) {
      this.running = true;
      return "started";
    }
    // The end banner fires the ended edge at any width — including narrow
    // screens where the elided footer means "started" was never observed.
    const banner = this.endBanner.test(text);
    if (banner && !this.bannerSeen) {
      this.bannerSeen = true;
      this.running = false;
      return "ended";
    }
    if (!banner) this.bannerSeen = false;
    // A screen with neither the working token nor the composer (for example
    // a modal permission dialog) holds state instead of ending the turn.
    if (this.running && !working && this.composerVisible(text)) {
      this.running = false;
      return "ended";
    }
    return undefined;
  }
}
