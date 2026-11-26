/**
 * Declines Claude's auto-mode setup offer, a first-party onboarding prompt that would
 * otherwise block an embedded session after a turn, with its own Esc (`Not now`).
 * Implements PRD §5.1 and C-CLAUDE-27.
 */
import { waitForInput } from "../../core/input/abort.ts";
import type { AutomationWriteResult } from "../../core/startup/barrier.ts";
import type { SettledStartupOutcome, StartupWriteCompletion } from "../../core/startup/write.ts";
import type { TrustWriteResult } from "../../core/trust/responder.ts";
import { isClaudeAutoModeOfferMenu } from "./offer.ts";

/**
 * Between attempts, and before the first. The offer ignores a choice made less than
 * 500 ms after its first render or after the previous attempt, and every attempt restarts
 * that window, so an Esc sent as soon as the offer paints is ignored.
 */
const offerDeclineSpacingMs = 750;
/** Escapes written per appearance before the offer is left to the human. */
const offerDeclineAttempts = 4;
/**
 * Attempts per appearance that make no progress: a withheld or rejected Esc, or a settled
 * frame that cannot be read after the last Esc. Then the offer is left to the human.
 */
const offerDeclineFailures = 3;

/** Writes a key only while the settled frame still satisfies `stillValid`. */
export type OfferDeclineWriter = (
  input: string,
  stillValid: (frameText: string) => boolean,
) => TrustWriteResult | Promise<AutomationWriteResult>;

const declineKey = "\u001b";

/**
 * At most one decline per appearance of the offer's first menu, whatever its outcome. Never
 * the setup step that `Yes` opens, and never an appearance raw caller input has touched:
 * that one is the human's.
 */
export class ClaudeAutoModeOfferDecliner {
  /**
   * `none` arms the next menu frame, `declining` has a decline in flight, and `spent` means
   * this appearance is finished, declined or left to the human, until a frame without the
   * menu arms the next one.
   */
  private appearance: "none" | "declining" | "spent" = "none";
  private humanOwned = false;
  /** Escapes this appearance has written. A withheld one never reached the PTY. */
  private escapes = 0;
  /** A settled frame showed the menu gone after an Esc, before any caller input. */
  private dismissed = false;
  private readonly signal: AbortSignal;
  private readonly spacingMs: number;
  constructor(signal: AbortSignal, spacingMs = offerDeclineSpacingMs) {
    this.signal = signal;
    this.spacingMs = spacingMs;
  }

  /**
   * Raw caller input reached the session. Until a settled frame shows Elwood's dismissal it
   * may have reached the offer, so the current appearance is the human's. Only the next
   * appearance clears that, and input after the dismissal went to whatever replaced the offer.
   */
  callerInput(): void {
    if (!this.dismissed) this.humanOwned = true;
  }

  /** Starts declining when `frameText` first shows the offer's menu. */
  handle(
    frameText: string,
    write: OfferDeclineWriter,
    readSettled: () => string | undefined,
  ): SettledStartupOutcome<"claude"> | undefined {
    if (!isClaudeAutoModeOfferMenu(frameText)) {
      if (this.appearance === "spent") this.appearance = "none";
      else if (this.appearance === "declining") this.noteDismissal(readSettled);
      return undefined;
    }
    if (this.appearance !== "none" || this.signal.aborted) return undefined;
    this.appearance = "declining";
    this.humanOwned = false;
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
   * is withheld. Only a new appearance clears `humanOwned`, and none starts mid-decline.
   */
  private readonly stillDeclinable = (frameText: string): boolean =>
    !this.humanOwned && isClaudeAutoModeOfferMenu(frameText);

  /**
   * Records the dismissal as soon as a settled frame shows it, so caller input during the
   * rest of the spacing wait cannot take a decline that has already landed.
   */
  private noteDismissal(readSettled: () => string | undefined): void {
    if (this.escapes === 0 || this.humanOwned) return;
    const frame = readSettled();
    if (frame !== undefined && !isClaudeAutoModeOfferMenu(frame)) this.dismissed = true;
  }

  /**
   * `answered` only once a settled frame shows the menu gone after an Esc went out. A decline
   * that runs out of Escapes or failures reports nothing: the session stays `blocked` on the
   * offer's attention label, which leaves it to the human (§5.1). When one of its failures was
   * a rejected write, that error is its outcome, so a write-failure warning reports it.
   */
  private async decline(
    write: OfferDeclineWriter,
    readSettled: () => string | undefined,
  ): Promise<StartupWriteCompletion> {
    let failures = 0;
    let rejection: { readonly error: unknown } | undefined;
    try {
      for (;;) {
        await waitForInput(this.spacingMs, this.signal);
        const ended = this.check(readSettled());
        if (ended) return ended;
        if (this.escapes < offerDeclineAttempts) {
          const attempt = await this.escape(write);
          if (attempt === "written") continue;
          if (attempt !== "withheld") rejection = attempt;
        }
        if (++failures < offerDeclineFailures) continue;
        if (rejection) throw rejection.error;
        return "cancelled";
      }
    } catch (error) {
      if (this.signal.aborted) return "cancelled";
      throw error;
    }
  }

  /** How the decline ends at this check, or undefined to attempt again. */
  private check(frame: string | undefined): StartupWriteCompletion | undefined {
    // A dismissal a frame showed wins over everything after it, exhaustion included.
    if (this.dismissed) return "answered";
    if (this.humanOwned) return "cancelled";
    if (frame !== undefined && !isClaudeAutoModeOfferMenu(frame))
      return this.escapes > 0 ? "answered" : "cancelled";
    if (this.escapes === offerDeclineAttempts && frame !== undefined) return "cancelled";
    return undefined;
  }

  /** One Esc: written, withheld (it never reached the PTY, so it spends no Escape), or rejected. */
  private async escape(
    write: OfferDeclineWriter,
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
