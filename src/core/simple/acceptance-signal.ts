/**
 * Positive acceptance of one pasted prompt from shared hook evidence, and the per-session
 * registry an adapter uses to say how its submit hook echoes that paste (PRD §5.8,
 * C-API-48, C-CLAUDE-25).
 */

import { sanitizePasteText } from "../input/sanitize.ts";
import { hasSynthesizedPrompt } from "./synthesized-prompt.ts";
import type { AcceptanceSignalReader, TurnBoundaryHook } from "./turn-types.ts";

/** Whether a submit hook's native prompt echoes the payload Elwood pasted. */
export type PasteEcho = (
  nativePrompt: string,
  payload: string,
  hookEvent: TurnBoundaryHook,
) => boolean;

/**
 * Acceptance by any Stop boundary, or by a submit hook whose native prompt `echoes` the
 * payload Elwood pasted: the caller's prompt with control characters removed (§5.3).
 */
export function createAcceptanceSignal(echoes: PasteEcho): AcceptanceSignalReader {
  return (hookEvent, prompt) =>
    hookEvent.hook_event_name === "Stop" ||
    (hookEvent.hook_event_name === "UserPromptSubmit" &&
      !hasSynthesizedPrompt(hookEvent) &&
      hookEvent.prompt !== undefined &&
      echoes(hookEvent.prompt, sanitizePasteText(prompt), hookEvent));
}

/** The default echo is the pasted payload itself. */
export const defaultAcceptanceSignal = createAcceptanceSignal(
  (nativePrompt, payload) => nativePrompt === payload,
);

const acceptanceSignalsBySession = new WeakMap<object, AcceptanceSignalReader>();

/**
 * A live adapter registers the acceptance reader built from its submit hook's paste echo. Keyed
 * on the live session so every facade over it gets the same reader from one registration; a
 * session that registers none silently uses the exact-match default.
 */
export function registerAcceptanceSignal(session: object, reader: AcceptanceSignalReader): void {
  acceptanceSignalsBySession.set(session, reader);
}

/** The reader a live session registered, else the default. */
export function registeredAcceptanceSignal(session: object): AcceptanceSignalReader {
  return acceptanceSignalsBySession.get(session) ?? defaultAcceptanceSignal;
}
