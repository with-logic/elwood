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
    const option = findTrustOption(screenText);
    if (!option) return undefined;
    write(`${option}\r`);
    this.trusted = true;
    return { prompt: "workspace_trust", input: option };
  }
}

export const claudeTrustPrompt = /trust this folder/i;
export const codexTrustPrompt = /Do you trust the contents of this directory/i;

export function workspaceTrustPromptVisible(text: string, agent: ElwoodAgentKind): boolean {
  return (agent === "claude" ? claudeTrustPrompt : codexTrustPrompt).test(text);
}

function findTrustOption(text: string): string | null {
  return (
    numberedOptions(text).find((option) => trustOptionPattern.test(option.label))?.number ?? null
  );
}

const trustOptionPattern = /^(?!.*\b(no|without|not|quit|cancel)\b).*\b(yes|trust|continue)\b/i;

function numberedOptions(
  text: string,
): readonly { readonly number: string; readonly label: string }[] {
  return text.split("\n").flatMap((line) => {
    const matches = line.matchAll(/(?:^|[\s›>])(\d+)[.)]\s*(.+?)(?=\s*\d+[.)]\s*|$)/g);
    return [...matches].map((match) => ({ number: match[1]!, label: match[2]!.trim() }));
  });
}
