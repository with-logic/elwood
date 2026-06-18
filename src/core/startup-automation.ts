/**
 * Emits activity for automated startup prompt responses.
 * Implements PRD §5.4 and C-API-18.
 */

import type { ElwoodActivityEvent, ElwoodAgentKind } from "./activity.ts";
import { activityFromStartupPrompt } from "./activity.ts";

export type StartupPromptAutomation = {
  readonly prompt: string;
  readonly input: string;
};

export type StartupActivityEmitter = {
  emit(event: "activity", payload: ElwoodActivityEvent): void;
};

export function emitStartupPromptActivity(
  emitter: StartupActivityEmitter,
  agent: ElwoodAgentKind,
  elwoodSessionId: string,
  automation: StartupPromptAutomation,
): void {
  emitter.emit(
    "activity",
    activityFromStartupPrompt(agent, elwoodSessionId, automation.prompt, automation.input),
  );
}
