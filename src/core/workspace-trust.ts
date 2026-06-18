/**
 * Detects and answers adapter workspace trust prompts.
 * Implements PRD §5 and §9.1.
 */

import type { ElwoodAgentKind } from "./activity.ts";

export type WorkspaceTrustAutomation = {
  readonly prompt: "workspace_trust";
  readonly input: string;
};

export class WorkspaceTrustResponder {
  private readonly agent: ElwoodAgentKind;
  private readonly enabled: boolean;
  private trusted = false;

  constructor(agent: ElwoodAgentKind, enabled = false) {
    this.agent = agent;
    this.enabled = enabled;
  }

  handle(screenText: string, write: (input: string) => void): WorkspaceTrustAutomation | undefined {
    if (!this.enabled || this.trusted || !workspaceTrustPromptVisible(screenText, this.agent)) {
      return undefined;
    }
    write("1\r");
    this.trusted = true;
    return { prompt: "workspace_trust", input: "1" };
  }
}

export function workspaceTrustPromptVisible(text: string, agent: ElwoodAgentKind): boolean {
  if (agent === "claude") return /trust this folder/i.test(text);
  return /Do you trust the contents of this directory/i.test(text);
}
