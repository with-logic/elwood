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

type TrustRegions = ReturnType<typeof parseTrustCandidates>;

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
  let cached: TrustRegions = [];
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
    // Yields to ANY earlier rule that already set `blocking_prompt_visible` for this
    // frame — permission and approval dialogs, but also the update and model-switch
    // rules — so a gate an adapter table already names keeps its own label.
    fallback: true,
    match: (text) => unknownGateVisible(regionsFor(text), agent),
  });
  return { ...base, rules: [...base.rules, ...rules] };
}

/**
 * A reworded or new gate behind a recognized native header prefix (`headerStart`): the
 * bottom-most region is a COMPLETE option dialog — a real header, options, nothing
 * below them but the native footer that ends the frame, no conversation row above —
 * and NO region names an allowlisted prompt. Enter would answer it, so it holds input.
 */
function unknownGateVisible(regions: TrustRegions, agent: ElwoodAgentKind): boolean {
  const gate = regions[0];
  return (
    gate?.validTail === true &&
    gate.footer &&
    gate.dialog.header !== "" &&
    gate.dialog.options.length > 0 &&
    !namesAllowlistedPrompt(regions, agent)
  );
}

/**
 * Any trust gate is on screen: an allowlisted candidate (even a hold-only one whose body
 * or options are unsupported) or an off-allowlist gate. Non-trust startup automation
 * (update skip, browser-tools decline) consults this before EVERY write and MUST NOT
 * write while it holds. Of the frames it covers, only allowlisted candidates are ever
 * answered, and only by `TrustPromptResponder` under the trust policy; an off-allowlist
 * gate is hold-only and stays for the human, so nothing here may answer it.
 */
export function trustGateVisible(frame: string, agent: ElwoodAgentKind): boolean {
  const regions = parseTrustCandidates(frame);
  return namesAllowlistedPrompt(regions, agent) || unknownGateVisible(regions, agent);
}

function namesAllowlistedPrompt(regions: TrustRegions, agent: ElwoodAgentKind): boolean {
  return regions.some(({ dialog }) =>
    trustPromptAllowlist.some(
      (spec) => spec.agent === agent && spec.headerPattern.test(dialog.header),
    ),
  );
}
