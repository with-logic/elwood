/**
 * Emits activity for automated startup prompt responses.
 * Implements PRD §5.4 and C-API-18.
 */

import type { ElwoodActivityEvent, ElwoodAgentKind } from "./activity.ts";

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
