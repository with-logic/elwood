/**
 * Applies turn-state and attention watchers to a rendered frame and submits
 * the resulting evidence, emitting the attention activity on a real block.
 * Implements PRD §5.3 turn and blocked detection.
 */

import type { ElwoodActivityEvent, ElwoodAgentKind } from "./activity.ts";
import { type AttentionWatcher, activityFromAttention } from "./attention.ts";
import { type RenderedFrame, readScreenFacts, type ScreenFactTable } from "./screen-facts.ts";
import type { TurnStateWatcher } from "./turn-state.ts";
import type { ElwoodStatusDecision, ElwoodStatusEvidence } from "./types.ts";

export type RenderedObserverTarget = {
  submitEvidence(kind: ElwoodStatusEvidence): Pick<ElwoodStatusDecision, "to">;
};

export type RenderedObservers = {
  readonly turn: TurnStateWatcher;
  readonly attention: AttentionWatcher;
  /** The superset fact table (includes blocking/attention rules). */
  readonly table: ScreenFactTable;
  readonly agent: ElwoodAgentKind;
  readonly elwoodSessionId: string;
  readonly emitActivity: (event: ElwoodActivityEvent) => void;
};

export function observeRenderedFrame(
  observers: RenderedObservers,
  frame: RenderedFrame,
  session: RenderedObserverTarget | undefined,
): void {
  // Classify the frame once; turn and attention watchers share the reading.
  const reading = readScreenFacts(observers.table, frame);
  const turnEdge = observers.turn.observe(reading.facts);
  if (turnEdge === "started") session?.submitEvidence("rendered_turn_started");
  if (turnEdge === "ended") session?.submitEvidence("rendered_turn_ended");
  const attention = observers.attention.observe(reading);
  if (attention?.edge === "raised") {
    const decision = session?.submitEvidence("blocking_prompt_shown");
    if (decision?.to === "blocked") {
      const { agent, elwoodSessionId } = observers;
      observers.emitActivity(activityFromAttention(agent, elwoodSessionId, attention.ruleIds));
    }
  }
  if (attention?.edge === "cleared") session?.submitEvidence("blocking_prompt_cleared");
}
