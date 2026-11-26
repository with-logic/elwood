/**
 * One appearance's decline of Claude's auto-mode setup offer: Escapes spaced past the offer's
 * input guard, each verified on a settled frame, until one shows the menu gone or the decline
 * runs out of Escapes or failures. Implements PRD §5.1 and C-CLAUDE-27.
 */
import { waitForInput } from "../../core/input/abort.ts";
import type { AutomationWriteResult } from "../../core/startup/barrier.ts";
import type { StartupWriteCompletion } from "../../core/startup/write.ts";
import type { TrustWriteResult } from "../../core/trust/responder.ts";
import { isClaudeAutoModeOfferMenu } from "./offer.ts";

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

/** What the decline reads at each check from the decliner that owns the appearance. */
export type OfferAppearanceState = {
  /** Raw caller input may have reached the offer, so this appearance is the human's. */
  readonly humanOwned: boolean;
};

export class OfferAppearanceDecline {
  /** Escapes this appearance has written. A withheld one never reached the PTY. */
  private escapes = 0;
  /**
   * A settled frame showed the menu gone after an Esc, before any caller input, and no later
   * settled frame showed it back.
   */
  private dismissed = false;
  private readonly state: OfferAppearanceState;
  private readonly write: DeclineWriter;
  private readonly readSettled: () => string | undefined;
  private readonly spacingMs: number;
  constructor(
    state: OfferAppearanceState,
    write: DeclineWriter,
    readSettled: () => string | undefined,
    spacingMs: number,
  ) {
    this.state = state;
    this.write = write;
    this.readSettled = readSettled;
    this.spacingMs = spacingMs;
  }

  /**
   * Checked on the settled frame just before each Esc goes out, after the writer's wait for
   * settlement: raw caller input during that wait hands the offer to the human, so the Esc
   * is withheld. Nothing clears `humanOwned` until the appearance is over.
   */
  private readonly stillDeclinable = (frameText: string): boolean =>
    !this.state.humanOwned && isClaudeAutoModeOfferMenu(frameText);

  /**
   * Tracks Elwood's dismissal on every settled frame, so caller input during the rest of the
   * spacing wait cannot take a decline that has already landed. The menu gone after an Esc
   * and before caller input shows it; the menu back undoes one seen mid-repaint. An
   * unreadable frame shows nothing either way.
   */
  noteFrame(settledFrame: string | undefined): void {
    if (settledFrame === undefined) return;
    if (isClaudeAutoModeOfferMenu(settledFrame)) this.dismissed = false;
    else if (this.escapes > 0 && !this.state.humanOwned) this.dismissed = true;
  }

  /**
   * `answered` only once a settled frame shows the menu gone after an Esc went out. A decline
   * that runs out of Escapes or failures reports nothing: the session stays `blocked` on the
   * offer's attention label, which leaves it to the human (§5.1). When one of its failures was
   * a rejected write, that error is its outcome, so a write-failure warning reports it. The
   * session's close cancels it.
   */
  async run(lifetime: AbortSignal): Promise<StartupWriteCompletion> {
    try {
      return await this.attempt(lifetime);
    } catch (error) {
      if (lifetime.aborted) return "cancelled";
      throw error;
    }
  }

  private async attempt(signal: AbortSignal): Promise<StartupWriteCompletion> {
    let failures = 0;
    // Kept once seen: a rejected write is one of the failures that end the decline, so it
    // stays the outcome even if a later Esc goes out.
    let rejection: { readonly error: unknown } | undefined;
    for (;;) {
      await waitForInput(this.spacingMs, signal);
      const ended = this.check(this.readSettled());
      if (ended) return ended;
      // Giving up comes after the check, so a dismissal seen during the last attempt wins.
      if (failures === maxOfferDeclineFailures) {
        if (rejection) throw rejection.error;
        return "cancelled";
      }
      if (this.escapes < maxOfferEscapes) {
        const result = await this.escape();
        if (result === "written") continue;
        if (result !== "withheld") rejection = result;
      }
      // No progress: a withheld or rejected Esc, or an unreadable frame after the last Esc.
      failures++;
    }
  }

  /** How the decline ends at this check, or undefined to attempt again. */
  private check(frame: string | undefined): StartupWriteCompletion | undefined {
    this.noteFrame(frame);
    // A seen dismissal wins over caller input, an unreadable frame and exhaustion.
    if (this.dismissed) return "answered";
    if (this.state.humanOwned) return "cancelled";
    if (frame === undefined) return undefined;
    // A menu gone before any Esc went out is not Elwood's dismissal.
    if (!isClaudeAutoModeOfferMenu(frame)) return "cancelled";
    return this.escapes === maxOfferEscapes ? "cancelled" : undefined;
  }

  /** One Esc: written, withheld (it never reached the PTY, so it spends no Escape), or rejected. */
  private async escape(): Promise<"written" | "withheld" | { readonly error: unknown }> {
    try {
      if ((await this.write(declineKey, this.stillDeclinable)) === "withheld") return "withheld";
      this.escapes++;
      return "written";
    } catch (error) {
      return { error };
    }
  }
}
