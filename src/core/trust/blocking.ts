/**
 * Shared builder for the per-agent trust blocking screen-fact rules.
 * Implements PRD §5.1/§5.5 (C-ATTN-03): a trust prompt that stays UNANSWERED
 * under the policy classifies as a blocking prompt. Both adapters build these
 * rules identically, so the construction — option-aware header recognition,
 * stable semantic ids, base-table append — lives here once instead of diverging
 * across `claude/screen-table.ts` and `codex/screen-table.ts`.
 */

import type { ElwoodAgentKind } from "../activity/index.ts";
import type { ScreenFactRule, ScreenFactTable } from "../screen-facts.ts";
import { parseTrustCandidates, type TrustDialog } from "./dialog.ts";
import { blockingTrustSpecs } from "./prompts.ts";

/** Holds known native candidates even when their body is unsafe to automate. */
export function withTrustBlockingRules(
  base: ScreenFactTable,
  agent: ElwoodAgentKind,
  autotrust: boolean,
): ScreenFactTable {
  let cachedFrame: string | undefined;
  let cachedDialogs: readonly TrustDialog[] = [];
  const dialogFor = (text: string) => {
    if (cachedFrame !== text) {
      cachedFrame = text;
      cachedDialogs = parseTrustCandidates(text).map((candidate) => candidate.dialog);
    }
    return cachedDialogs;
  };
  const rules: ScreenFactRule[] = blockingTrustSpecs(agent, autotrust).map((spec) => ({
    id: `${agent}-${spec.id}-prompt`,
    fact: "blocking_prompt_visible",
    match: (text) => {
      return dialogFor(text).some((dialog) => spec.headerPattern.test(dialog.header));
    },
  }));
  return rules.length === 0 ? base : { ...base, rules: [...base.rules, ...rules] };
}
