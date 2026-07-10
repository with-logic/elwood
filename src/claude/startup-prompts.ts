/**
 * Answers Claude first-party startup prompts that block embedded readiness:
 * workspace/skill/plugin/MCP trust (via the allowlisted TrustPromptResponder)
 * and the browser-tools prompt. Implements PRD §5.1, C-CLAUDE-10, C-CLAUDE-11,
 * and C-CLAUDE-14.
 */

import type { StartupPromptOutcome } from "../core/startup-automation.ts";
import { TrustPromptResponder } from "../core/trust-responder.ts";

export class ClaudeStartupPromptResponder {
  private readonly trust: TrustPromptResponder<"claude">;
  private browserDeclined = false;

  constructor(autotrust: boolean) {
    this.trust = new TrustPromptResponder("claude", autotrust);
  }

  handle(
    screenText: string,
    write: (input: string) => void,
  ): readonly StartupPromptOutcome<"claude">[] {
    const outcomes: StartupPromptOutcome<"claude">[] = [];
    const trust = this.trust.handle(screenText, write);
    if (trust?.kind === "answered") {
      outcomes.push({ kind: "answered", ...trust.automation });
    } else if (trust?.kind === "option_pending") {
      outcomes.push({ kind: "option_pending", prompt: trust.prompt });
    }
    if (!this.browserDeclined && browserToolsPromptVisible(screenText)) {
      // Escape is the prompt's documented decline path and needs no option
      // number, so it stays correct if the option ordering changes.
      write("\u001b");
      this.browserDeclined = true;
      outcomes.push({ kind: "answered", prompt: "browser_tools", input: "esc" });
    }
    return outcomes;
  }
}

export function browserToolsPromptVisible(text: string): boolean {
  return /use my browser/i.test(text) && /keep browser tools off/i.test(text);
}
