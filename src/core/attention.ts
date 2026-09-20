/**
 * Rendered-screen attention watching: raises, updates, and clears human attention
 * for dialogs that need a human decision.
 * Implements PRD §5.3 blocked status (C-ATTN-01 through C-ATTN-03).
 */

import type { ElwoodActivityEvent, ElwoodAgentKind } from "./activity/index.ts";
import type { ScreenFactReading } from "./screen-facts.ts";

export type AttentionEdge = {
  /** Updates change the diagnostic label without another blocked transition. */
  readonly edge: "raised" | "updated" | "cleared";
  /** Ids of the blocking rules that matched, for explain traces. */
  readonly ruleIds: readonly string[];
};

export class AttentionWatcher {
  private blocked = false;
  private ruleIds: readonly string[] = [];

  /** Consumes a reading already classified from the frame (see observeRenderedFrame). */
  observe(reading: ScreenFactReading): AttentionEdge | undefined {
    const blocked = reading.facts.blocking_prompt_visible;
    const ruleIds = blocked ? [...new Set(blockingRuleIds(reading))] : [];
    if (
      blocked === this.blocked &&
      ruleIds.length === this.ruleIds.length &&
      ruleIds.every((id) => this.ruleIds.includes(id))
    )
      return undefined;
    const edge = blocked ? (this.blocked ? "updated" : "raised") : "cleared";
    this.blocked = blocked;
    this.ruleIds = ruleIds;
    return { edge, ruleIds };
  }
}

/** Ids of the blocking rules a reading matched: the attention label's parts. */
export function blockingRuleIds(reading: ScreenFactReading): readonly string[] {
  return reading.matched
    .filter((rule) => rule.fact === "blocking_prompt_visible")
    .map((rule) => rule.id);
}

export function activityFromAttention(
  agent: ElwoodAgentKind,
  elwoodSessionId: string,
  ruleIds: readonly string[],
): ElwoodActivityEvent {
  return {
    elwoodSessionId,
    agent,
    source: "terminal",
    kind: "attention",
    label: ruleIds.join(","),
    text: "Agent is blocked waiting on a human decision.",
  };
}
