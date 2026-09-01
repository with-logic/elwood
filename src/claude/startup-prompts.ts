/**
 * Answers Claude first-party startup prompts that block embedded readiness:
 * workspace/skill/plugin/MCP trust (via the allowlisted TrustPromptResponder)
 * and the browser-tools prompt. Implements PRD §5.1, C-CLAUDE-10, C-CLAUDE-11,
 * C-CLAUDE-14, and C-CLAUDE-16.
 */

import type { SettledStartupOutcome } from "../core/startup-write.ts";
import { TrustPromptResponder, type TrustWriteResult } from "../core/trust-responder.ts";

// The prompt's documented decline keystroke (ESC); built from its code point so
// the raw control byte never appears literally in source.
const declineKey = String.fromCharCode(0x1b);

export class ClaudeStartupPromptResponder {
  private readonly trust: TrustPromptResponder<"claude">;
  private browserDeclined = false;

  constructor(autotrust: boolean) {
    this.trust = new TrustPromptResponder("claude", autotrust);
  }

  handle(
    screenText: string,
    write: (input: string) => TrustWriteResult,
    readFrame?: () => string,
  ): readonly SettledStartupOutcome<"claude">[] {
    const settled: SettledStartupOutcome<"claude">[] = [];
    const trust = this.trust.handle(screenText, write, readFrame);
    if (trust?.kind === "answered") {
      settled.push({ outcome: { kind: "answered", ...trust.automation }, settled: trust.settled });
    } else if (trust?.kind === "option_pending") {
      settled.push({ outcome: { kind: "option_pending", prompt: trust.prompt } });
    }
    if (!this.browserDeclined && browserToolsPromptVisible(screenText)) {
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
        outcome: { kind: "answered", prompt: "browser_tools", input: "esc" },
        settled: writeSettled,
      });
    }
    return settled;
  }
}

export function browserToolsPromptVisible(text: string): boolean {
  return /use my browser/i.test(text) && /keep browser tools off/i.test(text);
}
