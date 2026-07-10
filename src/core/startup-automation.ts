/**
 * Emits activity for automated startup prompt responses.
 * Implements PRD §5.4 and C-API-18.
 */

import type { ElwoodActivityEvent, ElwoodAgentKind } from "./activity.ts";

export type StartupPromptAutomation = {
  readonly prompt: string;
  readonly input: string;
  /**
   * True when Elwood RECOGNIZED an allowlisted trust prompt but could not find
   * its verified affirmative option in the frame, so it did not answer. This
   * surfaces as `attention` (the session needs a human / an updated allowlist)
   * rather than a normal answered `startup_prompt`, so the agent never wedges
   * silently (C-CLAUDE-14).
   */
  readonly unanswerable?: boolean;
};

export type StartupActivityEmitter = {
  emit(event: "activity", payload: ElwoodActivityEvent): void;
};

export function activityFromStartupPrompt(
  agent: ElwoodAgentKind,
  elwoodSessionId: string,
  automation: StartupPromptAutomation,
): ElwoodActivityEvent {
  if (automation.unanswerable) {
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
