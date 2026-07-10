/**
 * Detects and answers the allowlisted family of adapter startup trust prompts.
 * Implements PRD §5.1 and §9.1 (C-CLAUDE-10, C-CODEX-11, C-CLAUDE-14, C-CODEX-15).
 */

import type { ElwoodAgentKind } from "./activity.ts";
import { type TrustPromptIdFor, trustPromptAllowlist } from "./trust-prompts.ts";

/** The concrete allowlist entry type (preserves the derived literal `id`). */
type TrustPromptEntry = (typeof trustPromptAllowlist)[number];

/** An answered trust prompt; `prompt` is narrowed to the responder's agent. */
export type TrustPromptAutomation<A extends ElwoodAgentKind = ElwoodAgentKind> = {
  readonly prompt: TrustPromptIdFor<A>;
  readonly input: string;
};

/**
 * Answers each allowlisted trust prompt for one agent at most once, and only
 * when enabled (the caller's full-trust/autotrust posture). Generic in the agent
 * so the automation's `prompt` is that agent's own label set. The prompt AND its
 * affirmative option are matched within the SAME current frame — never across an
 * accumulated history — so a stale phrase can't select a different dialog's
 * "Yes". Extending trust is adding an allowlist entry, never a broader match.
 */
export class TrustPromptResponder<A extends ElwoodAgentKind> {
  private readonly enabled: boolean;
  private readonly specs: readonly TrustPromptEntry[];
  private readonly answered = new Set<TrustPromptIdFor<A>>();

  constructor(agent: A, enabled = false) {
    this.enabled = enabled;
    this.specs = trustPromptAllowlist.filter((spec) => spec.agent === agent);
  }

  /** `frame` MUST be the CURRENT rendered screen, not an accumulated buffer. */
  handle(frame: string, write: (input: string) => void): TrustPromptAutomation<A> | undefined {
    for (const spec of this.specs) {
      // `this.specs` was filtered to this agent in the constructor, so its ids
      // are this agent's label set even though the array type is the full union.
      const id = spec.id as TrustPromptIdFor<A>;
      // `always` prompts (Elwood's own hook bridge) answer regardless of
      // autotrust; every other trust prompt requires the caller's full-trust
      // posture so third-party trust is never granted implicitly.
      if (!(this.enabled || ("always" in spec && spec.always))) continue;
      if (this.answered.has(id) || !spec.visible.test(frame)) continue;
      // The answer must be THIS prompt's own affirmative option, present in the
      // same frame — not any generic "Yes" that might belong to another dialog.
      const option = acceptOption(frame, spec);
      if (option === undefined) continue;
      write(`${option}\r`);
      this.answered.add(id);
      return { prompt: id, input: option };
    }
    return undefined;
  }
}

/** True when any allowlisted trust prompt for `agent` is visible in `text`. */
export function trustPromptVisible(text: string, agent: ElwoodAgentKind): boolean {
  return trustPromptAllowlist.some((spec) => spec.agent === agent && spec.visible.test(text));
}

function acceptOption(frame: string, spec: TrustPromptEntry): string | undefined {
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
