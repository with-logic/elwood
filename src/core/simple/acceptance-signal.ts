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

const sessionReaders = new WeakMap<object, AcceptanceSignalReader>();

/** A live adapter registers how its own submit hook echoes a pasted payload. */
export function registerAcceptanceSignal(session: object, reader: AcceptanceSignalReader): void {
  sessionReaders.set(session, reader);
}

/** The reader a live session registered, else the default. */
export function acceptanceSignal(session: object): AcceptanceSignalReader {
  return sessionReaders.get(session) ?? defaultAcceptanceSignal;
}
