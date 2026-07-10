/**
 * Emits activity for automated startup prompt responses.
 * Implements PRD §5.4 and C-API-18.
 */

import type { ElwoodActivityEvent, ElwoodAgentKind } from "./activity.ts";
import type { ElwoodWarningEvent } from "./warnings.ts";

/**
 * The outcome of a startup-prompt automation, discriminated so the two states
 * cannot be confused: an `answered` prompt ALWAYS carries the `input` sent, while
 * an `unanswerable` prompt (recognized allowlisted trust prompt whose verified
 * option was absent — C-CLAUDE-14) NEVER carries an input. A contradictory shape
 * like `{ input: "1", unanswerable: true }` is no longer representable.
 */
export type StartupPromptAutomation =
  | { readonly kind: "answered"; readonly prompt: string; readonly input: string }
  | { readonly kind: "unanswerable"; readonly prompt: string };

export type StartupActivityEmitter = {
  emit(event: "activity", payload: ElwoodActivityEvent): void;
};

export function activityFromStartupPrompt(
  agent: ElwoodAgentKind,
  elwoodSessionId: string,
  automation: StartupPromptAutomation,
): ElwoodActivityEvent {
  if (automation.kind === "unanswerable") {
    return {
      elwoodSessionId,
      agent,
      source: "terminal",
      kind: "attention",
      label: automation.prompt,
      text: `Recognized ${agent} ${automation.prompt} prompt but no known option to answer; not auto-answered.`,
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

export function emitStartupPromptActivity(
  emitter: StartupActivityEmitter,
  agent: ElwoodAgentKind,
  elwoodSessionId: string,
  automation: StartupPromptAutomation,
): void {
  emitter.emit("activity", activityFromStartupPrompt(agent, elwoodSessionId, automation));
}

/** The session surface needed to persist an unanswerable prompt's durable warning. */
export type WedgeSink =
  | { recordWarnings(warnings: readonly ElwoodWarningEvent[]): void }
  | undefined;

/**
 * Emit each automation's activity and, for an unanswerable prompt, persist its
 * durable wedge warning through the session sink. Shared by both adapters.
 */
export function applyStartupAutomations(
  emitter: StartupActivityEmitter,
  agent: "claude" | "codex",
  elwoodSessionId: string,
  automations: readonly StartupPromptAutomation[],
  sink: () => WedgeSink,
): void {
  for (const automation of automations) {
    emitStartupPromptActivity(emitter, agent, elwoodSessionId, automation);
    const wedge = warningFromStartupPrompt(agent, elwoodSessionId, automation);
    if (wedge) sink()?.recordWarnings([wedge]);
  }
}

/**
 * A DURABLE warning for a recognized-but-unanswerable trust prompt. The transient
 * `attention` activity can fire before a subscriber attaches; persisting this
 * warning makes the wedge observable at resume time and replayable to a late
 * subscriber, so an autotrust session can't wedge with no durable evidence
 * (C-CLAUDE-14). Returns undefined for an answered prompt (nothing to persist).
 */
export function warningFromStartupPrompt(
  agent: "claude" | "codex",
  elwoodSessionId: string,
  automation: StartupPromptAutomation,
): ElwoodWarningEvent | undefined {
  if (automation.kind !== "unanswerable") return undefined;
  return {
    elwoodSessionId,
    agent,
    source: "terminal",
    code: "trust_prompt_unanswerable",
    severity: "warning",
    message: `Recognized ${agent} ${automation.prompt} prompt but no known option to answer; not auto-answered.`,
    prompt: automation.prompt,
    raw: `trust_prompt_unanswerable prompt=${automation.prompt}`,
  };
}
