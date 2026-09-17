/**
 * Rendered-screen attention watching: raises and clears the blocked state
 * for dialogs that need a human decision.
 * Implements PRD §5.3 blocked status (C-ATTN-01 through C-ATTN-03).
 */

import type { ElwoodActivityEvent, ElwoodAgentKind } from "./activity/index.ts";
import type { ScreenFactReading } from "./screen-facts.ts";

export type AttentionEdge = {
  readonly edge: "raised" | "cleared";
  /** Ids of the blocking rules that matched, for explain traces. */
  readonly ruleIds: readonly string[];
};

export class AttentionWatcher {
  private blocked = false;

  /** Consumes a reading already classified from the frame (see observeRenderedFrame). */
  observe(reading: ScreenFactReading): AttentionEdge | undefined {
    if (reading.facts.blocking_prompt_visible === this.blocked) return undefined;
    this.blocked = !this.blocked;
    if (!this.blocked) return { edge: "cleared", ruleIds: [] };
    return { edge: "raised", ruleIds: blockingRuleIds(reading) };
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
