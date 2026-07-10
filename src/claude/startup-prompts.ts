/**
 * Answers Claude first-party startup prompts that block embedded readiness.
 * Implements PRD §5.1, C-CLAUDE-10, and C-CLAUDE-11.
 */

import type { StartupPromptAutomation } from "../core/startup-automation.ts";
import { TrustPromptResponder } from "../core/trust-responder.ts";

export class ClaudeStartupPromptResponder {
  private readonly trust: TrustPromptResponder<"claude">;
  private browserDeclined = false;

  constructor(autotrust: boolean) {
    this.trust = new TrustPromptResponder("claude", autotrust);
  }

  handle(screenText: string, write: (input: string) => void): readonly StartupPromptAutomation[] {
    const automations: StartupPromptAutomation[] = [];
    const trust = this.trust.handle(screenText, write);
    if (trust?.kind === "answered") automations.push(trust.automation);
    else if (trust?.kind === "unanswerable") {
      automations.push({ prompt: trust.prompt, input: "", unanswerable: true });
    }
    if (!this.browserDeclined && browserToolsPromptVisible(screenText)) {
      // Escape is the prompt's documented decline path and needs no option
      // number, so it stays correct if the option ordering changes.
      write("\u001b");
      this.browserDeclined = true;
      automations.push({ prompt: "browser_tools", input: "esc" });
    }
    return automations;
  }
}

export function browserToolsPromptVisible(text: string): boolean {
  return /use my browser/i.test(text) && /keep browser tools off/i.test(text);
}
