/**
 * Shared builder for the per-agent trust blocking screen-fact rules.
 * Implements PRD §5.1/§5.5 (C-ATTN-03): a trust prompt that stays UNANSWERED
 * under the policy classifies as a blocking prompt. Both adapters build these
 * rules identically, so the construction — option-aware header recognition,
 * stable semantic ids, base-table append — lives here once instead of diverging
 * across `claude/screen-table.ts` and `codex/screen-table.ts`. A native-shaped gate
 * whose header is OFF the allowlist is hold-only under every policy (C-TRUST-01).
 */

import type { ElwoodAgentKind } from "../activity/index.ts";
import type { ScreenFactRule, ScreenFactTable } from "../screen-facts.ts";
import { parseTrustCandidates } from "./dialog.ts";
import { blockingTrustSpecs, trustPromptAllowlist } from "./prompts.ts";

/** Holds known native candidates even when their body is unsafe to automate. */
export function withTrustBlockingRules(
  base: ScreenFactTable,
  agent: ElwoodAgentKind,
  autotrust: boolean,
): ScreenFactTable {
  let cachedFrame: string | undefined;
  let cached: ReturnType<typeof parseTrustCandidates> = [];
  const regionsFor = (text: string) => {
    if (cachedFrame !== text) {
      cachedFrame = text;
      cached = parseTrustCandidates(text);
    }
    return cached;
  };
  const rules: ScreenFactRule[] = blockingTrustSpecs(agent, autotrust).map((spec) => ({
    id: `${agent}-${spec.id}-prompt`,
    fact: "blocking_prompt_visible",
    match: (text) => {
      return regionsFor(text).some(({ dialog }) => spec.headerPattern.test(dialog.header));
    },
  }));
  const known = trustPromptAllowlist.filter((spec) => spec.agent === agent);
  // A reworded or brand-new gate: the bottom-most header-shaped region is a complete
  // native option dialog (nothing but options and a footer below it, no conversation
  // row above it) and NO region names an allowlisted prompt. Enter would answer it, so
  // it holds input for a human and is never written to. `fallback` yields to a dialog
  // the adapter table already names (e.g. a "Do you want to ...?" permission prompt).
  rules.push({
    id: `${agent}-unknown_gate-prompt`,
    fact: "blocking_prompt_visible",
    fallback: true,
    match: (text) => {
      const regions = regionsFor(text);
      const gate = regions[0];
      return (
        gate?.validTail === true &&
        gate.dialog.options.length > 0 &&
        !regions.some(({ dialog }) => known.some((spec) => spec.headerPattern.test(dialog.header)))
      );
    },
  });
  return { ...base, rules: [...base.rules, ...rules] };
}
