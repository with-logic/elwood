/**
 * Declines Claude's auto-mode setup offer, a first-party onboarding prompt that would
 * otherwise block an embedded session after a turn, with its own Esc (`Not now`).
 * Implements PRD §5.1 and C-CLAUDE-27.
 */
import { waitForInput } from "../../core/input/abort.ts";
import type { AutomationWriteResult } from "../../core/startup/barrier.ts";
import type { SettledStartupOutcome, StartupWriteCompletion } from "../../core/startup/write.ts";
import type { TrustWriteResult } from "../../core/trust/responder.ts";
import { isClaudeAutoModeOffer, isClaudeAutoModeOfferMenu } from "./offer.ts";

/**
 * Between attempts, and before the first. The offer ignores a choice made less than
 * 500 ms after its first render or after the previous attempt, and every attempt restarts
 * that window, so an Esc sent as soon as the offer paints is ignored.
 */
export const offerDeclineSpacingMs = 750;
/** The most Escapes one appearance gets before the offer is left to the human. */
const maxOfferEscapes = 4;
/**
 * The most no-progress rounds one appearance gets: a withheld or rejected Esc, or a settled
 * frame that cannot be read after the last Esc. Then the offer is left to the human.
 */
const maxOfferDeclineFailures = 3;

/** Writes a decline key only while the settled frame still satisfies `stillValid`. */
export type DeclineWriter = (
  input: string,
  stillValid: (frameText: string) => boolean,
) => TrustWriteResult | Promise<AutomationWriteResult>;

/** Escape, the documented decline of Claude's first-party prompts. */
export const declineKey = "\u001b";

/**
 * At most one decline per appearance of the offer's first menu, whatever its outcome. Never
 * the setup step that `Yes` opens, and never an appearance raw caller input has touched:
 * that one is the human's.
 */
export class ClaudeAutoModeOfferDecliner {
  /**
   * `none` arms the next menu frame, `declining` has a decline in flight, and `spent` means
   * this appearance is finished, declined or left to the human, until a settled frame without
   * the offer arms the next one.
   */
  private appearance: "none" | "declining" | "spent" = "none";
  /**
   * Raw caller input arrived since the last frame without the menu outside an appearance, so
   * it may have reached the offer: Claude can show the menu before Elwood sees it.
   */
  private humanOwned = false;
  /** Escapes this appearance has written. A withheld one never reached the PTY. */
  private escapes = 0;
  /**
   * A settled frame showed the menu gone after an Esc, before any caller input, and no later
   * settled frame showed it back.
   */
  private dismissed = false;
  private readonly signal: AbortSignal;
  private readonly spacingMs: number;
  constructor(signal: AbortSignal, spacingMs = offerDeclineSpacingMs) {
    this.signal = signal;
    this.spacingMs = spacingMs;
  }

  /**
   * Raw caller input reached the session, so it may have reached the offer: the current or
   * coming appearance is the human's. Only a frame without the menu, outside an appearance,
   * clears that. A dismissal a settled frame already showed still wins (`check`), since that
   * input went to what replaced the offer.
   */
  callerInput(): void {
    this.humanOwned = true;
  }

  /** Starts declining when `frameText` first shows the offer's menu. */
  handle(
    frameText: string,
    write: DeclineWriter,
    readSettled: () => string | undefined,
  ): SettledStartupOutcome<"claude"> | undefined {
    if (this.appearance === "declining") this.noteFrame(readSettled());
    if (!isClaudeAutoModeOfferMenu(frameText)) {
      // A partial repaint, or the setup step `Yes` opens, drops the menu while the offer
      // stays up, so only a settled frame without any of the offer ends an appearance.
      const settled = this.appearance === "spent" ? readSettled() : undefined;
      if (settled !== undefined && !isClaudeAutoModeOffer(settled)) this.appearance = "none";
      // Input before a frame without the menu went to what that frame shows.
      if (this.appearance === "none") this.humanOwned = false;
      return undefined;
    }
    if (this.appearance !== "none" || this.signal.aborted) return undefined;
    this.appearance = "declining";
    this.escapes = 0;
    this.dismissed = false;
    const settled = this.decline(write, readSettled);
    // Failed writes are retried inside the decline, so no outcome reopens this appearance.
    const spend = () => {
      this.appearance = "spent";
    };
    settled.then(spend, spend);
    return { outcome: { kind: "attempted", prompt: "auto_mode_setup", input: "esc" }, settled };
  }

