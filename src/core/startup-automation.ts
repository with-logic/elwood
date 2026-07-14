/**
 * Emits activity for automated startup prompt responses.
 * Implements PRD §5.4 and C-API-18.
 */

import type { ElwoodActivityEvent, ElwoodAgentKind } from "./activity.ts";
import {
  type TrustPromptId,
  type TrustPromptIdFor,
  trustPromptAllowlist,
} from "./trust-prompts.ts";

/**
 * The non-trust startup-prompt labels correlated with their owning agent: the
 * browser-tools onboarding decline is Claude-only (C-CLAUDE-11) and the
 * skip-update prompt is Codex-only (C-CODEX-12). Combined with the per-agent
 * trust ids below, this makes each impossible pairing (Claude + `update`,
 * Codex + `browser_tools`) unrepresentable, matching the §5.4 label table exactly.
 */
type NonTrustStartupLabel<A extends ElwoodAgentKind> = A extends "claude"
  ? "browser_tools"
  : A extends "codex"
    ? "update"
    : never;

/**
 * Every startup-prompt label for one agent: its own allowlisted trust ids plus
 * its own non-trust prompts. Matches the PRD's exact per-agent label contract
 * (§5.4) so a second implementation and this type can never drift.
 */
export type StartupPromptLabelFor<A extends ElwoodAgentKind> =
  | TrustPromptIdFor<A>
  | NonTrustStartupLabel<A>;

/** The full stable startup-prompt label union across all agents (§5.4). */
export type StartupPromptLabel = TrustPromptId | "browser_tools" | "update";

/**
 * The complete set of stable startup-prompt labels (§5.4), derived from the trust
 * allowlist plus the two non-trust labels, so the persisted-warning validator and
 * this type can never drift. Used to bound a persisted `startup_prompt_write_failed`
 * label to the allowlist.
 */
const startupPromptLabels: ReadonlySet<string> = new Set<StartupPromptLabel>([
  ...trustPromptAllowlist.map((spec) => spec.id),
  "browser_tools",
  "update",
]);

/** True when `value` is one of the fixed startup-prompt labels (§5.4). */
export function isStartupPromptLabel(value: unknown): value is StartupPromptLabel {
  return typeof value === "string" && startupPromptLabels.has(value);
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
