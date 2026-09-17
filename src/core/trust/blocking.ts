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

/**
 * Blocking rules for every native trust candidate: allowlisted gates the human owns
 * (held even when their body is unsafe to automate) plus the off-allowlist fallback.
 */
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
  rules.push({
    id: `${agent}-unknown_gate-prompt`,
    fact: "blocking_prompt_visible",
    fallback: true, // yields to a dialog the adapter table already names (permission prompts)
    match: (text) => unknownGateVisible(text, agent, regionsFor(text)),
  });
  return { ...base, rules: [...base.rules, ...rules] };
}

/**
 * A reworded or new gate behind a recognized native header prefix (`headerStart`): the
 * bottom-most region is a COMPLETE option dialog — a real header, options, nothing
 * below them but the native footer that ends the frame, no conversation row above —
 * and NO region names an allowlisted prompt. Enter would answer it, so it holds input
 * for a human; every non-trust startup automation consults this before each write.
 */
export function unknownGateVisible(
  frame: string,
  agent: ElwoodAgentKind,
  regions = parseTrustCandidates(frame),
): boolean {
  const gate = regions[0];
  return (
    gate?.validTail === true &&
    gate.footer &&
    gate.dialog.header !== "" &&
    gate.dialog.options.length > 0 &&
    !regions.some(({ dialog }) =>
      trustPromptAllowlist.some(
        (spec) => spec.agent === agent && spec.headerPattern.test(dialog.header),
      ),
    )
  );
}
