/**
 * Declines Claude's auto-mode setup offer, a first-party onboarding prompt that would
 * otherwise block an embedded session after a turn, with its own Esc (`Not now`).
 * Implements PRD §5.1 and C-CLAUDE-27.
 */
import type { SettledStartupOutcome } from "../../core/startup/write.ts";
import {
  type DeclineWriter,
  OfferAppearanceDecline,
  type OfferAppearanceState,
  offerDeclineSpacingMs,
} from "./appearance.ts";
import { isClaudeAutoModeOffer, isClaudeAutoModeOfferMenu } from "./offer.ts";

/**
 * At most one decline per appearance of the offer's first menu, whatever its outcome. Never
 * the setup step that `Yes` opens, and never an appearance raw caller input has touched:
 * that one is the human's.
 */
export class ClaudeAutoModeOfferDecliner implements OfferAppearanceState {
  /**
   * `none` arms the next menu frame, a decline is in flight, and `spent` means this
   * appearance is finished, declined or left to the human, until a settled frame without
   * the offer arms the next one.
   */
  private appearance: "none" | OfferAppearanceDecline | "spent" = "none";
  /**
   * Raw caller input arrived since the last frame without the menu outside an appearance, so
   * it may have reached the offer: Claude can show the menu before Elwood sees it.
   */
  private callerOwned = false;
  private readonly signal: AbortSignal;
  private readonly spacingMs: number;
  constructor(signal: AbortSignal, spacingMs = offerDeclineSpacingMs) {
    this.signal = signal;
    this.spacingMs = spacingMs;
  }

  get humanOwned(): boolean {
    return this.callerOwned;
  }

  /**
   * Raw caller input reached the session, so it may have reached the offer: the current or
   * coming appearance is the human's. Only a frame without the menu, outside an appearance,
   * clears that. A dismissal a settled frame already showed still wins, since that input
   * went to what replaced the offer.
   */
  callerInput(): void {
    this.callerOwned = true;
  }

  /** Starts declining when `frameText` first shows the offer's menu. */
  handle(
    frameText: string,
    write: DeclineWriter,
    readSettled: () => string | undefined,
  ): SettledStartupOutcome<"claude"> | undefined {
    if (this.appearance instanceof OfferAppearanceDecline) this.appearance.noteFrame(readSettled());
    if (!isClaudeAutoModeOfferMenu(frameText)) {
      // A partial repaint, or the setup step `Yes` opens, drops the menu while the offer
      // stays up, so only a settled frame without any of the offer ends an appearance.
      const settled = this.appearance === "spent" ? readSettled() : undefined;
      if (settled !== undefined && !isClaudeAutoModeOffer(settled)) this.appearance = "none";
      // Input before a frame without the menu went to what that frame shows.
      if (this.appearance === "none") this.callerOwned = false;
      return undefined;
    }
    if (this.appearance !== "none" || this.signal.aborted) return undefined;
    const decline = new OfferAppearanceDecline(this, write, readSettled, this.spacingMs);
    this.appearance = decline;
    // Failed writes are retried inside the decline, so no outcome reopens this appearance.
    const spend = () => {
      this.appearance = "spent";
    };
    const settled = decline.run(this.signal);
    settled.then(spend, spend);
    return { outcome: { kind: "attempted", prompt: "auto_mode_setup", input: "esc" }, settled };
  }
}
