/**
 * Applies turn-state and attention watchers to a rendered frame and submits
 * the resulting evidence. Attention activity marks new blocks and changed blocking
 * rules; identical-rule repaints stay quiet.
 * Implements PRD §5.3 turn and blocked detection.
 */

import type { ElwoodActivityEvent, ElwoodAgentKind } from "./activity/index.ts";
import { type AttentionWatcher, activityFromAttention } from "./attention.ts";
import {
  type RenderedFrame,
  readScreenFacts,
  type ScreenFactReading,
  type ScreenFactTable,
} from "./screen-facts.ts";
import type { TurnStateWatcher } from "./turn-state.ts";
import type { ElwoodSessionStatus, ElwoodStatusDecision, ElwoodStatusEvidence } from "./types.ts";

export type RenderedObserverTarget = {
  submitEvidence(
    kind: ElwoodStatusEvidence,
    workingVisible?: boolean,
  ): Pick<ElwoodStatusDecision, "to">;
  /** The session's current lifecycle status — lets the turn watcher release resume
   * settling when a turn is already running from EVIDENCE (see
   * TurnStateWatcher.observe). Typed as the bounded status union so an invalid test
   * double or typo can't silently disable the `status === "running"` path. */
  readonly status: ElwoodSessionStatus;
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
): ScreenFactReading {
  const reading = readRenderedFrame(observers, frame);
  observeRenderedReading(observers, reading, session);
  return reading;
}

/** Include a retained trust hold as an ordinary blocking fact (C-TRUST-01). */
export function readRenderedFrame(
  observers: RenderedObservers,
  frame: RenderedFrame,
  trustBlock?: string,
): ScreenFactReading {
  // Classify the frame once; turn and attention watchers share the reading, and the
  // reading is returned so the caller can drive resume-readiness off the same facts.
  // A retained specific gate outranks generic fallback labels during partial repaints.
  const table =
    trustBlock === undefined
      ? observers.table
      : {
          ...observers.table,
          rules: observers.table.rules.filter(
            (rule) => rule.fact !== "blocking_prompt_visible" || !rule.fallback,
          ),
        };
  const reading = readScreenFacts(table, frame);
  if (trustBlock === undefined) return reading;
  const id = `${observers.agent}-${trustBlock}-prompt`;
  if (reading.matched.some((match) => match.id === id)) return reading;
  return {
    facts: { ...reading.facts, blocking_prompt_visible: true },
    matched: [
      ...reading.matched,
      {
        id,
        fact: "blocking_prompt_visible" as const,
        region: "screen" as const,
      },
    ],
  };
}

/** Apply one classified reading after the caller has latched its input guards. */
export function observeRenderedReading(
  observers: RenderedObservers,
  reading: ScreenFactReading,
  session: RenderedObserverTarget | undefined,
): void {
  const turnEdge = observers.turn.observe(reading.facts, session?.status === "running");
  if (turnEdge === "started") session?.submitEvidence("rendered_turn_started");
  if (turnEdge === "ended") session?.submitEvidence("rendered_turn_ended");
  const attention = observers.attention.observe(reading);
  if (attention?.edge === "raised" || attention?.edge === "updated") {
    const decision =
      attention.edge === "raised" || session?.status !== "blocked"
        ? session?.submitEvidence("blocking_prompt_shown")
        : undefined;
    if (session === undefined || decision?.to === "blocked" || session.status === "blocked") {
      const { agent, elwoodSessionId } = observers;
      observers.emitActivity(activityFromAttention(agent, elwoodSessionId, attention.ruleIds));
    }
  }
  if (attention?.edge === "cleared") {
    // Establish this real turn before public status listeners can observe running.
    // Resume replay settling must not swallow its next idle end edge.
    if (reading.facts.working_visible && session?.status === "blocked")
      observers.turn.adoptWorkingClearance(reading.facts);
    session?.submitEvidence("blocking_prompt_cleared", reading.facts.working_visible);
  }
}
