/**
 * Detects and answers the allowlisted family of adapter startup trust prompts.
 * Implements PRD §5.1 and §9.1 (C-CLAUDE-10, C-CODEX-11, C-CLAUDE-14, C-CODEX-15).
 */

import type { ElwoodAgentKind } from "./activity.ts";
import { type TrustPromptId, type TrustPromptSpec, trustPromptAllowlist } from "./trust-prompts.ts";

export type TrustPromptAutomation = {
  /** The allowlisted prompt id that was answered (a stable `startup_prompt` label). */
  readonly prompt: TrustPromptId;
  readonly input: string;
};

/**
 * Answers each allowlisted trust prompt for one agent at most once, and only
 * when enabled (the caller's full-trust/autotrust posture). The prompt AND its
 * affirmative option are matched within the SAME current frame — never across an
 * accumulated history — so a stale phrase can't select a different dialog's
 * "Yes". Extending trust is adding an allowlist entry, never a broader match.
 */
export class TrustPromptResponder {
  private readonly enabled: boolean;
  private readonly specs: readonly TrustPromptSpec[];
  private readonly answered = new Set<TrustPromptId>();

  constructor(agent: ElwoodAgentKind, enabled = false) {
    this.enabled = enabled;
    this.specs = trustPromptAllowlist.filter((spec) => spec.agent === agent);
  }

  /** `frame` MUST be the CURRENT rendered screen, not an accumulated buffer. */
  handle(frame: string, write: (input: string) => void): TrustPromptAutomation | undefined {
    for (const spec of this.specs) {
      // `always` prompts (Elwood's own hook bridge) answer regardless of
      // autotrust; every other trust prompt requires the caller's full-trust
      // posture so third-party trust is never granted implicitly.
      if (!(this.enabled || spec.always)) continue;
      if (this.answered.has(spec.id) || !spec.visible.test(frame)) continue;
      // The answer must be THIS prompt's own affirmative option, present in the
      // same frame — not any generic "Yes" that might belong to another dialog.
      const option = acceptOption(frame, spec);
      if (option === undefined) continue;
      write(`${option}\r`);
      this.answered.add(spec.id);
      return { prompt: spec.id, input: option };
    }
    return undefined;
  }
}

/** True when any allowlisted trust prompt for `agent` is visible in `text`. */
export function trustPromptVisible(text: string, agent: ElwoodAgentKind): boolean {
  return trustPromptAllowlist.some((spec) => spec.agent === agent && spec.visible.test(text));
}

function acceptOption(frame: string, spec: TrustPromptSpec): string | undefined {
  return numberedOptions(frame).find((option) => spec.accept.test(option.label))?.number;
}

function numberedOptions(
  text: string,
): readonly { readonly number: string; readonly label: string }[] {
  return text.split("\n").flatMap((line) => {
    const matches = line.matchAll(/(?:^|[\s›>])(\d+)[.)]\s*(.+?)(?=\s*\d+[.)]\s*|$)/g);
    return [...matches].map((match) => ({ number: match[1]!, label: match[2]!.trim() }));
  });
}
