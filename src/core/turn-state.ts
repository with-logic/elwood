/**
 * Rendered-TUI turn-state watching for hook-independent turn boundaries.
 * Implements PRD §5.3 and C-TURN-01, C-TURN-02, C-TURN-03.
 */

/**
 * Rendered only while a turn is running. Verified against claude 2.1.201
 * (footer: "... · esc to interrupt · ...") and codex-cli 0.142.5 (spinner:
 * "• Working (3s • esc to interrupt)"), including the Escape-interrupt and
 * normal-completion transitions.
 */
export const turnRunningToken = /esc to interrupt/i;

export type TurnEdge = "started" | "ended";

export class TurnStateWatcher {
  private readonly composerVisible: (text: string) => boolean;
  private running = false;
  private armed = false;

  constructor(composerVisible: (text: string) => boolean) {
    this.composerVisible = composerVisible;
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
    // A screen with neither the working token nor the composer (for example
    // a modal permission dialog) holds state instead of ending the turn.
    if (this.running && !working && this.composerVisible(text)) {
      this.running = false;
      return "ended";
    }
    return undefined;
  }
}
