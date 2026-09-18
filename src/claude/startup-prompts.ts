/**
 * Answers Claude first-party startup prompts that block embedded readiness:
 * workspace/skill/plugin/MCP trust (via the allowlisted TrustPromptResponder)
 * and the browser-tools prompt. Implements PRD §5.1, C-CLAUDE-10, C-CLAUDE-11,
 * C-CLAUDE-14, and C-CLAUDE-16.
 */

import type { AutomationWriteResult } from "../core/startup/barrier.ts";
import type { SettledStartupOutcome, StartupWriteCompletion } from "../core/startup/write.ts";
import { TrustPromptResponder, type TrustWriteResult } from "../core/trust/responder.ts";

// The prompt's documented decline keystroke (ESC).
const declineKey = "\u001b";

export class ClaudeStartupPromptResponder {
  private readonly trust: TrustPromptResponder<"claude">;
  private browserDeclined = false;

  constructor(autotrust: boolean, onStateChange?: () => void) {
    this.trust = new TrustPromptResponder("claude", autotrust, onStateChange);
  }

  get blockedPrompt() {
    return this.trust.blockedPrompt;
  }

  dispose(): void {
    this.trust.dispose();
  }

  get inputBlocking(): boolean {
    return this.trust.inputBlocking;
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
    const trust = this.trust.handle(screenText, write, readFrame);
    if (trust?.kind === "attempted") {
      settled.push({ outcome: { kind: "attempted", ...trust.automation }, settled: trust.settled });
    } else if (trust?.kind === "option_pending") {
      settled.push({ outcome: { kind: "option_pending", prompt: trust.prompt } });
    }
    if (!this.browserDeclined && browserToolsPromptVisible(screenText)) {
      // Escape is the prompt's documented decline path and needs no option
      // number, so it stays correct if the option ordering changes. Settle
      // OPTIMISTICALLY, but keep the decline retryable if the write is rejected
      // so a later frame re-attempts it rather than reporting a false "answered".
      this.browserDeclined = true;
      // A WITHHELD write never reached the PTY (a trust gate was on the settled frame),
      // so the decline must not claim success: un-latch it and settle as `cancelled`,
      // which emits no `startup_prompt` activity and leaves a later frame to retry.
      const writeSettled = Promise.resolve(writeAutomation(declineKey))
        .then((result): StartupWriteCompletion => {
          if (result !== "withheld") return "answered";
          this.browserDeclined = false;
          return "cancelled";
        })
        .catch((error: unknown) => {
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

export function browserToolsPromptVisible(text: string): boolean {
  return /use my browser/i.test(text) && /keep browser tools off/i.test(text);
}
