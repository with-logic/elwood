/**
 * Answers Claude first-party startup prompts that block embedded readiness:
 * workspace/skill/plugin/MCP trust (via the allowlisted TrustPromptResponder)
 * and the browser-tools prompt. Implements PRD §5.1, C-CLAUDE-10, C-CLAUDE-11,
 * C-CLAUDE-14, and C-CLAUDE-16.
 */

import type { SettledStartupOutcome } from "../core/startup/write.ts";
import { unknownGateVisible } from "../core/trust/blocking.ts";
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

  handle(
    screenText: string,
    write: (input: string) => TrustWriteResult,
    readFrame?: () => string,
  ): readonly SettledStartupOutcome<"claude">[] {
    const settled: SettledStartupOutcome<"claude">[] = [];
    const trust = this.trust.handle(screenText, write, readFrame);
    if (trust?.kind === "attempted") {
      settled.push({ outcome: { kind: "attempted", ...trust.automation }, settled: trust.settled });
    } else if (trust?.kind === "option_pending") {
      settled.push({ outcome: { kind: "option_pending", prompt: trust.prompt } });
    }
    if (
      !this.browserDeclined &&
      browserToolsPromptVisible(screenText) &&
      !unknownGateVisible(screenText, "claude") // an off-allowlist gate is hold-only (C-TRUST-01)
    ) {
      // Escape is the prompt's documented decline path and needs no option
      // number, so it stays correct if the option ordering changes. Settle
      // OPTIMISTICALLY, but keep the decline retryable if the write is rejected
      // so a later frame re-attempts it rather than reporting a false "answered".
      this.browserDeclined = true;
      const writeSettled = Promise.resolve(write(declineKey)).catch((error: unknown) => {
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
