/**
 * Emits activity for automated startup prompt responses.
 * Implements PRD §5.4 and C-API-18.
 */

import type { ElwoodActivityEvent, ElwoodAgentKind } from "./activity.ts";
import { type TrustPromptIdFor, trustPromptAllowlist } from "./trust-prompts.ts";

export type { TrustPromptIdFor } from "./trust-prompts.ts";

/**
 * The single source of truth for the non-trust startup-prompt labels, keyed by
 * owning agent: the browser-tools onboarding decline is Claude-only (C-CLAUDE-11)
 * and the skip-update prompt is Codex-only (C-CODEX-12). Every non-trust union
 * and the runtime label set below are DERIVED from this table, so they cannot
 * drift from each other or from the §5.4 label contract. Adding an agent's label
 * here automatically extends both the type and the validator.
 */
const nonTrustStartupLabels = {
  claude: ["browser_tools"],
  codex: ["update"],
} as const satisfies Record<ElwoodAgentKind, readonly string[]>;

/**
 * The non-trust startup-prompt labels for one agent, derived from the table so
 * each impossible pairing (Claude + `update`, Codex + `browser_tools`) stays
 * unrepresentable, matching the §5.4 label table exactly.
 */
type NonTrustStartupLabel<A extends ElwoodAgentKind> = (typeof nonTrustStartupLabels)[A][number];

/**
 * Every startup-prompt label for one agent: its own allowlisted trust ids plus
 * its own non-trust prompts. Matches the PRD's exact per-agent label contract
 * (§5.4) so a second implementation and this type can never drift.
 */
export type StartupPromptLabelFor<A extends ElwoodAgentKind> =
  | TrustPromptIdFor<A>
  | NonTrustStartupLabel<A>;

/** Per-agent startup-prompt label sets: an agent's own trust ids plus its non-trust labels. */
const startupPromptLabelsByAgent: Readonly<Record<ElwoodAgentKind, ReadonlySet<string>>> = {
  claude: labelsFor("claude"),
  codex: labelsFor("codex"),
};

function labelsFor(agent: ElwoodAgentKind): ReadonlySet<string> {
  return new Set<string>([
    ...trustPromptAllowlist.filter((spec) => spec.agent === agent).map((spec) => spec.id),
    ...nonTrustStartupLabels[agent],
  ]);
}

/**
 * True when `value` is a startup-prompt label that belongs to `agent`. Bounds a
 * persisted `startup_prompt_write_failed` so an off-agent pairing (Claude +
 * `update`, Codex + `browser_tools`) can never round-trip (§5.4).
 */
export function isStartupPromptLabelForAgent(agent: ElwoodAgentKind, value: unknown): boolean {
  return typeof value === "string" && startupPromptLabelsByAgent[agent].has(value);
}

/**
 * The outcome of handling a startup prompt for agent `A`, discriminated so the
 * two states cannot be confused: an `answered` prompt ALWAYS carries the `input`
 * sent and is labeled with any of the agent's startup labels, while an
 * `option_pending` prompt (recognized allowlisted trust prompt whose affirmative
 * option has not rendered yet — a TRANSIENT render delay, C-CLAUDE-14) NEVER
 * carries an input and is limited to the agent's TRUST ids (a non-trust prompt
 * like `browser_tools`/`update` is never "recognized but option-pending"). Both
 * correlate the label to `A`, so an off-agent or impossible label does not compile.
 */
export type StartupPromptOutcome<A extends ElwoodAgentKind = ElwoodAgentKind> =
  | { readonly kind: "answered"; readonly prompt: StartupPromptLabelFor<A>; readonly input: string }
  | { readonly kind: "option_pending"; readonly prompt: TrustPromptIdFor<A> };

export type StartupActivityEmitter = {
  emit(event: "activity", payload: ElwoodActivityEvent): void;
};

export function activityFromStartupPrompt<A extends ElwoodAgentKind>(
  agent: A,
  elwoodSessionId: string,
  automation: StartupPromptOutcome<A>,
): ElwoodActivityEvent {
  if (automation.kind === "option_pending") {
    return {
      elwoodSessionId,
      agent,
      source: "terminal",
      kind: "attention",
      label: automation.prompt,
      text: `Recognized ${agent} ${automation.prompt} prompt; affirmative option not rendered yet, awaiting a later frame.`,
    };
  }
  return {
    elwoodSessionId,
    agent,
    source: "terminal",
    kind: "startup_prompt",
    label: automation.prompt,
    text: `Detected ${agent} ${automation.prompt} prompt; sent ${automation.input}.`,
  };
}

export function emitStartupPromptActivity<A extends ElwoodAgentKind>(
  emitter: StartupActivityEmitter,
  agent: A,
  elwoodSessionId: string,
  automation: StartupPromptOutcome<A>,
): void {
  emitter.emit("activity", activityFromStartupPrompt(agent, elwoodSessionId, automation));
}