  /**
   * Checked on the settled frame just before each Esc goes out, after the writer's wait for
   * settlement: raw caller input during that wait hands the offer to the human, so the Esc
   * is withheld. Nothing clears `humanOwned` until the appearance is over.
   */
  private readonly stillDeclinable = (frameText: string): boolean =>
    !this.humanOwned && isClaudeAutoModeOfferMenu(frameText);

  /**
   * Tracks Elwood's dismissal on every settled frame while declining, so caller input during
   * the rest of the spacing wait cannot take a decline that has already landed. The menu gone
   * after an Esc and before caller input shows it; the menu back undoes one seen mid-repaint.
   * An unreadable frame shows nothing either way.
   */
  private noteFrame(settledFrame: string | undefined): void {
    if (settledFrame === undefined) return;
    if (isClaudeAutoModeOfferMenu(settledFrame)) this.dismissed = false;
    else if (this.escapes > 0 && !this.humanOwned) this.dismissed = true;
  }

  /**
   * `answered` only once a settled frame shows the menu gone after an Esc went out. A decline
   * that runs out of Escapes or failures reports nothing: the session stays `blocked` on the
   * offer's attention label, which leaves it to the human (§5.1). When one of its failures was
   * a rejected write, that error is its outcome, so a write-failure warning reports it.
   */
  private async decline(
    write: DeclineWriter,
    readSettled: () => string | undefined,
  ): Promise<StartupWriteCompletion> {
    let failures = 0;
    // Kept once seen: a rejected write is one of the failures that end the decline, so it
    // stays the outcome even if a later Esc goes out.
    let rejection: { readonly error: unknown } | undefined;
    try {
      for (;;) {
        await waitForInput(this.spacingMs, this.signal);
        const ended = this.check(readSettled());
        if (ended) return ended;
        // Giving up comes after the check, so a dismissal seen during the last attempt wins.
        if (failures === maxOfferDeclineFailures) {
          if (rejection) throw rejection.error;
          return "cancelled";
        }
        if (this.escapes < maxOfferEscapes) {
          const escapeResult = await this.escape(write);
          if (escapeResult === "written") continue;
          if (escapeResult !== "withheld") rejection = escapeResult;
        }
        // No progress: a withheld or rejected Esc, or an unreadable frame after the last Esc.
        failures++;
      }
    } catch (error) {
      if (this.signal.aborted) return "cancelled";
      throw error;
    }
  }

  /** How the decline ends at this check, or undefined to attempt again. */
  private check(frame: string | undefined): StartupWriteCompletion | undefined {
    this.noteFrame(frame);
    // A seen dismissal wins over caller input, an unreadable frame and exhaustion.
    if (this.dismissed) return "answered";
    if (this.humanOwned) return "cancelled";
    if (frame === undefined) return undefined;
    // A menu gone before any Esc went out is not Elwood's dismissal.
    if (!isClaudeAutoModeOfferMenu(frame)) return "cancelled";
    return this.escapes === maxOfferEscapes ? "cancelled" : undefined;
  }

  /** One Esc: written, withheld (it never reached the PTY, so it spends no Escape), or rejected. */
  private async escape(
    write: DeclineWriter,
  ): Promise<"written" | "withheld" | { readonly error: unknown }> {
    try {
      if ((await write(declineKey, this.stillDeclinable)) === "withheld") return "withheld";
      this.escapes++;
      return "written";
    } catch (error) {
      return { error };
    }
  }
}
