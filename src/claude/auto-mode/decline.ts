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
export const offerDeclineSpacingMs = 750;
/** Esc attempts per appearance before the offer is left to the human. */
export const offerDeclineAttempts = 4;

/** Writes a key only while the settled frame still satisfies `stillValid`. */
export type OfferDeclineWriter = (
  input: string,
  stillValid: (frameText: string) => boolean,
) => TrustWriteResult | Promise<AutomationWriteResult>;

const declineKey = "\u001b";

/**
 * One decline per appearance of the offer's first menu. Never the setup step that `Yes`
 * opens, and never an appearance raw caller input has touched: that one is the human's.
 */
export class ClaudeAutoModeOfferDecliner {
  /**
   * `none` arms the next menu frame, `declining` has a decline in flight, and `spent` means
   * this appearance is finished, declined or left to the human, until a frame without the
   * menu arms the next one.
   */
  private appearance: "none" | "declining" | "spent" = "none";
  private humanOwned = false;
  private readonly signal: AbortSignal;
  private readonly spacingMs: number;
  constructor(signal: AbortSignal, spacingMs = offerDeclineSpacingMs) {
    this.signal = signal;
    this.spacingMs = spacingMs;
  }

  /** Raw caller input reached the session: while the offer shows, it went to the offer. */
  callerInput(): void {
    if (this.appearance !== "none") this.humanOwned = true;
  }

  /** Starts declining when `frameText` first shows the offer's menu. */
  handle(
    frameText: string,
    write: OfferDeclineWriter,
    readSettled: () => string | undefined,
  ): SettledStartupOutcome<"claude"> | undefined {
    if (!isClaudeAutoModeOfferMenu(frameText)) {
      if (this.appearance === "spent") this.appearance = "none";
      return undefined;
    }
    if (this.appearance !== "none" || this.signal.aborted) return undefined;
    this.appearance = "declining";
    this.humanOwned = false;
    const settled = this.decline(write, readSettled);
    // A rejected write leaves the offer to a later frame's retry, as every startup prompt.
    settled.then(
      () => {
        this.appearance = "spent";
      },
      () => {
        this.appearance = "none";
      },
    );
    return { outcome: { kind: "attempted", prompt: "auto_mode_setup", input: "esc" }, settled };
  }

  /**
   * Checked on the settled frame just before each Esc goes out, after the writer's wait for
   * settlement: raw caller input during that wait hands the offer to the human, so the Esc
   * is withheld. Only a new appearance clears `humanOwned`, and none starts mid-decline.
   */
  private readonly stillDeclinable = (frameText: string): boolean =>
    !this.humanOwned && isClaudeAutoModeOfferMenu(frameText);

  /** `answered` only once a settled frame shows the menu gone after an Esc went out. */
  private async decline(
    write: OfferDeclineWriter,
    readSettled: () => string | undefined,
  ): Promise<StartupWriteCompletion> {
    let wrote = false;
    try {
      for (let attempt = 0; ; attempt++) {
        await waitForInput(this.spacingMs, this.signal);
        if (this.humanOwned) return "cancelled";
        const frame = readSettled();
        if (frame !== undefined && !isClaudeAutoModeOfferMenu(frame))
          return wrote ? "answered" : "cancelled";
        // Exhausted attempts report nothing: the session stays `blocked` on the offer's
        // attention label, which leaves it to the human (§5.1).
        if (attempt === offerDeclineAttempts) return "cancelled";
        if ((await write(declineKey, this.stillDeclinable)) !== "withheld") wrote = true;
      }
    } catch (error) {
      if (this.signal.aborted) return "cancelled";
      throw error;
    }
  }
}
