/**
 * Shared builder for the per-agent trust blocking screen-fact rules.
 * Implements PRD §5.1/§5.5 (C-ATTN-03): a trust prompt that stays UNANSWERED
 * under the policy classifies as a blocking prompt. Both adapters build these
 * rules identically, so the construction — option-aware header recognition,
 * stable semantic ids, base-table append — lives here once instead of diverging
 * across `claude/screen-table.ts` and `codex/screen-table.ts`.
 */

import type { ElwoodAgentKind } from "./activity.ts";
import type { ScreenFactRule, ScreenFactTable } from "./screen-facts.ts";
import { blockingTrustSpecs, trustPromptHeaderVisible } from "./trust-prompts.ts";

/**
 * `base` plus one `blocking_prompt_visible` rule per trust prompt that stays
 * unanswered under `autotrust`. Each rule recognizes the prompt only by its
 * HEADER on a non-option line (the same recognizer the responder uses), so an
 * unrelated dialog whose numbered option merely contains a trust phrase is NOT
 * misclassified as a blocking trust prompt (PRD §5.1). Returns `base` unchanged
 * when no trust prompt blocks (e.g. every allowlisted prompt is auto-answered).
 */
export function withTrustBlockingRules(
  base: ScreenFactTable,
  agent: ElwoodAgentKind,
  autotrust: boolean,
): ScreenFactTable {
  const rules: ScreenFactRule[] = blockingTrustSpecs(agent, autotrust).map((spec) => ({
    id: `${agent}-${spec.id}-prompt`,
    fact: "blocking_prompt_visible",
    match: (text) => trustPromptHeaderVisible(text, spec),
  }));
  return rules.length === 0 ? base : { ...base, rules: [...base.rules, ...rules] };
}
