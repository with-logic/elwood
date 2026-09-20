/**
 * Answers Claude first-party startup prompts that block embedded readiness:
 * workspace/skill/plugin/MCP trust (via the allowlisted TrustPromptResponder)
 * and the browser-tools prompt. Implements PRD §5.1, C-CLAUDE-10, C-CLAUDE-11,
 * C-CLAUDE-14, and C-CLAUDE-16.
 */

import type { InputTerminal } from "../core/input/abort.ts";
import {
  type AutomationWriteResult,
  guardedNonTrustAutomationWrite,
  type NonTrustAutomationWriter,
} from "../core/startup/barrier.ts";
import type { SettledStartupOutcome, StartupWriteCompletion } from "../core/startup/write.ts";
import { trustGateVisible } from "../core/trust/blocking.ts";
import { TrustPromptResponder, type TrustWriteResult } from "../core/trust/responder.ts";
import { claudeTrustClearance } from "./screen-table.ts";

// The prompt's documented decline keystroke (ESC).
const declineKey = "\u001b";

export class ClaudeStartupPromptResponder {
  private readonly trust: TrustPromptResponder<"claude">;
  private browserDeclined = false;
  private disposed = false;

  constructor(autotrust: boolean, onStateChange?: () => void) {
    this.trust = new TrustPromptResponder("claude", claudeTrustClearance, autotrust, onStateChange);
  }

  get blockedPrompt() {
    return this.trust.blockedPrompt;
  }

  /**
   * Session closing owns cancellation for NON-TRUST automation too, not just for trust
   * attempts. After `dispose()` no new decline is attempted, and a decline already in
   * flight settles `cancelled`, so nothing writes to a dead PTY and neither
   * `startup_prompt` nor `startup_prompt_write_failed` is emitted after stop/kill/exit
   * (C-CLAUDE-22).
   */
  dispose(): void {
    this.disposed = true;
    this.trust.dispose();
  }

  get inputBlocking(): boolean {
    return this.trust.inputBlocking;
  }

  /** Lets the guarded writer abandon a write that is still parked on render settlement. */
  get closing(): boolean {
    return this.disposed;
  }

  /**
   * `write` answers TRUST prompts and belongs to `TrustPromptResponder` alone.
   * `writeAutomation` carries every NON-trust automated key (here, the browser-tools
   * decline). They are separate parameters so the two classes of write can be guarded
   * differently — only non-trust automation may be withheld when a trust gate is on
   * screen, since answering such a gate is the trust responder's own job (#42).
   * Defaults to `write`, so a caller that passes one writer keeps today's behavior.
   */
  handle(
    screenText: string,
    write: (input: string) => TrustWriteResult,
    readFrame?: () => string,
    writeAutomation: (input: string) => TrustWriteResult | Promise<AutomationWriteResult> = write,
  ): readonly SettledStartupOutcome<"claude">[] {
    const settled: SettledStartupOutcome<"claude">[] = [];
    if (this.disposed) return settled;
    const trust = this.trust.handle(screenText, write, readFrame);
    if (trust?.kind === "attempted") {
      settled.push({ outcome: { kind: "attempted", ...trust.automation }, settled: trust.settled });
    } else if (trust?.kind === "option_pending") {
      settled.push({ outcome: { kind: "option_pending", prompt: trust.prompt } });
    }
    if (
      !this.browserDeclined &&
      browserToolsPromptVisible(screenText) &&
      !trustGateVisible(screenText, "claude") // a trust gate is never declined blind (C-TRUST-01)
    ) {
      // Escape is the prompt's documented decline path and needs no option
      // number, so it stays correct if the option ordering changes. Settle
      // OPTIMISTICALLY, but a rejected live-session write stays retryable on a
      // later frame. Disposal permanently cancels retries and diagnostics.
      this.browserDeclined = true;
      // A WITHHELD write never reached the PTY (a trust gate was on the settled frame),
      // so the decline must not claim success: un-latch it and settle as `cancelled`,
      // which emits no activity; a later frame retries only while still live.
      const writeSettled = Promise.resolve(writeAutomation(declineKey))
        .then((result): StartupWriteCompletion => {
          // Disposal DURING the write wins: the session is gone, so report neither a
          // success activity nor a write-failure warning for it (C-CLAUDE-22).
          if (this.disposed) return "cancelled";
          if (result !== "withheld") return "answered";
          this.browserDeclined = false;
          return "cancelled";
        })
        .catch((error: unknown): StartupWriteCompletion => {
          if (this.disposed) return "cancelled";
          this.browserDeclined = false;
          throw error;
        });
      settled.push({
        outcome: { kind: "attempted", prompt: "browser_tools", input: "esc" },
        settled: writeSettled,
      });
    }
    return settled;
  }
}

/**
 * The Claude non-trust automation barrier. The decline is only correct while its own
 * prompt is still on screen: if the prompt cleared during settlement, an Escape would
 * land in whatever replaced it (a composer, clearing staged text), so it is withheld.
 */
export function guardedClaudeAutomationWrite(
  terminal: InputTerminal,
  write: NonTrustAutomationWriter,
  readFrame: () => string,
  cancelled: () => boolean = () => false,
): (input: string) => Promise<AutomationWriteResult> {
  return guardedNonTrustAutomationWrite(
    terminal,
    write,
    readFrame,
    "claude",
    (frameText) => browserToolsPromptVisible(frameText),
    cancelled,
  );
}

export function browserToolsPromptVisible(text: string): boolean {
  return /use my browser/i.test(text) && /keep browser tools off/i.test(text);
}
